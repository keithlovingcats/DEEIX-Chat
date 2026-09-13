package globalchat

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	appglobalchat "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/globalchat"
	domainglobalchat "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/globalchat"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/filecontent"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

// streamHeartbeatInterval 是 NDJSON 长连接心跳间隔，
// 用于穿透反向代理的空闲超时断连。
const streamHeartbeatInterval = 30 * time.Second

// Handler 封装全服聊天 HTTP 处理。
type Handler struct {
	service *appglobalchat.Service
}

// NewHandler 创建全服聊天处理器。
func NewHandler(service *appglobalchat.Service) *Handler {
	return &Handler{service: service}
}

// ListMessages godoc
// @Summary 获取全服聊天消息
// @Description 分页获取全服聊天历史消息；不带 before_id 时返回最新一页，带 before_id 时向上加载更早消息
// @Tags global-chat
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param before_id query int false "游标：当前最早消息的自增 ID"
// @Param limit query int false "每页数量（默认 50，最大 200）"
// @Success 200 {object} GlobalChatMessageListResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /global-chat/messages [get]
func (h *Handler) ListMessages(c *gin.Context) {
	limit := 0
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	var (
		items   []domainglobalchat.Message
		hasMore bool
		err     error
	)
	if raw := strings.TrimSpace(c.Query("before_id")); raw != "" {
		beforeID, parseErr := strconv.ParseUint(raw, 10, strconv.IntSize)
		if parseErr != nil || beforeID == 0 {
			response.InvalidQueryParam(c, "before_id")
			return
		}
		items, hasMore, err = h.service.ListBeforeID(c.Request.Context(), uint(beforeID), limit)
	} else {
		items, hasMore, err = h.service.ListRecent(c.Request.Context(), limit)
	}
	if err != nil {
		writeError(c, err)
		return
	}
	response.Success(c, GlobalChatMessageListData{
		Messages: toMessageResponses(items),
		HasMore:  hasMore,
	})
}

// SendMessage godoc
// @Summary 发送全服聊天消息
// @Description 发送文本（含 Emoji）或图片消息；图片通过 fileId 引用当前用户以 global-chat 用途上传的文件
// @Tags global-chat
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param body body GlobalChatSendMessageRequest true "消息内容"
// @Success 200 {object} GlobalChatMessageResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /global-chat/messages [post]
func (h *Handler) SendMessage(c *gin.Context) {
	var req GlobalChatSendMessageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	userID := middleware.MustUserID(c)
	var (
		item *domainglobalchat.Message
		err  error
	)
	if req.MessageType == domainglobalchat.MessageTypeImage {
		item, err = h.service.SendImage(c.Request.Context(), userID, req.SessionID, req.DeviceID, req.FileID)
	} else {
		item, err = h.service.SendText(c.Request.Context(), userID, req.SessionID, req.DeviceID, req.Content)
	}
	if err != nil {
		writeError(c, err)
		return
	}
	response.Success(c, GlobalChatMessageDataResponse{Message: toMessageResponse(*item)})
}

// Stream godoc
// @Summary 订阅全服聊天实时流
// @Description NDJSON 长连接，实时推送新消息、删除事件、在线人数与心跳；带 after_id 时先回放断线期间的消息并补发窗口内的删除事件（回放或删除补发超限、回放失败会下发 resync 事件）
// @Tags global-chat
// @Produce application/x-ndjson
// @Security BearerAuth
// @Param after_id query int false "已接收的最后消息自增 ID（断线重连补全）"
// @Success 200 {string} string "NDJSON stream"
// @Failure 503 {object} ErrorDoc
// @Router /global-chat/stream [get]
func (h *Handler) Stream(c *gin.Context) {
	afterID, _ := strconv.ParseUint(strings.TrimSpace(c.Query("after_id")), 10, strconv.IntSize)
	events, ok, unsubscribe := h.service.Hub().Subscribe(middleware.MustUserID(c))
	if !ok {
		response.ErrorWithCode(c, http.StatusServiceUnavailable, response.CodeServiceUnavailable)
		return
	}
	defer unsubscribe()

	c.Header("Content-Type", "application/x-ndjson; charset=utf-8")
	c.Header("Cache-Control", "no-cache, no-transform")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)

	writeEvent := func(payload map[string]any) bool {
		encoded, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			return true
		}
		if _, writeErr := c.Writer.Write(append(encoded, '\n')); writeErr != nil {
			return false
		}
		c.Writer.Flush()
		return true
	}

	// 下发 resync：客户端数据不完整时整体重拉的信号（返回 false 表示连接已断）。
	writeResync := func(reason string) bool {
		return writeEvent(map[string]any{
			"type": appglobalchat.EventResync,
			"data": map[string]any{"reason": reason},
		})
	}

	// 回放断线窗口（先订阅后回放，保证不丢不重；重复由前端按 id 去重）。
	// 任一 resync 分支即终止回放阶段：后续事件只会随整体重拉作废，不再下发。
	if afterID > 0 {
		replay, hasMore, err := h.service.ListAfterID(c.Request.Context(), uint(afterID))
		switch {
		case err != nil:
			// 回放失败意味着客户端数据不完整，下发 resync 让前端整体重拉，
			// 而非静默吞错等下一轮重连。
			if !writeResync("replay_failed") {
				return
			}
		case hasMore:
			// 回放超限同样整体重拉：注定作废的回放消息与删除补发无需先发。
			if !writeResync("replay_limit") {
				return
			}
		default:
			for _, item := range replay {
				if !writeEvent(streamMessagePayload(item)) {
					return
				}
			}
			// 补发断线窗口内的删除事件：断线期间管理员删除的消息若不补发，
			// 重连的客户端会一直显示已删消息（软删除消息不会出现在回放结果里）。
			deletedIDs, delHasMore, delErr := h.service.ListDeletionsSince(c.Request.Context(), uint(afterID))
			switch {
			case delErr != nil:
				// 删除补发失败（含锚点消息不存在）：同样整体重拉，reason 与
				// 回放失败区分开便于排查。
				if !writeResync("deletion_replay_failed") {
					return
				}
			case delHasMore:
				// 窗口内删除数量达到补发上限：逐条下发代价过高，整体重拉。
				if !writeResync("deletion_replay_limit") {
					return
				}
			default:
				for _, id := range deletedIDs {
					if !writeEvent(map[string]any{
						"type": appglobalchat.EventMessageDeleted,
						"data": map[string]any{"id": id},
					}) {
						return
					}
				}
			}
		}
	}

	heartbeat := time.NewTicker(streamHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case <-heartbeat.C:
			if !writeEvent(map[string]any{
				"type": appglobalchat.EventHeartbeat,
				"data": map[string]any{"ts": time.Now().Unix()},
			}) {
				return
			}
		case event, ok := <-events:
			if !ok {
				return
			}
			if !writeEvent(streamEventPayload(event)) {
				return
			}
		}
	}
}

// GetOnlineCount godoc
// @Summary 获取全服聊天在线人数
// @Description 返回当前进程内的去重在线用户数
// @Tags global-chat
// @Accept json
// @Produce json
// @Security BearerAuth
// @Success 200 {object} GlobalChatOnlineCountResponseDoc
// @Failure 500 {object} ErrorDoc
// @Router /global-chat/online-count [get]
func (h *Handler) GetOnlineCount(c *gin.Context) {
	response.Success(c, GlobalChatOnlineCountDataResponse{Count: h.service.Hub().OnlineCount()})
}

// GetImageContent godoc
// @Summary 获取全服聊天图片
// @Description 读取全服聊天共享图片内容；purpose 为 global-chat 的文件对所有登录用户可见
// @Tags global-chat
// @Produce application/octet-stream
// @Security BearerAuth
// @Param file_id path string true "文件 ID"
// @Success 200 {file} file "图片内容"
// @Failure 404 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /global-chat/files/{file_id}/content [get]
func (h *Handler) GetImageContent(c *gin.Context) {
	fileID := strings.TrimSpace(c.Param("file_id"))
	if fileID == "" {
		response.ErrorWithCode(c, http.StatusBadRequest, response.CodeRequestInvalidID)
		return
	}
	result, err := h.service.OpenImageContent(c.Request.Context(), fileID)
	if err != nil {
		writeError(c, err)
		return
	}
	if err := filecontent.Write(c, result, false); err != nil {
		return
	}
}

// DeleteMessage godoc
// @Summary 管理员删除全服聊天消息
// @Description 软删除指定消息并向在线客户端广播删除事件
// @Tags admin-global-chat
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path int true "消息自增 ID"
// @Success 200 {object} GlobalChatMessageDeleteResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 404 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /admin/global-chat/messages/{id} [delete]
func (h *Handler) DeleteMessage(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, strconv.IntSize)
	if err != nil || id == 0 {
		response.ErrorWithCode(c, http.StatusBadRequest, response.CodeRequestInvalidID)
		return
	}
	if err := h.service.DeleteMessage(c.Request.Context(), uint(id)); err != nil {
		writeError(c, err)
		return
	}
	response.Success(c, GlobalChatMessageDeleteDataResponse{Deleted: true})
}

// BatchDeleteMessages godoc
// @Summary 管理员批量删除全服聊天消息
// @Description 软删除最多 100 条消息并向在线客户端逐条广播删除事件
// @Tags admin-global-chat
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param body body BatchDeleteGlobalChatMessagesRequest true "消息 ID 列表"
// @Success 200 {object} GlobalChatMessagesBatchDeleteResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /admin/global-chat/messages/batch-delete [post]
func (h *Handler) BatchDeleteMessages(c *gin.Context) {
	var req BatchDeleteGlobalChatMessagesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	deleted, err := h.service.DeleteMessages(c.Request.Context(), req.IDs)
	if err != nil {
		writeError(c, err)
		return
	}
	response.Success(c, GlobalChatMessagesBatchDeleteDataResponse{Deleted: deleted})
}

func streamMessagePayload(item domainglobalchat.Message) map[string]any {
	return map[string]any{
		"type": appglobalchat.EventMessage,
		"data": toMessageResponse(item),
	}
}

func streamEventPayload(event appglobalchat.HubEvent) map[string]any {
	if event.Type == appglobalchat.EventMessage {
		if item, ok := event.Data.(*domainglobalchat.Message); ok && item != nil {
			return streamMessagePayload(*item)
		}
	}
	return map[string]any{"type": event.Type, "data": event.Data}
}

func writeError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, appglobalchat.ErrInvalidMessage):
		response.ErrorFrom(c, http.StatusBadRequest, err)
	case errors.Is(err, appglobalchat.ErrImageFileInvalid):
		response.ErrorFrom(c, http.StatusBadRequest, err)
	case errors.Is(err, appglobalchat.ErrMessageNotFound), errors.Is(err, appglobalchat.ErrImageFileNotFound):
		response.ErrorWithCode(c, http.StatusNotFound, response.CodeResourceNotFound)
	default:
		response.InternalError(c)
	}
}

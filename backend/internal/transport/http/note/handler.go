package note

import (
	"errors"
	"net/http"
	"strconv"

	appnote "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/note"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

// Handler 封装笔记 HTTP 处理。
type Handler struct {
	service *appnote.Service
}

// NewHandler 创建笔记处理器。
func NewHandler(service *appnote.Service) *Handler {
	return &Handler{service: service}
}

// ListNotes godoc
// @Summary 查询我的笔记
// @Description 分页返回当前用户笔记，支持标题+内容搜索与排序
// @Tags notes
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param q query string false "搜索关键词（标题+内容）"
// @Param sort query string false "排序：updated_desc（默认）/ created_desc / title_asc" Enums(updated_desc,created_desc,title_asc)
// @Param page query int false "页码"
// @Param page_size query int false "每页数量"
// @Success 200 {object} NotePageResponseDoc
// @Failure 500 {object} ErrorDoc
// @Router /notes [get]
func (h *Handler) ListNotes(c *gin.Context) {
	page, pageSize := pageParams(c)
	items, total, err := h.service.List(c.Request.Context(), middleware.MustUserID(c), appnote.ListInput{
		Query:    c.Query("q"),
		Sort:     c.Query("sort"),
		Page:     page,
		PageSize: pageSize,
	})
	if err != nil {
		writeNoteError(c, err)
		return
	}
	response.SuccessPage(c, total, toNoteResponses(items))
}

// CreateNote godoc
// @Summary 创建笔记
// @Tags notes
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param body body CreateNoteRequest true "笔记内容"
// @Success 200 {object} NoteResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /notes [post]
func (h *Handler) CreateNote(c *gin.Context) {
	var req CreateNoteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	item, err := h.service.Create(c.Request.Context(), middleware.MustUserID(c), appnote.WriteInput{
		Title:   req.Title,
		Content: req.Content,
	})
	if err != nil {
		writeNoteError(c, err)
		return
	}
	response.Success(c, NoteDataResponse{Note: toNoteResponse(*item)})
}

// GetNote godoc
// @Summary 查询笔记详情
// @Tags notes
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path int true "笔记ID"
// @Success 200 {object} NoteResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 404 {object} ErrorDoc
// @Router /notes/{id} [get]
func (h *Handler) GetNote(c *gin.Context) {
	id, ok := idParam(c)
	if !ok {
		return
	}
	item, err := h.service.Get(c.Request.Context(), middleware.MustUserID(c), id)
	if err != nil {
		writeNoteError(c, err)
		return
	}
	response.Success(c, NoteDataResponse{Note: toNoteResponse(*item)})
}

// PatchNote godoc
// @Summary 更新笔记
// @Description 部分更新标题或内容，字段为空时保持不变
// @Tags notes
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path int true "笔记ID"
// @Param body body PatchNoteRequest true "更新字段"
// @Success 200 {object} NoteResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 404 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /notes/{id} [patch]
func (h *Handler) PatchNote(c *gin.Context) {
	id, ok := idParam(c)
	if !ok {
		return
	}
	var req PatchNoteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	item, err := h.service.Update(c.Request.Context(), middleware.MustUserID(c), id, appnote.PatchInput{
		Title:   req.Title,
		Content: req.Content,
	})
	if err != nil {
		writeNoteError(c, err)
		return
	}
	response.Success(c, NoteDataResponse{Note: toNoteResponse(*item)})
}

// DeleteNote godoc
// @Summary 删除笔记
// @Tags notes
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path int true "笔记ID"
// @Success 200 {object} NoteDeleteResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 404 {object} ErrorDoc
// @Router /notes/{id} [delete]
func (h *Handler) DeleteNote(c *gin.Context) {
	id, ok := idParam(c)
	if !ok {
		return
	}
	if err := h.service.Delete(c.Request.Context(), middleware.MustUserID(c), id); err != nil {
		writeNoteError(c, err)
		return
	}
	response.Success(c, NoteDeleteDataResponse{Deleted: true})
}

func pageParams(c *gin.Context) (int, int) {
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page <= 0 {
		page = 1
	}
	pageSize, err := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	if err != nil || pageSize <= 0 {
		pageSize = 20
	}
	const maxPageSize = 100
	if pageSize > maxPageSize {
		pageSize = maxPageSize
	}
	return page, pageSize
}

func idParam(c *gin.Context) (uint, bool) {
	parsed, err := strconv.ParseUint(c.Param("id"), 10, strconv.IntSize)
	if err != nil || parsed == 0 {
		response.Error(c, http.StatusBadRequest, "invalid note id")
		return 0, false
	}
	return uint(parsed), true
}

func writeNoteError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, appnote.ErrNoteNotFound):
		response.Error(c, http.StatusNotFound, "note not found")
	case errors.Is(err, appnote.ErrInvalidNote):
		response.Error(c, http.StatusBadRequest, "invalid note")
	default:
		response.Error(c, http.StatusInternalServerError, "note operation failed")
	}
}

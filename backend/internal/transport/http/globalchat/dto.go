package globalchat

import (
	"time"

	domainglobalchat "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/globalchat"
)

// ErrorDoc 用于 Swagger 标注通用错误响应。
type ErrorDoc struct {
	ErrorMsg  string      `json:"errorMsg" example:"invalid request"`
	ErrorCode string      `json:"errorCode,omitempty" example:"invalid_request"`
	Details   interface{} `json:"details,omitempty"`
	RequestID string      `json:"requestId,omitempty" example:""`
	Data      interface{} `json:"data"`
}

// GlobalChatMessageResponse 面向前端的全服聊天消息。
type GlobalChatMessageResponse struct {
	ID          uint      `json:"id"`
	PublicID    string    `json:"publicId"`
	UserID      uint      `json:"userId"`
	Username    string    `json:"username"`
	DisplayName string    `json:"displayName"`
	AvatarURL   string    `json:"avatarUrl"`
	MessageType string    `json:"messageType"`
	Content     string    `json:"content"`
	ImageFileID string    `json:"imageFileId"`
	CreatedAt   time.Time `json:"createdAt"`
}

// SendMessageRequest 发送消息请求。文本消息携带 content，图片消息携带 fileId。
type SendMessageRequest struct {
	MessageType string `json:"messageType" binding:"required,oneof=text image"`
	Content     string `json:"content,omitempty" binding:"omitempty,max=2000"`
	FileID      string `json:"fileId,omitempty" binding:"omitempty,max=64"`
}

// GlobalChatMessageListData 消息列表响应数据。
type GlobalChatMessageListData struct {
	Messages []GlobalChatMessageResponse `json:"messages"`
	HasMore  bool                        `json:"hasMore"`
}

// GlobalChatMessageListResponseDoc 消息列表响应文档。
type GlobalChatMessageListResponseDoc struct {
	ErrorMsg string                     `json:"errorMsg"`
	Data     GlobalChatMessageListData  `json:"data"`
}

// GlobalChatMessageDataResponse 发送消息响应。
type GlobalChatMessageDataResponse struct {
	Message GlobalChatMessageResponse `json:"message"`
}

// GlobalChatMessageResponseDoc 发送消息响应文档。
type GlobalChatMessageResponseDoc struct {
	ErrorMsg string                       `json:"errorMsg"`
	Data     GlobalChatMessageDataResponse `json:"data"`
}

// GlobalChatOnlineCountDataResponse 在线人数响应。
type GlobalChatOnlineCountDataResponse struct {
	Count int `json:"count"`
}

// GlobalChatOnlineCountResponseDoc 在线人数响应文档。
type GlobalChatOnlineCountResponseDoc struct {
	ErrorMsg string                           `json:"errorMsg"`
	Data     GlobalChatOnlineCountDataResponse `json:"data"`
}

// GlobalChatMessageDeleteDataResponse 删除消息响应。
type GlobalChatMessageDeleteDataResponse struct {
	Deleted bool `json:"deleted"`
}

// GlobalChatMessageDeleteResponseDoc 删除消息响应文档。
type GlobalChatMessageDeleteResponseDoc struct {
	ErrorMsg string                             `json:"errorMsg"`
	Data     GlobalChatMessageDeleteDataResponse `json:"data"`
}

func toMessageResponse(item domainglobalchat.Message) GlobalChatMessageResponse {
	return GlobalChatMessageResponse{
		ID:          item.ID,
		PublicID:    item.PublicID,
		UserID:      item.UserID,
		Username:    item.Username,
		DisplayName: item.DisplayName,
		AvatarURL:   item.AvatarURL,
		MessageType: item.MessageType,
		Content:     item.Content,
		ImageFileID: item.ImageFileID,
		CreatedAt:   item.CreatedAt,
	}
}

func toMessageResponses(items []domainglobalchat.Message) []GlobalChatMessageResponse {
	results := make([]GlobalChatMessageResponse, 0, len(items))
	for _, item := range items {
		results = append(results, toMessageResponse(item))
	}
	return results
}

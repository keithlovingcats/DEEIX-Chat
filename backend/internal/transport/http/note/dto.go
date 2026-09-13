package note

import (
	"time"

	domainnote "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/note"
)

// NoteResponse 表示笔记响应。
type NoteResponse struct {
	ID        uint      `json:"id"`
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// NoteDataResponse 包裹单条笔记响应。
type NoteDataResponse struct {
	Note NoteResponse `json:"note"`
}

// NoteDeleteDataResponse 表示删除响应。
type NoteDeleteDataResponse struct {
	Deleted bool `json:"deleted"`
}

// CreateNoteRequest 表示创建笔记请求。
type CreateNoteRequest struct {
	Title   string `json:"title" binding:"required,max=200"`
	Content string `json:"content,omitempty" binding:"max=100000"`
}

// PatchNoteRequest 表示更新笔记请求。
type PatchNoteRequest struct {
	Title   *string `json:"title,omitempty" binding:"omitempty,max=200"`
	Content *string `json:"content,omitempty" binding:"omitempty,max=100000"`
}

// NotePageResponseDoc 用于 Swagger 展示笔记分页响应。
type NotePageResponseDoc struct {
	ErrorMsg string `json:"errorMsg"`
	Data     struct {
		Total   int64          `json:"total"`
		Results []NoteResponse `json:"results"`
	} `json:"data"`
}

// NoteResponseDoc 用于 Swagger 展示单条响应。
type NoteResponseDoc struct {
	ErrorMsg string           `json:"errorMsg"`
	Data     NoteDataResponse `json:"data"`
}

// NoteDeleteResponseDoc 用于 Swagger 展示删除响应。
type NoteDeleteResponseDoc struct {
	ErrorMsg string                 `json:"errorMsg"`
	Data     NoteDeleteDataResponse `json:"data"`
}

// ErrorDoc 表示错误响应。
type ErrorDoc struct {
	ErrorMsg string `json:"errorMsg"`
}

func toNoteResponses(items []domainnote.Note) []NoteResponse {
	results := make([]NoteResponse, 0, len(items))
	for _, item := range items {
		results = append(results, toNoteResponse(item))
	}
	return results
}

func toNoteResponse(item domainnote.Note) NoteResponse {
	return NoteResponse{
		ID:        item.ID,
		Title:     item.Title,
		Content:   item.Content,
		CreatedAt: item.CreatedAt,
		UpdatedAt: item.UpdatedAt,
	}
}

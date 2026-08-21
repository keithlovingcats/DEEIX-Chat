package repository

import (
	"context"

	domainnote "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/note"
)

// NoteRepository 定义笔记持久化能力；所有操作均以 UserID 限定归属。
type NoteRepository interface {
	ListNotes(ctx context.Context, filter NoteListFilter, offset int, limit int) ([]domainnote.Note, int64, error)
	GetNote(ctx context.Context, userID uint, id uint) (*domainnote.Note, error)
	CreateNote(ctx context.Context, item *domainnote.Note) (*domainnote.Note, error)
	PatchNote(ctx context.Context, userID uint, id uint, patch NotePatch) (*domainnote.Note, error)
	DeleteNote(ctx context.Context, userID uint, id uint) error
}

// NoteListFilter 描述笔记列表筛选条件。
type NoteListFilter struct {
	// UserID 必填，笔记按用户隔离。
	UserID uint
	// Query 标题+内容不区分大小写包含搜索。
	Query string
	// Sort 排序方式：updated_desc（默认）/ created_desc / title_asc。
	Sort string
}

// NotePatch 描述可更新的笔记字段，指针为 nil 表示不更新。
type NotePatch struct {
	Title   *string
	Content *string
}

package note

import (
	"context"
	"errors"
	"strings"

	domainnote "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/note"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

const (
	maxNoteTitleLength   = 200
	maxNoteContentLength = 100000
)

// Service 封装笔记业务逻辑。
type Service struct {
	repo repository.NoteRepository
}

// NewService 创建笔记服务。
func NewService(repo repository.NoteRepository) *Service {
	return &Service{repo: repo}
}

// ListInput 定义笔记列表入参。
type ListInput struct {
	Query    string
	Sort     string
	Page     int
	PageSize int
}

// WriteInput 定义笔记创建入参。
type WriteInput struct {
	Title   string
	Content string
}

// PatchInput 定义笔记更新入参。
type PatchInput struct {
	Title   *string
	Content *string
}

// List 查询当前用户笔记。
func (s *Service) List(ctx context.Context, userID uint, input ListInput) ([]domainnote.Note, int64, error) {
	if userID == 0 {
		return nil, 0, ErrInvalidNote
	}
	page, pageSize := normalizePage(input.Page, input.PageSize)
	return s.repo.ListNotes(ctx, repository.NoteListFilter{
		UserID: userID,
		Query:  strings.TrimSpace(input.Query),
		Sort:   normalizeSort(input.Sort),
	}, (page-1)*pageSize, pageSize)
}

// Get 查询单条笔记（仅本人）。
func (s *Service) Get(ctx context.Context, userID uint, id uint) (*domainnote.Note, error) {
	if userID == 0 || id == 0 {
		return nil, ErrInvalidNote
	}
	item, err := s.repo.GetNote(ctx, userID, id)
	if err != nil {
		return nil, mapRepositoryError(err)
	}
	return item, nil
}

// Create 创建笔记。
func (s *Service) Create(ctx context.Context, userID uint, input WriteInput) (*domainnote.Note, error) {
	if userID == 0 {
		return nil, ErrInvalidNote
	}
	title, content, err := normalizeFields(input)
	if err != nil {
		return nil, err
	}
	return s.create(ctx, &domainnote.Note{
		UserID:  userID,
		Title:   title,
		Content: content,
	})
}

// Update 更新笔记（仅本人，部分更新）。
func (s *Service) Update(ctx context.Context, userID uint, id uint, input PatchInput) (*domainnote.Note, error) {
	if userID == 0 || id == 0 {
		return nil, ErrInvalidNote
	}
	patch, err := normalizePatchInput(input)
	if err != nil {
		return nil, err
	}
	item, err := s.repo.PatchNote(ctx, userID, id, patch)
	if err != nil {
		return nil, mapRepositoryError(err)
	}
	return item, nil
}

// Delete 删除笔记（仅本人）。
func (s *Service) Delete(ctx context.Context, userID uint, id uint) error {
	if userID == 0 || id == 0 {
		return ErrInvalidNote
	}
	return mapRepositoryError(s.repo.DeleteNote(ctx, userID, id))
}

func (s *Service) create(ctx context.Context, item *domainnote.Note) (*domainnote.Note, error) {
	result, err := s.repo.CreateNote(ctx, item)
	if err != nil {
		return nil, mapRepositoryError(err)
	}
	return result, nil
}

func normalizeFields(input WriteInput) (string, string, error) {
	title := strings.TrimSpace(input.Title)
	content := strings.TrimSpace(input.Content)
	if title == "" || runeCount(title) > maxNoteTitleLength {
		return "", "", ErrInvalidNote
	}
	if runeCount(content) > maxNoteContentLength {
		return "", "", ErrInvalidNote
	}
	return title, content, nil
}

func normalizePatchInput(input PatchInput) (repository.NotePatch, error) {
	patch := repository.NotePatch{}
	if input.Title != nil {
		title := strings.TrimSpace(*input.Title)
		if title == "" || runeCount(title) > maxNoteTitleLength {
			return repository.NotePatch{}, ErrInvalidNote
		}
		patch.Title = &title
	}
	if input.Content != nil {
		content := strings.TrimSpace(*input.Content)
		if runeCount(content) > maxNoteContentLength {
			return repository.NotePatch{}, ErrInvalidNote
		}
		patch.Content = &content
	}
	return patch, nil
}

func normalizeSort(raw string) string {
	switch strings.TrimSpace(raw) {
	case "created_desc", "title_asc":
		return strings.TrimSpace(raw)
	default:
		return "updated_desc"
	}
}

func runeCount(value string) int {
	return len([]rune(value))
}

func normalizePage(page int, pageSize int) (int, int) {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	const maxPageSize = 100
	if pageSize > maxPageSize {
		pageSize = maxPageSize
	}
	return page, pageSize
}

func mapRepositoryError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, repository.ErrNotFound) {
		return ErrNoteNotFound
	}
	if errors.Is(err, repository.ErrInvalidInput) {
		return ErrInvalidNote
	}
	return err
}

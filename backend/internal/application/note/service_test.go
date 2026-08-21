package note

import (
	"context"
	"errors"
	"strings"
	"testing"

	domainnote "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/note"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type fakeNoteRepo struct {
	items     map[uint]domainnote.Note
	next      uint
	lastPatch repository.NotePatch
	listCalls []repository.NoteListFilter
}

func (r *fakeNoteRepo) ListNotes(_ context.Context, filter repository.NoteListFilter, offset int, limit int) ([]domainnote.Note, int64, error) {
	r.listCalls = append(r.listCalls, filter)
	if filter.UserID == 0 {
		return nil, 0, repository.ErrInvalidInput
	}
	results := make([]domainnote.Note, 0)
	for _, item := range r.items {
		if item.UserID != filter.UserID {
			continue
		}
		results = append(results, item)
	}
	total := int64(len(results))
	if offset < len(results) {
		end := offset + limit
		if end > len(results) {
			end = len(results)
		}
		results = results[offset:end]
	} else {
		results = []domainnote.Note{}
	}
	return results, total, nil
}

func (r *fakeNoteRepo) GetNote(_ context.Context, userID uint, id uint) (*domainnote.Note, error) {
	item, ok := r.items[id]
	if !ok || item.UserID != userID {
		return nil, repository.ErrNotFound
	}
	return &item, nil
}

func (r *fakeNoteRepo) CreateNote(_ context.Context, item *domainnote.Note) (*domainnote.Note, error) {
	if r.next == 0 {
		r.next = 1
	}
	item.ID = r.next
	r.next++
	r.items[item.ID] = *item
	result := r.items[item.ID]
	return &result, nil
}

func (r *fakeNoteRepo) PatchNote(_ context.Context, userID uint, id uint, patch repository.NotePatch) (*domainnote.Note, error) {
	item, ok := r.items[id]
	if !ok || item.UserID != userID {
		return nil, repository.ErrNotFound
	}
	r.lastPatch = patch
	if patch.Title != nil {
		item.Title = *patch.Title
	}
	if patch.Content != nil {
		item.Content = *patch.Content
	}
	r.items[id] = item
	return &item, nil
}

func (r *fakeNoteRepo) DeleteNote(_ context.Context, userID uint, id uint) error {
	item, ok := r.items[id]
	if !ok || item.UserID != userID {
		return repository.ErrNotFound
	}
	delete(r.items, id)
	return nil
}

func newFakeNoteRepo() *fakeNoteRepo {
	return &fakeNoteRepo{items: map[uint]domainnote.Note{}}
}

func TestCreateNoteValidatesTitle(t *testing.T) {
	service := NewService(newFakeNoteRepo())
	cases := []struct {
		name  string
		title string
	}{
		{name: "empty title", title: "   "},
		{name: "title too long", title: strings.Repeat("标", maxNoteTitleLength+1)},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			_, err := service.Create(context.Background(), 7, WriteInput{Title: tt.title, Content: "x"})
			if !errors.Is(err, ErrInvalidNote) {
				t.Fatalf("expected ErrInvalidNote, got %v", err)
			}
		})
	}
}

func TestCreateNoteValidatesContentLength(t *testing.T) {
	service := NewService(newFakeNoteRepo())
	_, err := service.Create(context.Background(), 7, WriteInput{
		Title:   "ok",
		Content: strings.Repeat("a", maxNoteContentLength+1),
	})
	if !errors.Is(err, ErrInvalidNote) {
		t.Fatalf("expected ErrInvalidNote, got %v", err)
	}
}

func TestCreateNoteRequiresUserID(t *testing.T) {
	service := NewService(newFakeNoteRepo())
	if _, err := service.Create(context.Background(), 0, WriteInput{Title: "t"}); !errors.Is(err, ErrInvalidNote) {
		t.Fatalf("expected ErrInvalidNote, got %v", err)
	}
}

func TestCreateNoteTrimsAndStores(t *testing.T) {
	repo := newFakeNoteRepo()
	service := NewService(repo)
	item, err := service.Create(context.Background(), 9, WriteInput{Title: "  标题  ", Content: " 内容 "})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if item.Title != "标题" || item.Content != "内容" {
		t.Fatalf("stored = (%q, %q), want trimmed values", item.Title, item.Content)
	}
	if item.UserID != 9 {
		t.Fatalf("stored UserID = %d, want 9", item.UserID)
	}
}

func TestUpdatePatchPointerSemantics(t *testing.T) {
	repo := newFakeNoteRepo()
	service := NewService(repo)
	created, err := service.Create(context.Background(), 5, WriteInput{Title: "旧标题", Content: "旧内容"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	// 仅更新内容，标题指针为 nil 不应触发校验或覆盖。
	newContent := "新内容"
	updated, err := service.Update(context.Background(), 5, created.ID, PatchInput{Content: &newContent})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated.Title != "旧标题" {
		t.Fatalf("title = %q, want untouched", updated.Title)
	}
	if updated.Content != "新内容" {
		t.Fatalf("content = %q, want updated", updated.Content)
	}
	if repo.lastPatch.Title != nil {
		t.Fatal("patch title should stay nil when not provided")
	}
}

func TestUpdateRejectsEmptyTitle(t *testing.T) {
	repo := newFakeNoteRepo()
	service := NewService(repo)
	created, _ := service.Create(context.Background(), 5, WriteInput{Title: "t", Content: "c"})
	empty := "  "
	if _, err := service.Update(context.Background(), 5, created.ID, PatchInput{Title: &empty}); !errors.Is(err, ErrInvalidNote) {
		t.Fatalf("expected ErrInvalidNote, got %v", err)
	}
}

func TestGetDeleteScopedByUser(t *testing.T) {
	repo := newFakeNoteRepo()
	service := NewService(repo)
	created, _ := service.Create(context.Background(), 1, WriteInput{Title: "mine", Content: "c"})

	// 其他用户访问 -> not found（user_id 隔离）。
	if _, err := service.Get(context.Background(), 2, created.ID); !errors.Is(err, ErrNoteNotFound) {
		t.Fatalf("expected ErrNoteNotFound, got %v", err)
	}
	if err := service.Delete(context.Background(), 2, created.ID); !errors.Is(err, ErrNoteNotFound) {
		t.Fatalf("expected ErrNoteNotFound on cross-user delete, got %v", err)
	}

	if _, err := service.Get(context.Background(), 1, created.ID); err != nil {
		t.Fatalf("owner Get() error = %v", err)
	}
	if err := service.Delete(context.Background(), 1, created.ID); err != nil {
		t.Fatalf("owner Delete() error = %v", err)
	}
	if _, err := service.Get(context.Background(), 1, created.ID); !errors.Is(err, ErrNoteNotFound) {
		t.Fatalf("expected ErrNoteNotFound after delete, got %v", err)
	}
}

func TestListNormalizesSortAndPage(t *testing.T) {
	repo := newFakeNoteRepo()
	service := NewService(repo)
	_, _, err := service.List(context.Background(), 3, ListInput{Sort: "random", Page: -1, PageSize: 9999})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(repo.listCalls) != 1 {
		t.Fatalf("expected 1 list call, got %d", len(repo.listCalls))
	}
	filter := repo.listCalls[0]
	if filter.Sort != "updated_desc" {
		t.Fatalf("sort = %q, want normalized updated_desc", filter.Sort)
	}
	if filter.UserID != 3 {
		t.Fatalf("filter user = %d, want 3", filter.UserID)
	}
}

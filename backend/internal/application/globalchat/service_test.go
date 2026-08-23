package globalchat

import (
	"context"
	"errors"
	"strings"
	"testing"

	domainglobalchat "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/globalchat"
	domainuser "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/user"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

func newTestService(repo *fakeRepo) (*Service, *Hub) {
	hub := NewHub(nil)
	return NewService(repo, hub, &fakeUserRepo{user: domainuser.User{ID: 7, Username: "alice", DisplayName: "Alice"}}, nil), hub
}

func TestSendTextValidation(t *testing.T) {
	service, _ := newTestService(&fakeRepo{})
	if _, err := service.SendText(context.Background(), 0, "hi"); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("SendText() with zero user error = %v, want ErrInvalidMessage", err)
	}
	if _, err := service.SendText(context.Background(), 7, "   "); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("SendText() blank content error = %v, want ErrInvalidMessage", err)
	}
	if _, err := service.SendText(context.Background(), 7, strings.Repeat("字", maxTextContentLength+1)); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("SendText() oversized content error = %v, want ErrInvalidMessage", err)
	}
}

func TestSendTextSnapshotsUserAndBroadcasts(t *testing.T) {
	repo := &fakeRepo{}
	service, hub := newTestService(repo)
	events, _, cancel := hub.Subscribe(42)
	defer cancel()

	item, err := service.SendText(context.Background(), 7, "大家好 😀")
	if err != nil {
		t.Fatalf("SendText() error = %v", err)
	}
	if item.Username != "alice" || item.DisplayName != "Alice" {
		t.Fatalf("SendText() snapshot = %q/%q, want alice/Alice", item.Username, item.DisplayName)
	}
	if item.MessageType != domainglobalchat.MessageTypeText || item.Content != "大家好 😀" {
		t.Fatalf("SendText() item = %#v", item)
	}
	if event := nextDataEvent(t, events); event.Type != EventMessage {
		t.Fatalf("broadcast event type = %q, want %q", event.Type, EventMessage)
	}
}

func TestSendTextFallbackDisplayName(t *testing.T) {
	hub := NewHub(nil)
	service := NewService(&fakeRepo{}, hub, &fakeUserRepo{user: domainuser.User{ID: 8, Username: "bob"}}, nil)
	item, err := service.SendText(context.Background(), 8, "hi")
	if err != nil {
		t.Fatalf("SendText() error = %v", err)
	}
	if item.DisplayName != "bob" {
		t.Fatalf("DisplayName() = %q, want fallback to username", item.DisplayName)
	}
}

func TestSendImageValidation(t *testing.T) {
	repo := &fakeRepo{imageFile: &domainglobalchat.ImageFile{FileID: "f1", MimeType: "image/png"}}
	service, _ := newTestService(repo)

	if _, err := service.SendImage(context.Background(), 7, ""); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("SendImage() empty fileID error = %v, want ErrInvalidMessage", err)
	}
	repo.imageErr = repository.ErrNotFound
	if _, err := service.SendImage(context.Background(), 7, "missing"); !errors.Is(err, ErrImageFileInvalid) {
		t.Fatalf("SendImage() missing file error = %v, want ErrImageFileInvalid", err)
	}
	repo.imageErr = nil
	repo.imageFile.MimeType = "application/pdf"
	if _, err := service.SendImage(context.Background(), 7, "f1"); !errors.Is(err, ErrImageFileInvalid) {
		t.Fatalf("SendImage() non-image error = %v, want ErrImageFileInvalid", err)
	}
}

func TestSendImageCreatesMessageWithFileReference(t *testing.T) {
	repo := &fakeRepo{imageFile: &domainglobalchat.ImageFile{FileID: "img-1", MimeType: "image/png"}}
	service, _ := newTestService(repo)

	item, err := service.SendImage(context.Background(), 7, "img-1")
	if err != nil {
		t.Fatalf("SendImage() error = %v", err)
	}
	if item.MessageType != domainglobalchat.MessageTypeImage || item.ImageFileID != "img-1" || item.Content != "" {
		t.Fatalf("SendImage() item = %#v", item)
	}
}

func TestDeleteMessageBroadcastsAndMapsNotFound(t *testing.T) {
	repo := &fakeRepo{}
	service, hub := newTestService(repo)
	events, _, cancel := hub.Subscribe(42)
	defer cancel()

	if err := service.DeleteMessage(context.Background(), 0); !errors.Is(err, repository.ErrInvalidInput) {
		t.Fatalf("DeleteMessage() zero id error = %v, want ErrInvalidInput", err)
	}
	if err := service.DeleteMessage(context.Background(), 5); err != nil {
		t.Fatalf("DeleteMessage() error = %v", err)
	}
	if event := nextDataEvent(t, events); event.Type != EventMessageDeleted {
		t.Fatalf("broadcast event type = %q, want %q", event.Type, EventMessageDeleted)
	}

	repo.deleteErr = repository.ErrNotFound
	if err := service.DeleteMessage(context.Background(), 9); !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("DeleteMessage() missing error = %v, want ErrMessageNotFound", err)
	}
}

func TestDeleteMessagesDeduplicatesAndBroadcastsAll(t *testing.T) {
	repo := &fakeRepo{}
	service, hub := newTestService(repo)
	events, _, cancel := hub.Subscribe(42)
	defer cancel()

	// 空/全零 ID 拒绝。
	if _, err := service.DeleteMessages(context.Background(), nil); !errors.Is(err, repository.ErrInvalidInput) {
		t.Fatalf("DeleteMessages() empty ids error = %v, want ErrInvalidInput", err)
	}
	if _, err := service.DeleteMessages(context.Background(), []uint{0, 0}); !errors.Is(err, repository.ErrInvalidInput) {
		t.Fatalf("DeleteMessages() zero ids error = %v, want ErrInvalidInput", err)
	}

	deleted, err := service.DeleteMessages(context.Background(), []uint{5, 5, 7, 0, 9})
	if err != nil {
		t.Fatalf("DeleteMessages() error = %v", err)
	}
	if deleted != 3 {
		t.Fatalf("DeleteMessages() deleted = %d, want 3 (fake repo deletes all)", deleted)
	}
	// 去重后 3 个 ID 全部广播（超集），不依赖 DB 命中数。
	broadcast := 0
	for {
		select {
		case event := <-events:
			if event.Type == EventMessageDeleted {
				broadcast++
			}
		default:
			if broadcast != 3 {
				t.Fatalf("broadcast deleted events = %d, want 3 (deduplicated superset)", broadcast)
			}
			return
		}
	}
}

func TestDeleteMessagesCapsBatchSize(t *testing.T) {
	repo := &fakeRepo{batchDeleted: 100}
	service, _ := newTestService(repo)

	ids := make([]uint, maxBatchDeleteLimit+10)
	for i := range ids {
		ids[i] = uint(i + 1)
	}
	deleted, err := service.DeleteMessages(context.Background(), ids)
	if err != nil {
		t.Fatalf("DeleteMessages() error = %v", err)
	}
	if deleted != 100 {
		t.Fatalf("DeleteMessages() deleted = %d, want 100 (capped)", deleted)
	}
	if len(repo.lastBatchIDs) != maxBatchDeleteLimit {
		t.Fatalf("repository received %d ids, want %d", len(repo.lastBatchIDs), maxBatchDeleteLimit)
	}
}

func TestListAfterIDReportsReplayOverflow(t *testing.T) {
	repo := &fakeRepo{}
	service, _ := newTestService(repo)

	if _, _, err := service.ListAfterID(context.Background(), 0); !errors.Is(err, repository.ErrInvalidInput) {
		t.Fatalf("ListAfterID() zero cursor error = %v, want ErrInvalidInput", err)
	}

	repo.afterMessages = make([]domainglobalchat.Message, MaxReplayLimit)
	_, hasMore, err := service.ListAfterID(context.Background(), 1)
	if err != nil {
		t.Fatalf("ListAfterID() error = %v", err)
	}
	if !hasMore {
		t.Fatal("ListAfterID() hasMore = false, want true when replay hits limit")
	}

	repo.afterMessages = repo.afterMessages[:10]
	_, hasMore, err = service.ListAfterID(context.Background(), 1)
	if err != nil {
		t.Fatalf("ListAfterID() error = %v", err)
	}
	if hasMore {
		t.Fatal("ListAfterID() hasMore = true, want false below limit")
	}
}

func TestOpenImageContentWithoutProvider(t *testing.T) {
	service, _ := newTestService(&fakeRepo{})
	if _, err := service.OpenImageContent(context.Background(), "f1"); !errors.Is(err, ErrImageFileNotFound) {
		t.Fatalf("OpenImageContent() without provider error = %v, want ErrImageFileNotFound", err)
	}
}

type fakeRepo struct {
	imageFile     *domainglobalchat.ImageFile
	imageErr      error
	deleteErr     error
	batchDeleted  int
	lastBatchIDs  []uint
	afterMessages []domainglobalchat.Message
}

func (r *fakeRepo) ListRecentMessages(context.Context, int) ([]domainglobalchat.Message, error) {
	return []domainglobalchat.Message{}, nil
}

func (r *fakeRepo) ListMessagesBeforeID(context.Context, uint, int) ([]domainglobalchat.Message, error) {
	return []domainglobalchat.Message{}, nil
}

func (r *fakeRepo) ListMessagesAfterID(_ context.Context, afterID uint, limit int) ([]domainglobalchat.Message, error) {
	return r.afterMessages, nil
}

func (r *fakeRepo) CreateMessage(_ context.Context, item *domainglobalchat.Message) (*domainglobalchat.Message, error) {
	item.ID = 100
	return item, nil
}

func (r *fakeRepo) DeleteMessage(context.Context, uint) error {
	return r.deleteErr
}

func (r *fakeRepo) DeleteMessages(_ context.Context, ids []uint) (int, error) {
	r.lastBatchIDs = ids
	if r.batchDeleted > 0 {
		return r.batchDeleted, nil
	}
	return len(ids), nil
}

func (r *fakeRepo) GetOwnedImageFile(context.Context, uint, string) (*domainglobalchat.ImageFile, error) {
	if r.imageErr != nil {
		return nil, r.imageErr
	}
	return r.imageFile, nil
}

func (r *fakeRepo) GetSharedImageFile(context.Context, string) (*domainglobalchat.ImageFile, error) {
	return r.imageFile, nil
}

type fakeUserRepo struct {
	user domainuser.User
}

func (r *fakeUserRepo) GetByID(_ context.Context, _ uint) (*domainuser.User, error) {
	return &r.user, nil
}

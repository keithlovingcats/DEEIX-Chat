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
	if _, err := service.SendText(context.Background(), 0, "sess-1", "hi"); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("SendText() with zero user error = %v, want ErrInvalidMessage", err)
	}
	if _, err := service.SendText(context.Background(), 7, "sess-1", "   "); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("SendText() blank content error = %v, want ErrInvalidMessage", err)
	}
	if _, err := service.SendText(context.Background(), 7, "sess-1", strings.Repeat("字", maxTextContentLength+1)); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("SendText() oversized content error = %v, want ErrInvalidMessage", err)
	}
}

func TestSendTextSnapshotsUserAndBroadcasts(t *testing.T) {
	repo := &fakeRepo{}
	service, hub := newTestService(repo)
	events, _, cancel := hub.Subscribe(42)
	defer cancel()

	item, err := service.SendText(context.Background(), 7, "sess-1", "大家好 😀")
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
	item, err := service.SendText(context.Background(), 8, "sess-1", "hi")
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

	if _, err := service.SendImage(context.Background(), 7, "sess-1", ""); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("SendImage() empty fileID error = %v, want ErrInvalidMessage", err)
	}
	repo.imageErr = repository.ErrNotFound
	if _, err := service.SendImage(context.Background(), 7, "sess-1", "missing"); !errors.Is(err, ErrImageFileInvalid) {
		t.Fatalf("SendImage() missing file error = %v, want ErrImageFileInvalid", err)
	}
	repo.imageErr = nil
	repo.imageFile.MimeType = "application/pdf"
	if _, err := service.SendImage(context.Background(), 7, "sess-1", "f1"); !errors.Is(err, ErrImageFileInvalid) {
		t.Fatalf("SendImage() non-image error = %v, want ErrImageFileInvalid", err)
	}
}

func TestSendImageCreatesMessageWithFileReference(t *testing.T) {
	repo := &fakeRepo{imageFile: &domainglobalchat.ImageFile{FileID: "img-1", MimeType: "image/png"}}
	service, _ := newTestService(repo)

	item, err := service.SendImage(context.Background(), 7, "sess-1", "img-1")
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

func TestListRecentAndBeforeIDLookaheadHasMore(t *testing.T) {
	repo := &fakeRepo{}
	service, _ := newTestService(repo)
	makeMessages := func(n int, startID uint) []domainglobalchat.Message {
		items := make([]domainglobalchat.Message, 0, n)
		for i := 0; i < n; i++ {
			items = append(items, domainglobalchat.Message{ID: startID + uint(i)})
		}
		return items
	}

	// 预取一条超出页大小：裁剪回 50 条并上报 hasMore（整页边界不再误报）。
	repo.recentMessages = makeMessages(DefaultListLimit+1, 1)
	items, hasMore, err := service.ListRecent(context.Background(), 0)
	if err != nil {
		t.Fatalf("ListRecent() error = %v", err)
	}
	if len(items) != DefaultListLimit || !hasMore {
		t.Fatalf("ListRecent() = %d items, hasMore=%v, want %d items, hasMore=true", len(items), hasMore, DefaultListLimit)
	}
	if repo.lastRecentLimit != DefaultListLimit+1 {
		t.Fatalf("repository received limit %d, want %d (look-ahead)", repo.lastRecentLimit, DefaultListLimit+1)
	}

	// 不足一页：原样返回且 hasMore=false。
	repo.recentMessages = makeMessages(30, 1)
	items, hasMore, err = service.ListRecent(context.Background(), 0)
	if err != nil {
		t.Fatalf("ListRecent() partial error = %v", err)
	}
	if len(items) != 30 || hasMore {
		t.Fatalf("ListRecent() partial = %d items, hasMore=%v, want 30, false", len(items), hasMore)
	}

	if _, _, err := service.ListBeforeID(context.Background(), 0, 0); !errors.Is(err, repository.ErrInvalidInput) {
		t.Fatalf("ListBeforeID() zero cursor error = %v, want ErrInvalidInput", err)
	}

	// limit 超上限：service 归一化封顶 200，预取 201 条仍可精确判定。
	repo.beforeMessages = makeMessages(MaxReplayLimit+1, 1)
	items, hasMore, err = service.ListBeforeID(context.Background(), 10, 999)
	if err != nil {
		t.Fatalf("ListBeforeID() error = %v", err)
	}
	if len(items) != MaxReplayLimit || !hasMore {
		t.Fatalf("ListBeforeID() = %d items, hasMore=%v, want %d, true", len(items), hasMore, MaxReplayLimit)
	}
	if repo.lastBeforeLimit != MaxReplayLimit+1 {
		t.Fatalf("repository received limit %d, want %d", repo.lastBeforeLimit, MaxReplayLimit+1)
	}
}

func TestListDeletionsSinceValidation(t *testing.T) {
	repo := &fakeRepo{}
	service, _ := newTestService(repo)

	if _, _, err := service.ListDeletionsSince(context.Background(), 0); !errors.Is(err, repository.ErrInvalidInput) {
		t.Fatalf("ListDeletionsSince() zero cursor error = %v, want ErrInvalidInput", err)
	}

	repo.deletedSince = []uint{3, 5}
	ids, hasMore, err := service.ListDeletionsSince(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListDeletionsSince() error = %v", err)
	}
	if len(ids) != 2 || ids[0] != 3 || ids[1] != 5 {
		t.Fatalf("ListDeletionsSince() = %v, want [3 5]", ids)
	}
	if hasMore {
		t.Fatal("ListDeletionsSince() hasMore = true, want false below limit")
	}
	if repo.lastSinceLimit != MaxDeletionReplayLimit {
		t.Fatalf("repository received limit %d, want %d", repo.lastSinceLimit, MaxDeletionReplayLimit)
	}

	// 达到补发上限时上报 hasMore，由 handler 改为下发 resync 整体重拉。
	repo.deletedSince = make([]uint, MaxDeletionReplayLimit)
	_, hasMore, err = service.ListDeletionsSince(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListDeletionsSince() overflow error = %v", err)
	}
	if !hasMore {
		t.Fatal("ListDeletionsSince() hasMore = false, want true at limit")
	}
}

func TestOpenImageContentWithoutProvider(t *testing.T) {
	service, _ := newTestService(&fakeRepo{})
	if _, err := service.OpenImageContent(context.Background(), "f1"); !errors.Is(err, ErrImageFileNotFound) {
		t.Fatalf("OpenImageContent() without provider error = %v, want ErrImageFileNotFound", err)
	}
}

type fakeRepo struct {
	imageFile       *domainglobalchat.ImageFile
	imageErr        error
	deleteErr       error
	batchDeleted    int
	lastBatchIDs    []uint
	afterMessages   []domainglobalchat.Message
	recentMessages  []domainglobalchat.Message
	beforeMessages  []domainglobalchat.Message
	lastRecentLimit int
	lastBeforeLimit int
	deletedSince    []uint
	lastSinceLimit  int
	deletedSinceErr error
}

func (r *fakeRepo) ListRecentMessages(_ context.Context, limit int) ([]domainglobalchat.Message, error) {
	r.lastRecentLimit = limit
	return r.recentMessages, nil
}

func (r *fakeRepo) ListMessagesBeforeID(_ context.Context, _ uint, limit int) ([]domainglobalchat.Message, error) {
	r.lastBeforeLimit = limit
	return r.beforeMessages, nil
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

func (r *fakeRepo) ListDeletedIDsSince(_ context.Context, _ uint, limit int) ([]uint, error) {
	r.lastSinceLimit = limit
	if r.deletedSinceErr != nil {
		return nil, r.deletedSinceErr
	}
	return r.deletedSince, nil
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

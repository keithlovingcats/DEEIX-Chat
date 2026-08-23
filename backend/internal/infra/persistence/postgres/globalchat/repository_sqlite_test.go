package globalchat

import (
	"context"
	"errors"
	"testing"
	"time"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestImageFileQueriesEnforcePurposeAndOwnership(t *testing.T) {
	db := openGlobalChatSQLiteTestDB(t)
	seedFileObject(t, db, model.FileObject{
		FileID:      "gc-image",
		UserID:      7,
		Purpose:     "global-chat",
		MimeType:    "image/png",
		DetectedMIME: "image/png",
		StoragePath: "storage/gc-image",
		Status:      "active",
	})
	seedFileObject(t, db, model.FileObject{
		FileID:      "conv-image",
		UserID:      7,
		Purpose:     "conversation_input",
		MimeType:    "image/png",
		DetectedMIME: "image/png",
		StoragePath: "storage/conv-image",
		Status:      "active",
	})

	repo := NewRepo(db)
	ctx := context.Background()

	// 归属 + 用途都匹配才可发送。
	if _, err := repo.GetOwnedImageFile(ctx, 7, "gc-image"); err != nil {
		t.Fatalf("GetOwnedImageFile() matched file error = %v", err)
	}
	// 用途不是 global-chat 的文件不能作为聊天图片发送（否则会发出只有自己可见的死图）。
	if _, err := repo.GetOwnedImageFile(ctx, 7, "conv-image"); err != repository.ErrNotFound {
		t.Fatalf("GetOwnedImageFile() wrong purpose error = %v, want ErrNotFound", err)
	}
	// 他人文件不能发送。
	if _, err := repo.GetOwnedImageFile(ctx, 8, "gc-image"); err != repository.ErrNotFound {
		t.Fatalf("GetOwnedImageFile() other owner error = %v, want ErrNotFound", err)
	}
	// 读取端：purpose 匹配即对所有登录用户可见。
	if _, err := repo.GetSharedImageFile(ctx, "gc-image"); err != nil {
		t.Fatalf("GetSharedImageFile() error = %v", err)
	}
	if _, err := repo.GetSharedImageFile(ctx, "conv-image"); err != repository.ErrNotFound {
		t.Fatalf("GetSharedImageFile() wrong purpose error = %v, want ErrNotFound", err)
	}
}

func TestListDeletedIDsSinceReturnsWindowDeletions(t *testing.T) {
	db := openGlobalChatSQLiteTestDB(t)
	repo := NewRepo(db)
	ctx := context.Background()

	seed := func(content string) uint {
		item := model.GlobalChatMessage{
			PublicID: content, UserID: 1, Username: "alice", MessageType: "text", Content: content,
		}
		if err := db.Create(&item).Error; err != nil {
			t.Fatalf("seed message %s: %v", content, err)
		}
		return item.ID
	}
	idA := seed("A")
	idB := seed("B")
	idC := seed("C")
	seed("D")

	// 软删除 A 与 B；锚点为 C（after_id = idC），D 从未被客户端确认（id > 锚点）。
	for _, id := range []uint{idA, idB} {
		if err := repo.DeleteMessage(ctx, id); err != nil {
			t.Fatalf("DeleteMessage(%d): %v", id, err)
		}
	}

	// B 的删除时间改到锚点 C 创建时间之前：属于客户端在线期间的删除，
	// 无需补发，应被窗口条件排除。
	past := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := db.Unscoped().Model(&model.GlobalChatMessage{}).
		Where("id = ?", idB).
		Update("deleted_at", past).Error; err != nil {
		t.Fatalf("backdate deleted_at: %v", err)
	}

	ids, err := repo.ListDeletedIDsSince(ctx, idC, 100)
	if err != nil {
		t.Fatalf("ListDeletedIDsSince() error = %v", err)
	}
	// 只补发 A（id <= 锚点且删除晚于锚点创建）；B 在窗口外，D 未被确认过。
	if len(ids) != 1 || ids[0] != idA {
		t.Fatalf("ListDeletedIDsSince() = %v, want only [%d]", ids, idA)
	}

	// 锚点消息自身被删除（Unscoped 查询仍可定位）不阻断补发。
	if err := repo.DeleteMessage(ctx, idC); err != nil {
		t.Fatalf("DeleteMessage(anchor): %v", err)
	}
	ids, err = repo.ListDeletedIDsSince(ctx, idC, 100)
	if err != nil {
		t.Fatalf("ListDeletedIDsSince() after anchor deleted error = %v", err)
	}
	// A 与锚点 C 自身都应补发。
	if len(ids) != 2 || ids[0] != idA || ids[1] != idC {
		t.Fatalf("ListDeletedIDsSince() = %v, want [%d %d]", ids, idA, idC)
	}

	// limit 封顶返回条数（升序取最小 id）：上层达到上限时改下发 resync。
	capped, err := repo.ListDeletedIDsSince(ctx, idC, 1)
	if err != nil {
		t.Fatalf("ListDeletedIDsSince() capped error = %v", err)
	}
	if len(capped) != 1 || capped[0] != idA {
		t.Fatalf("ListDeletedIDsSince() capped = %v, want only [%d]", capped, idA)
	}

	// 锚点不存在 → ErrNotFound（上层下发 resync）。
	if _, err := repo.ListDeletedIDsSince(ctx, 9999, 100); !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("ListDeletedIDsSince() missing anchor error = %v, want ErrNotFound", err)
	}
}

func TestListMessagesCursorOrdering(t *testing.T) {
	db := openGlobalChatSQLiteTestDB(t)
	repo := NewRepo(db)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if err := db.Create(&model.GlobalChatMessage{
			PublicID:    string(rune('a' + i)),
			UserID:      1,
			Username:    "alice",
			MessageType: "text",
			Content:     string(rune('A' + i)),
		}).Error; err != nil {
			t.Fatalf("seed message: %v", err)
		}
	}

	recent, err := repo.ListRecentMessages(ctx, 2)
	if err != nil {
		t.Fatalf("ListRecentMessages() error = %v", err)
	}
	if len(recent) != 2 || recent[0].Content != "B" || recent[1].Content != "C" {
		t.Fatalf("ListRecentMessages() = %#v, want ascending C,B tail", recent)
	}

	before, err := repo.ListMessagesBeforeID(ctx, recent[0].ID, 2)
	if err != nil {
		t.Fatalf("ListMessagesBeforeID() error = %v", err)
	}
	if len(before) != 1 || before[0].Content != "A" {
		t.Fatalf("ListMessagesBeforeID() = %#v, want only A before cursor", before)
	}

	after, err := repo.ListMessagesAfterID(ctx, recent[0].ID, 10)
	if err != nil {
		t.Fatalf("ListMessagesAfterID() error = %v", err)
	}
	if len(after) != 1 || after[0].Content != "C" {
		t.Fatalf("ListMessagesAfterID() = %#v, want only C after cursor", after)
	}
}

func seedFileObject(t *testing.T, db *gorm.DB, item model.FileObject) {
	t.Helper()
	if err := db.Create(&item).Error; err != nil {
		t.Fatalf("seed file object %s: %v", item.FileID, err)
	}
}

func openGlobalChatSQLiteTestDB(t *testing.T) *gorm.DB {
	t.Helper()

	db, err := gorm.Open(sqlite.Open("file:global_chat_messages?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("resolve sql db: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() {
		_ = sqlDB.Close()
	})

	if err := db.AutoMigrate(&model.GlobalChatMessage{}, &model.FileObject{}); err != nil {
		t.Fatalf("migrate global chat tables: %v", err)
	}
	return db
}

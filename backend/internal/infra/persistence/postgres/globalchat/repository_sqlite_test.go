package globalchat

import (
	"context"
	"testing"

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

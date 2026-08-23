package repository

import (
	"context"

	domainglobalchat "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/globalchat"
)

// GlobalChatRepository 定义全服聊天依赖的持久化能力。
type GlobalChatRepository interface {
	ListRecentMessages(ctx context.Context, limit int) ([]domainglobalchat.Message, error)
	ListMessagesBeforeID(ctx context.Context, beforeID uint, limit int) ([]domainglobalchat.Message, error)
	ListMessagesAfterID(ctx context.Context, afterID uint, limit int) ([]domainglobalchat.Message, error)
	CreateMessage(ctx context.Context, item *domainglobalchat.Message) (*domainglobalchat.Message, error)
	DeleteMessage(ctx context.Context, id uint) error
	DeleteMessages(ctx context.Context, ids []uint) (int, error)
	GetOwnedImageFile(ctx context.Context, userID uint, fileID string) (*domainglobalchat.ImageFile, error)
	GetSharedImageFile(ctx context.Context, fileID string) (*domainglobalchat.ImageFile, error)
}

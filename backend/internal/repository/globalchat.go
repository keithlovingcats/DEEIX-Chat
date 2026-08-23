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
	// ListDeletedIDsSince 查询断线窗口内（afterID 消息创建时间之后）被软删除、
	// 且在客户端确认范围（id <= afterID）内的消息 ID，用于重连补发删除事件；
	// limit 封顶返回条数，调用方达到上限时应改为整体重拉。
	ListDeletedIDsSince(ctx context.Context, afterID uint, limit int) ([]uint, error)
	CreateMessage(ctx context.Context, item *domainglobalchat.Message) (*domainglobalchat.Message, error)
	DeleteMessage(ctx context.Context, id uint) error
	DeleteMessages(ctx context.Context, ids []uint) (int, error)
	GetOwnedImageFile(ctx context.Context, userID uint, fileID string) (*domainglobalchat.ImageFile, error)
	GetSharedImageFile(ctx context.Context, fileID string) (*domainglobalchat.ImageFile, error)
}

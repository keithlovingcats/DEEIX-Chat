package globalchat

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"

	appstorage "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/objectstorage"
	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	domainconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	domainglobalchat "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/globalchat"
	domainuser "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/user"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/objectstore"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/conv"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

// 消息与回放限制。
const (
	maxTextContentLength = 2000
	// MaxReplayLimit 是断线回放的最大条数；达到上限时客户端应整体重拉。
	MaxReplayLimit = 200
	defaultListLimit = 50
)

// UserReader 提供发送者信息快照所需的用户读取能力。
type UserReader interface {
	GetByID(ctx context.Context, userID uint) (*domainuser.User, error)
}

// Service 封装全服聊天业务逻辑。
type Service struct {
	repo          repository.GlobalChatRepository
	hub           *Hub
	users         UserReader
	storeProvider appstorage.Provider
}

// NewService 创建全服聊天服务。
func NewService(
	repo repository.GlobalChatRepository,
	hub *Hub,
	users UserReader,
	storeProvider appstorage.Provider,
) *Service {
	return &Service{repo: repo, hub: hub, users: users, storeProvider: storeProvider}
}

// Hub 返回广播中心（HTTP 层建立 NDJSON 长连接时使用）。
func (s *Service) Hub() *Hub {
	return s.hub
}

// ListRecent 查询最新消息（升序）。
func (s *Service) ListRecent(ctx context.Context, limit int) ([]domainglobalchat.Message, error) {
	return s.repo.ListRecentMessages(ctx, normalizeListLimit(limit))
}

// ListBeforeID 游标分页查询更早消息（升序）。
func (s *Service) ListBeforeID(ctx context.Context, beforeID uint, limit int) ([]domainglobalchat.Message, error) {
	if beforeID == 0 {
		return nil, repository.ErrInvalidInput
	}
	return s.repo.ListMessagesBeforeID(ctx, beforeID, normalizeListLimit(limit))
}

// ListAfterID 查询指定 ID 之后的消息（断线回放，升序）。
// 返回值 hasMore 表示结果达到回放上限，客户端应整体重拉最新消息。
func (s *Service) ListAfterID(ctx context.Context, afterID uint) ([]domainglobalchat.Message, bool, error) {
	if afterID == 0 {
		return nil, false, repository.ErrInvalidInput
	}
	items, err := s.repo.ListMessagesAfterID(ctx, afterID, MaxReplayLimit)
	if err != nil {
		return nil, false, err
	}
	return items, len(items) >= MaxReplayLimit, nil
}

// SendText 发送文本消息（含 Emoji），原样存储，由前端纯文本渲染。
func (s *Service) SendText(ctx context.Context, userID uint, content string) (*domainglobalchat.Message, error) {
	trimmed := strings.TrimSpace(content)
	if userID == 0 || trimmed == "" || len([]rune(trimmed)) > maxTextContentLength {
		return nil, ErrInvalidMessage
	}
	return s.createMessage(ctx, userID, domainglobalchat.MessageTypeText, trimmed, "")
}

// SendImage 发送图片消息，fileID 必须是当前用户以 global-chat 用途上传的图片文件。
// 图片内容安全依赖上传链路的 MIME 探测与大小限制（upload service）。
func (s *Service) SendImage(ctx context.Context, userID uint, fileID string) (*domainglobalchat.Message, error) {
	normalized := strings.TrimSpace(fileID)
	if userID == 0 || normalized == "" {
		return nil, ErrInvalidMessage
	}
	file, err := s.repo.GetOwnedImageFile(ctx, userID, normalized)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrImageFileInvalid
		}
		return nil, err
	}
	if !strings.HasPrefix(strings.ToLower(file.MimeType), "image/") {
		return nil, ErrImageFileInvalid
	}
	return s.createMessage(ctx, userID, domainglobalchat.MessageTypeImage, "", file.FileID)
}

// DeleteMessage 管理员软删除消息并广播删除事件。
func (s *Service) DeleteMessage(ctx context.Context, id uint) error {
	if id == 0 {
		return repository.ErrInvalidInput
	}
	if err := s.repo.DeleteMessage(ctx, id); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return ErrMessageNotFound
		}
		return err
	}
	s.hub.Broadcast(HubEvent{
		Type: EventMessageDeleted,
		Data: map[string]interface{}{"id": id},
	})
	return nil
}

// OpenImageContent 读取全服聊天共享图片内容（所有登录用户可读，不校验归属）。
func (s *Service) OpenImageContent(ctx context.Context, fileID string) (*appupload.FileContentResult, error) {
	if s.storeProvider == nil {
		return nil, ErrImageFileNotFound
	}
	file, err := s.repo.GetSharedImageFile(ctx, fileID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrImageFileNotFound
		}
		return nil, err
	}
	store, err := s.storeProvider.Open(ctx)
	if err != nil {
		return nil, err
	}
	reader, info, err := store.Open(ctx, file.StoragePath)
	if err != nil {
		if errors.Is(err, objectstore.ErrNotFound) {
			return nil, ErrImageFileNotFound
		}
		return nil, err
	}
	contentType := file.MimeType
	if contentType == "" {
		contentType = info.ContentType
	}
	return &appupload.FileContentResult{
		File: domainconversation.FileObject{
			FileID:   file.FileID,
			UserID:   file.UserID,
			FileName: file.FileName,
			MimeType: contentType,
		},
		Reader:      reader,
		ContentType: contentType,
		SizeBytes:   info.SizeBytes,
		ModTime:     info.ModTime,
	}, nil
}

func (s *Service) createMessage(ctx context.Context, userID uint, messageType string, content string, imageFileID string) (*domainglobalchat.Message, error) {
	snapshot, err := s.loadUserSnapshot(ctx, userID)
	if err != nil {
		return nil, err
	}
	item, err := s.repo.CreateMessage(ctx, &domainglobalchat.Message{
		PublicID:    conv.NormalizePublicID(uuid.NewString()),
		UserID:      userID,
		Username:    snapshot.username,
		DisplayName: snapshot.displayName,
		AvatarURL:   snapshot.avatarURL,
		MessageType: messageType,
		Content:     content,
		ImageFileID: imageFileID,
	})
	if err != nil {
		return nil, err
	}
	s.hub.Broadcast(HubEvent{
		Type: EventMessage,
		Data: item,
	})
	return item, nil
}

type userSnapshot struct {
	username    string
	displayName string
	avatarURL   string
}

func (s *Service) loadUserSnapshot(ctx context.Context, userID uint) (userSnapshot, error) {
	user, err := s.users.GetByID(ctx, userID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return userSnapshot{}, ErrInvalidMessage
		}
		return userSnapshot{}, err
	}
	return userSnapshotFromDomain(*user), nil
}

func userSnapshotFromDomain(user domainuser.User) userSnapshot {
	displayName := strings.TrimSpace(user.DisplayName)
	if displayName == "" {
		displayName = user.Username
	}
	return userSnapshot{
		username:    user.Username,
		displayName: displayName,
		avatarURL:   user.AvatarURL,
	}
}

func normalizeListLimit(limit int) int {
	if limit <= 0 {
		return defaultListLimit
	}
	if limit > MaxReplayLimit {
		return MaxReplayLimit
	}
	return limit
}

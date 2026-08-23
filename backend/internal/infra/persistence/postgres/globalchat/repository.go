package globalchat

import (
	"context"
	"strings"

	domainglobalchat "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/globalchat"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/dberror"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/gorm"
)

// globalChatPurpose 是全服聊天图片文件的上传用途标记。
const globalChatPurpose = "global-chat"

// Repo 封装全服聊天数据访问。
type Repo struct {
	db *gorm.DB
}

// NewRepo 创建全服聊天仓储。
func NewRepo(db *gorm.DB) *Repo {
	return &Repo{db: db}
}

// ListRecentMessages 查询最新消息（升序返回）。
func (r *Repo) ListRecentMessages(ctx context.Context, limit int) ([]domainglobalchat.Message, error) {
	limit = normalizeLimit(limit)
	items := make([]model.GlobalChatMessage, 0, limit)
	if err := r.db.WithContext(ctx).
		Order("id DESC").
		Limit(limit).
		Find(&items).Error; err != nil {
		return nil, translateError(err)
	}
	return reverseToDomain(items), nil
}

// ListMessagesBeforeID 游标分页查询更早消息（升序返回）。
func (r *Repo) ListMessagesBeforeID(ctx context.Context, beforeID uint, limit int) ([]domainglobalchat.Message, error) {
	limit = normalizeLimit(limit)
	items := make([]model.GlobalChatMessage, 0, limit)
	query := r.db.WithContext(ctx)
	if beforeID > 0 {
		query = query.Where("id < ?", beforeID)
	}
	if err := query.
		Order("id DESC").
		Limit(limit).
		Find(&items).Error; err != nil {
		return nil, translateError(err)
	}
	return reverseToDomain(items), nil
}

// ListMessagesAfterID 查询指定 ID 之后的消息（断线回放，升序返回）。
func (r *Repo) ListMessagesAfterID(ctx context.Context, afterID uint, limit int) ([]domainglobalchat.Message, error) {
	limit = normalizeLimit(limit)
	items := make([]model.GlobalChatMessage, 0, limit)
	query := r.db.WithContext(ctx)
	if afterID > 0 {
		query = query.Where("id > ?", afterID)
	}
	if err := query.
		Order("id ASC").
		Limit(limit).
		Find(&items).Error; err != nil {
		return nil, translateError(err)
	}
	results := make([]domainglobalchat.Message, 0, len(items))
	for _, item := range items {
		results = append(results, toDomain(item))
	}
	return results, nil
}

// CreateMessage 创建消息。
func (r *Repo) CreateMessage(ctx context.Context, item *domainglobalchat.Message) (*domainglobalchat.Message, error) {
	if item == nil {
		return nil, repository.ErrInvalidInput
	}
	record := model.GlobalChatMessage{
		PublicID:    strings.TrimSpace(item.PublicID),
		UserID:      item.UserID,
		Username:    strings.TrimSpace(item.Username),
		DisplayName: strings.TrimSpace(item.DisplayName),
		AvatarURL:   strings.TrimSpace(item.AvatarURL),
		MessageType: item.MessageType,
		Content:     item.Content,
		ImageFileID: strings.TrimSpace(item.ImageFileID),
		SessionID:   strings.TrimSpace(item.SessionID),
	}
	if err := r.db.WithContext(ctx).Create(&record).Error; err != nil {
		return nil, translateError(err)
	}
	result := toDomain(record)
	return &result, nil
}

// DeleteMessage 软删除消息。
func (r *Repo) DeleteMessage(ctx context.Context, id uint) error {
	if id == 0 {
		return repository.ErrInvalidInput
	}
	result := r.db.WithContext(ctx).Delete(&model.GlobalChatMessage{}, id)
	if result.Error != nil {
		return translateError(result.Error)
	}
	if result.RowsAffected == 0 {
		return repository.ErrNotFound
	}
	return nil
}

// DeleteMessages 批量软删除消息，返回实际删除条数（不存在的 ID 忽略）。
func (r *Repo) DeleteMessages(ctx context.Context, ids []uint) (int, error) {
	if len(ids) == 0 {
		return 0, repository.ErrInvalidInput
	}
	result := r.db.WithContext(ctx).Delete(&model.GlobalChatMessage{}, ids)
	if result.Error != nil {
		return 0, translateError(result.Error)
	}
	return int(result.RowsAffected), nil
}

// GetOwnedImageFile 校验图片文件归属当前用户且用途为全服聊天。
func (r *Repo) GetOwnedImageFile(ctx context.Context, userID uint, fileID string) (*domainglobalchat.ImageFile, error) {
	normalized := strings.TrimSpace(fileID)
	if userID == 0 || normalized == "" {
		return nil, repository.ErrInvalidInput
	}
	var record model.FileObject
	if err := r.db.WithContext(ctx).
		Where("file_id = ? AND user_id = ? AND purpose = ? AND status = ?", normalized, userID, globalChatPurpose, "active").
		First(&record).Error; err != nil {
		return nil, translateError(err)
	}
	return toImageFileDomain(record), nil
}

// GetSharedImageFile 查询全服聊天共享图片文件（不校验归属，仅校验用途）。
func (r *Repo) GetSharedImageFile(ctx context.Context, fileID string) (*domainglobalchat.ImageFile, error) {
	normalized := strings.TrimSpace(fileID)
	if normalized == "" {
		return nil, repository.ErrInvalidInput
	}
	var record model.FileObject
	if err := r.db.WithContext(ctx).
		Where("file_id = ? AND purpose = ? AND status = ?", normalized, globalChatPurpose, "active").
		First(&record).Error; err != nil {
		return nil, translateError(err)
	}
	return toImageFileDomain(record), nil
}

func toImageFileDomain(record model.FileObject) *domainglobalchat.ImageFile {
	mimeType := strings.TrimSpace(record.DetectedMIME)
	if mimeType == "" {
		mimeType = strings.TrimSpace(record.MimeType)
	}
	return &domainglobalchat.ImageFile{
		FileID:      record.FileID,
		UserID:      record.UserID,
		StoragePath: record.StoragePath,
		MimeType:    mimeType,
		FileName:    record.FileName,
	}
}

func reverseToDomain(items []model.GlobalChatMessage) []domainglobalchat.Message {
	results := make([]domainglobalchat.Message, 0, len(items))
	for i := len(items) - 1; i >= 0; i-- {
		results = append(results, toDomain(items[i]))
	}
	return results
}

func toDomain(item model.GlobalChatMessage) domainglobalchat.Message {
	return domainglobalchat.Message{
		ID:          item.ID,
		PublicID:    item.PublicID,
		UserID:      item.UserID,
		Username:    item.Username,
		DisplayName: item.DisplayName,
		AvatarURL:   item.AvatarURL,
		MessageType: item.MessageType,
		Content:     item.Content,
		ImageFileID: item.ImageFileID,
		SessionID:   item.SessionID,
		CreatedAt:   item.CreatedAt,
		UpdatedAt:   item.UpdatedAt,
	}
}

func normalizeLimit(limit int) int {
	if limit <= 0 {
		return 50
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func translateError(err error) error {
	if err == nil {
		return nil
	}
	if dberror.IsRecordNotFound(err) {
		return repository.ErrNotFound
	}
	return err
}

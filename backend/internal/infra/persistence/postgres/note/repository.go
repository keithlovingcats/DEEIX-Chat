package note

import (
	"context"
	"strings"

	domainnote "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/note"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/dberror"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Repo 封装笔记数据访问。
type Repo struct {
	db *gorm.DB
}

// NewRepo 创建笔记仓储。
func NewRepo(db *gorm.DB) *Repo {
	return &Repo{db: db}
}

// ListNotes 分页查询当前用户笔记。
func (r *Repo) ListNotes(ctx context.Context, filter repository.NoteListFilter, offset int, limit int) ([]domainnote.Note, int64, error) {
	if filter.UserID == 0 {
		return nil, 0, repository.ErrInvalidInput
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	items := make([]model.Note, 0, limit)
	var total int64
	query := r.db.WithContext(ctx).Model(&model.Note{}).Where("user_id = ?", filter.UserID)
	if keyword := strings.TrimSpace(filter.Query); keyword != "" {
		like := "%" + escapeLikePattern(strings.ToLower(keyword)) + "%"
		query = query.Where("LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(content) LIKE ? ESCAPE '\\'", like, like)
	}

	if err := query.Count(&total).Error; err != nil {
		return nil, 0, translateError(err)
	}
	if err := query.
		Order(noteOrderClause(filter.Sort)).
		Offset(offset).
		Limit(limit).
		Find(&items).Error; err != nil {
		return nil, 0, translateError(err)
	}

	results := make([]domainnote.Note, 0, len(items))
	for _, item := range items {
		results = append(results, toDomain(item))
	}
	return results, total, nil
}

// GetNote 按主键查询当前用户笔记。
func (r *Repo) GetNote(ctx context.Context, userID uint, id uint) (*domainnote.Note, error) {
	if userID == 0 || id == 0 {
		return nil, repository.ErrInvalidInput
	}
	var record model.Note
	if err := r.db.WithContext(ctx).Where("id = ? AND user_id = ?", id, userID).First(&record).Error; err != nil {
		return nil, translateError(err)
	}
	result := toDomain(record)
	return &result, nil
}

// CreateNote 创建笔记。
func (r *Repo) CreateNote(ctx context.Context, item *domainnote.Note) (*domainnote.Note, error) {
	if item == nil || item.UserID == 0 {
		return nil, repository.ErrInvalidInput
	}
	record := model.Note{
		UserID:  item.UserID,
		Title:   strings.TrimSpace(item.Title),
		Content: strings.TrimSpace(item.Content),
	}
	if err := r.db.WithContext(ctx).Create(&record).Error; err != nil {
		return nil, translateError(err)
	}
	result := toDomain(record)
	return &result, nil
}

// PatchNote 更新当前用户笔记字段。
func (r *Repo) PatchNote(ctx context.Context, userID uint, id uint, patch repository.NotePatch) (*domainnote.Note, error) {
	if userID == 0 || id == 0 {
		return nil, repository.ErrInvalidInput
	}
	var result domainnote.Note
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var record model.Note
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND user_id = ?", id, userID).
			First(&record).Error; err != nil {
			return translateError(err)
		}

		updates := map[string]interface{}{}
		if patch.Title != nil {
			updates["title"] = strings.TrimSpace(*patch.Title)
		}
		if patch.Content != nil {
			updates["content"] = strings.TrimSpace(*patch.Content)
		}
		if len(updates) > 0 {
			if err := tx.Model(&record).Updates(updates).Error; err != nil {
				return translateError(err)
			}
		}
		if err := tx.Where("id = ? AND user_id = ?", id, userID).First(&record).Error; err != nil {
			return translateError(err)
		}
		result = toDomain(record)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// DeleteNote 删除当前用户笔记。
func (r *Repo) DeleteNote(ctx context.Context, userID uint, id uint) error {
	if userID == 0 || id == 0 {
		return repository.ErrInvalidInput
	}
	result := r.db.WithContext(ctx).Where("id = ? AND user_id = ?", id, userID).Delete(&model.Note{})
	if result.Error != nil {
		return translateError(result.Error)
	}
	if result.RowsAffected == 0 {
		return repository.ErrNotFound
	}
	return nil
}

func noteOrderClause(sort string) string {
	switch strings.TrimSpace(sort) {
	case "created_desc":
		return "created_at DESC, id DESC"
	case "title_asc":
		return "LOWER(title) ASC, updated_at DESC, id DESC"
	default:
		return "updated_at DESC, id DESC"
	}
}

// escapeLikePattern 转义 LIKE 通配符（% _ \），配合 ESCAPE '\' 子句让用户输入按字面量匹配。
// PostgreSQL 与 SQLite 均支持该语法。
func escapeLikePattern(keyword string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(keyword)
}

func toDomain(item model.Note) domainnote.Note {
	return domainnote.Note{
		ID:        item.ID,
		UserID:    item.UserID,
		Title:     item.Title,
		Content:   item.Content,
		CreatedAt: item.CreatedAt,
		UpdatedAt: item.UpdatedAt,
	}
}

func translateError(err error) error {
	if err == nil {
		return nil
	}
	if dberror.IsRecordNotFound(err) {
		return repository.ErrNotFound
	}
	if dberror.IsUniqueConstraint(err) {
		return repository.ErrDuplicate
	}
	return err
}

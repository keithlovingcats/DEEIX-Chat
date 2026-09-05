package conversation

import (
	"context"
	"errors"
	"strings"

	repository "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

// DeleteMessage 物理删除一条消息及其全部后代消息（追问子树）。
// 支持删除 assistant 回复与 user 提问：回复全被删光后悬空的提问可一并清理，
// 删除有回复的提问则级联清掉其下回复（多模型兄弟同删，确认框已告知条数）。
// 多模型并行时同 parent 的兄弟回复（其他模型/同模型其他重试版本）不受影响；
// 生成中的消息（status=pending，含流式）不允许删除——根节点在 service 层校验，
// 子树后代在删除事务内校验（repository.ErrMessageSubtreeHasActive），避免与进行中的 run 写入竞态。
func (s *Service) DeleteMessage(ctx context.Context, userID uint, messagePublicID string) (*MessageDeleteResult, error) {
	normalizedPublicID := strings.TrimSpace(messagePublicID)
	if normalizedPublicID == "" {
		return nil, ErrMessageNotFound
	}

	message, err := s.repo.GetMessageByPublicIDForUser(ctx, userID, normalizedPublicID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrMessageNotFound
		}
		return nil, err
	}
	if message.Role != "assistant" && message.Role != "user" {
		return nil, ErrMessageDeleteTargetInvalid
	}
	if strings.EqualFold(strings.TrimSpace(message.Status), "pending") {
		return nil, ErrMessageDeleteTargetActive
	}

	deleted, err := s.repo.DeleteMessageSubtree(ctx, userID, message.ConversationID, message.ID)
	if err != nil {
		// 子树后代仍在生成（事务内校验发现 pending）：与根节点 pending 同语义。
		if errors.Is(err, repository.ErrMessageSubtreeHasActive) {
			return nil, ErrMessageDeleteTargetActive
		}
		return nil, err
	}
	if deleted > 0 {
		if err = s.repo.IncrementMessageCount(ctx, message.ConversationID, -int(deleted)); err != nil {
			return nil, err
		}
	}

	return &MessageDeleteResult{
		MessagePublicID: message.PublicID,
		ConversationID:  message.ConversationID,
		DeletedMessages: deleted,
	}, nil
}

package conversation

import (
	"context"
	"errors"
	"testing"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"go.uber.org/zap"
)

type messageDeleteRepositoryStub struct {
	repository.ConversationRepository
	message          *model.Message
	getErr           error
	deleteErr        error
	deleteCount      int64
	deletedMessageID uint
	incrementDeltas  []int
}

func (s *messageDeleteRepositoryStub) GetMessageByPublicIDForUser(_ context.Context, _ uint, publicID string) (*model.Message, error) {
	if s.getErr != nil {
		return nil, s.getErr
	}
	if s.message == nil || s.message.PublicID != publicID {
		return nil, repository.ErrNotFound
	}
	return s.message, nil
}

func (s *messageDeleteRepositoryStub) DeleteMessageSubtree(_ context.Context, _ uint, _ uint, messageID uint) (int64, error) {
	if s.deleteErr != nil {
		return 0, s.deleteErr
	}
	s.deletedMessageID = messageID
	return s.deleteCount, nil
}

func (s *messageDeleteRepositoryStub) IncrementMessageCount(_ context.Context, _ uint, delta int) error {
	s.incrementDeltas = append(s.incrementDeltas, delta)
	return nil
}

func buildDeleteTargetMessage(role string, status string) *model.Message {
	return &model.Message{
		ID:             42,
		ConversationID: 7,
		UserID:         3,
		PublicID:       "message_target",
		Role:           role,
		Status:         status,
	}
}

func TestDeleteMessageRejectsUnsupportedTarget(t *testing.T) {
	// 仅支持 user 提问与 assistant 回复；system/tool 等角色不可作为删除目标。
	repo := &messageDeleteRepositoryStub{message: buildDeleteTargetMessage("system", "success")}
	service := &Service{repo: repo, logger: zap.NewNop()}

	_, err := service.DeleteMessage(context.Background(), 3, "message_target")
	if !errors.Is(err, ErrMessageDeleteTargetInvalid) {
		t.Fatalf("expected ErrMessageDeleteTargetInvalid, got %v", err)
	}
	if repo.deletedMessageID != 0 {
		t.Fatalf("expected no deletion, got messageID=%d", repo.deletedMessageID)
	}
}

func TestDeleteMessageAllowsUserQuestion(t *testing.T) {
	// 回复全被删光后悬空的 user 提问可删；有回复时级联（由子树删除保证）。
	repo := &messageDeleteRepositoryStub{
		message:     buildDeleteTargetMessage("user", "success"),
		deleteCount: 3,
	}
	service := &Service{repo: repo, logger: zap.NewNop()}

	result, err := service.DeleteMessage(context.Background(), 3, "message_target")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.deletedMessageID != 42 {
		t.Fatalf("expected subtree deletion rooted at 42, got %d", repo.deletedMessageID)
	}
	if result.DeletedMessages != 3 {
		t.Fatalf("expected 3 deleted messages, got %d", result.DeletedMessages)
	}
	if len(repo.incrementDeltas) != 1 || repo.incrementDeltas[0] != -3 {
		t.Fatalf("expected message count decrement -3, got %+v", repo.incrementDeltas)
	}
}

func TestDeleteMessageRejectsPendingTarget(t *testing.T) {
	repo := &messageDeleteRepositoryStub{message: buildDeleteTargetMessage("assistant", "pending")}
	service := &Service{repo: repo, logger: zap.NewNop()}

	_, err := service.DeleteMessage(context.Background(), 3, "message_target")
	if !errors.Is(err, ErrMessageDeleteTargetActive) {
		t.Fatalf("expected ErrMessageDeleteTargetActive, got %v", err)
	}
	if repo.deletedMessageID != 0 {
		t.Fatalf("expected no deletion, got messageID=%d", repo.deletedMessageID)
	}
}

func TestDeleteMessageMissingTarget(t *testing.T) {
	repo := &messageDeleteRepositoryStub{}
	service := &Service{repo: repo, logger: zap.NewNop()}

	_, err := service.DeleteMessage(context.Background(), 3, "missing")
	if !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("expected ErrMessageNotFound, got %v", err)
	}
	if _, err := service.DeleteMessage(context.Background(), 3, "  "); err == nil {
		t.Fatal("expected error for blank public id")
	}
}

func TestDeleteMessageRejectsActiveDescendantInSubtree(t *testing.T) {
	// 根节点已完成，但删除事务内 BFS 发现子树存在 pending 后代（追问下正在生成的回复）。
	repo := &messageDeleteRepositoryStub{
		message:   buildDeleteTargetMessage("assistant", "success"),
		deleteErr: repository.ErrMessageSubtreeHasActive,
	}
	service := &Service{repo: repo, logger: zap.NewNop()}

	_, err := service.DeleteMessage(context.Background(), 3, "message_target")
	if !errors.Is(err, ErrMessageDeleteTargetActive) {
		t.Fatalf("expected ErrMessageDeleteTargetActive, got %v", err)
	}
	if len(repo.incrementDeltas) != 0 {
		t.Fatalf("expected no count update, got %+v", repo.incrementDeltas)
	}
}

func TestDeleteMessageDeletesSubtreeAndDecrementsCount(t *testing.T) {
	repo := &messageDeleteRepositoryStub{
		message:     buildDeleteTargetMessage("assistant", "success"),
		deleteCount: 5,
	}
	service := &Service{repo: repo, logger: zap.NewNop()}

	result, err := service.DeleteMessage(context.Background(), 3, "message_target")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.deletedMessageID != 42 {
		t.Fatalf("expected subtree deletion rooted at 42, got %d", repo.deletedMessageID)
	}
	if result.DeletedMessages != 5 {
		t.Fatalf("expected 5 deleted messages, got %d", result.DeletedMessages)
	}
	if len(repo.incrementDeltas) != 1 || repo.incrementDeltas[0] != -5 {
		t.Fatalf("expected message count decrement -5, got %+v", repo.incrementDeltas)
	}
}

func TestDeleteMessageSkipsCountUpdateWhenNothingDeleted(t *testing.T) {
	repo := &messageDeleteRepositoryStub{
		message:     buildDeleteTargetMessage("assistant", "error"),
		deleteCount: 0,
	}
	service := &Service{repo: repo, logger: zap.NewNop()}

	if _, err := service.DeleteMessage(context.Background(), 3, "message_target"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(repo.incrementDeltas) != 0 {
		t.Fatalf("expected no count update, got %+v", repo.incrementDeltas)
	}
}

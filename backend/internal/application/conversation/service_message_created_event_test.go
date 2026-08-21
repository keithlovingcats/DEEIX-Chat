package conversation

import (
	"context"
	"testing"

	appcompact "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/compact"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"go.uber.org/zap"
)

// streamEventRecorder 按顺序记录 OnEvent 事件，用于断言事件时序。
type streamEventRecorder struct {
	events []struct {
		eventType string
		payload   map[string]interface{}
	}
}

func (r *streamEventRecorder) onEvent(eventType string, payload map[string]interface{}) error {
	r.events = append(r.events, struct {
		eventType string
		payload   map[string]interface{}
	}{eventType, payload})
	return nil
}

func (r *streamEventRecorder) find(eventType string) int {
	for index, item := range r.events {
		if item.eventType == eventType {
			return index
		}
	}
	return -1
}

func (r *rejectedMessageRepositoryStub) UpdateMessageState(
	_ context.Context,
	messageID uint,
	status string,
	errorCode string,
	errorMessage string,
) error {
	if r.userMessage != nil && r.userMessage.ID == messageID {
		r.userMessage.Status = status
		r.userMessage.ErrorCode = errorCode
		r.userMessage.ErrorMessage = errorMessage
	}
	return nil
}

func (r *rejectedMessageRepositoryStub) CreateRun(_ context.Context, _ *model.Run) error {
	return nil
}

func (r *rejectedMessageRepositoryStub) UpsertConversationRun(_ context.Context, _ *model.Run) error {
	return nil
}

func (r *rejectedMessageRepositoryStub) UpdateMessageProcessTrace(_ context.Context, _ uint, _ string, _ []byte) error {
	return nil
}

func (r *rejectedMessageRepositoryStub) ListMessagesByRunID(context.Context, uint, string) ([]model.Message, error) {
	return nil, nil
}

// TestStreamMessageEmitsMessageCreatedBeforeUpstream 验证流式发送在消息对落库后立即
// 广播 message_created（先于上游调用；本用例中路由未配置，上游必然未启动）。
func TestStreamMessageEmitsMessageCreatedBeforeUpstream(t *testing.T) {
	runtimeCfg := config.NewRuntime(config.Config{MaxMessageFiles: 10})
	repo := &rejectedMessageRepositoryStub{
		conversation: model.Conversation{
			ID:       7,
			UserID:   9,
			PublicID: "conversation-7",
			Title:    "New chat",
			Model:    "gpt-test",
		},
	}
	logger := zap.NewNop()
	service := &Service{
		cfg:              runtimeCfg,
		repo:             repo,
		logger:           logger,
		generationStreams: newGenerationStreamRegistry(nil, defaultGenerationStreamOptions()),
	}
	service.compactSvc = appcompact.NewServiceWithRuntime(runtimeCfg, repo, logger)

	recorder := &streamEventRecorder{}
	input := SendMessageInput{
		UserID:            9,
		ConversationID:    7,
		ContentType:       "text",
		Content:           "hello parallel models",
		PlatformModelName: "gpt-test",
		ClientRunID:       "run_parallel_test",
		BranchReason:      "default",
		OnEvent:           recorder.onEvent,
	}

	// 路由未配置：sendMessageInternal 必然在进入上游调用前返回错误，
	// 但 message_created 在 route check 之前已发射。
	_, _ = service.StreamMessage(context.Background(), input, func(string) error { return nil })

	createdIndex := recorder.find("message_created")
	if createdIndex < 0 {
		t.Fatal("message_created event was not emitted during stream send")
	}
	created := recorder.events[createdIndex].payload
	userMessage, _ := created["userMessage"].(map[string]interface{})
	assistantMessage, _ := created["assistantMessage"].(map[string]interface{})
	if userMessage == nil || assistantMessage == nil {
		t.Fatalf("message_created payload missing messages: %+v", created)
	}
	if userMessage["publicID"] == nil || userMessage["publicID"].(string) == "" {
		t.Fatalf("message_created user publicID missing: %+v", userMessage)
	}
	if assistantMessage["publicID"] == nil || assistantMessage["publicID"].(string) == "" {
		t.Fatalf("message_created assistant publicID missing: %+v", assistantMessage)
	}
	if userMessage["publicID"].(string) == assistantMessage["publicID"].(string) {
		t.Fatalf("user and assistant publicIDs should differ: %v", userMessage["publicID"])
	}
	if assistantMessage["parentPublicID"] != userMessage["publicID"] {
		t.Fatalf(
			"assistant parentPublicID = %v, want user publicID %v",
			assistantMessage["parentPublicID"],
			userMessage["publicID"],
		)
	}
	if userMessage["role"] != "user" || assistantMessage["role"] != "assistant" {
		t.Fatalf("message roles = (%v, %v)", userMessage["role"], assistantMessage["role"])
	}
	if assistantMessage["runID"] != "run_parallel_test" {
		t.Fatalf("assistant runID = %v, want run_parallel_test", assistantMessage["runID"])
	}
	// 落库的消息与事件中的 publicID 必须一致，fan-out 请求据此建立分支关系。
	if repo.userMessage == nil || repo.userMessage.PublicID != userMessage["publicID"].(string) {
		t.Fatalf("persisted user publicID = %v, want %v", repo.userMessage.PublicID, userMessage["publicID"])
	}
	if repo.assistantMessage == nil || repo.assistantMessage.PublicID != assistantMessage["publicID"].(string) {
		t.Fatalf(
			"persisted assistant publicID = %v, want %v",
			repo.assistantMessage.PublicID,
			assistantMessage["publicID"],
		)
	}
}

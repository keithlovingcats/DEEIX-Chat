package conversation

import (
	"context"
	"errors"
	"strings"
	"testing"

	appbilling "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/billing"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"go.uber.org/zap"
)

type rejectedMessageRepositoryStub struct {
	repository.ConversationRepository
	conversation      model.Conversation
	userMessage       *model.Message
	assistantMessage  *model.Message
	attachments       []model.Attachment
	metadataPatch     repository.ConversationMetadataPatch
	pairCreateCalls   int
	branchCreateCalls int
}

func (r *rejectedMessageRepositoryStub) GetConversationByUser(_ context.Context, conversationID uint, userID uint) (*model.Conversation, error) {
	if r.conversation.ID != conversationID || r.conversation.UserID != userID {
		return nil, repository.ErrNotFound
	}
	item := r.conversation
	return &item, nil
}

func (r *rejectedMessageRepositoryStub) ListLatestBranchPreviewMessages(context.Context, uint, int, int) ([]model.Message, error) {
	return nil, nil
}

func (r *rejectedMessageRepositoryStub) CreateMessagePairWithUserAttachments(
	_ context.Context,
	userMessage *model.Message,
	assistantMessage *model.Message,
	attachments []model.Attachment,
) error {
	r.pairCreateCalls++
	userMessage.ID = 11
	assistantMessage.ID = 12
	parentID := userMessage.ID
	assistantMessage.ParentMessageID = &parentID
	r.userMessage = userMessage
	r.assistantMessage = assistantMessage
	r.attachments = append([]model.Attachment(nil), attachments...)
	return nil
}

func (r *rejectedMessageRepositoryStub) CreateAssistantBranchMessage(
	_ context.Context,
	assistantMessage *model.Message,
) error {
	r.branchCreateCalls++
	assistantMessage.ID = 13
	r.assistantMessage = assistantMessage
	return nil
}

func (r *rejectedMessageRepositoryStub) ListAllMessages(context.Context, uint) ([]model.Message, error) {
	return []model.Message{*r.userMessage, *r.assistantMessage}, nil
}

func (r *rejectedMessageRepositoryStub) UpdateConversationMetadata(
	_ context.Context,
	_ uint,
	patch repository.ConversationMetadataPatch,
) (*model.Conversation, error) {
	r.metadataPatch = patch
	item := r.conversation
	item.Title = patch.Title
	return &item, nil
}

func TestPersistMessageUsageRejectionStoresStableFailedTurn(t *testing.T) {
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
	service := &Service{
		cfg:    runtimeCfg,
		repo:   repo,
		logger: zap.NewNop(),
	}

	err := service.PersistMessageUsageRejection(
		context.Background(),
		SendMessageInput{
			UserID:            9,
			ConversationID:    7,
			ContentType:       "text",
			Content:           "keep this failed message",
			PlatformModelName: "gpt-test",
			ClientRunID:       "run_issue_544",
			BranchReason:      "default",
		},
		appbilling.ErrUsageBalanceInsufficient,
	)
	if err != nil {
		t.Fatalf("PersistMessageUsageRejection() error = %v", err)
	}
	if repo.userMessage == nil || repo.assistantMessage == nil {
		t.Fatal("rejected turn did not persist both messages")
	}
	if repo.userMessage.Status != "error" || repo.assistantMessage.Status != "error" {
		t.Fatalf("message statuses = (%q, %q), want both error", repo.userMessage.Status, repo.assistantMessage.Status)
	}
	if repo.userMessage.Content != "keep this failed message" {
		t.Fatalf("user content = %q", repo.userMessage.Content)
	}
	if repo.userMessage.ErrorCode != messageUsageBalanceErrorCode || repo.assistantMessage.ErrorCode != messageUsageBalanceErrorCode {
		t.Fatalf("message error codes = (%q, %q)", repo.userMessage.ErrorCode, repo.assistantMessage.ErrorCode)
	}
	if repo.assistantMessage.ErrorMessage != messageUsageBalanceErrorText {
		t.Fatalf("assistant error message = %q", repo.assistantMessage.ErrorMessage)
	}
	if repo.assistantMessage.ParentMessageID == nil || *repo.assistantMessage.ParentMessageID != repo.userMessage.ID {
		t.Fatal("assistant message is not attached to the rejected user message")
	}
	if repo.pairCreateCalls != 1 || repo.branchCreateCalls != 0 {
		t.Fatalf("repository create calls = pair:%d branch:%d", repo.pairCreateCalls, repo.branchCreateCalls)
	}
	wantTitle := conversationTitleFromFirstUserMessage("keep this failed message")
	if repo.metadataPatch.Title != wantTitle {
		t.Fatalf("fallback title = %q", repo.metadataPatch.Title)
	}
}

func TestShouldPersistMessageUsageRejection(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "insufficient balance", err: appbilling.ErrUsageBalanceInsufficient, want: true},
		{name: "wrapped insufficient balance", err: errors.Join(errors.New("authorize usage"), appbilling.ErrUsageBalanceInsufficient), want: true},
		{name: "concurrency limit", err: appbilling.ErrUsageConcurrencyLimitExceeded, want: false},
		{name: "reservation conflict", err: appbilling.ErrUsageReservationConflict, want: false},
		{name: "pricing missing", err: appbilling.ErrModelPricingRequired, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldPersistMessageUsageRejection(tt.err); got != tt.want {
				t.Fatalf("shouldPersistMessageUsageRejection() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestPersistMessageUsageRejectionLeavesRetryableFailuresSideEffectFree(t *testing.T) {
	service := &Service{}
	for _, err := range []error{
		appbilling.ErrUsageConcurrencyLimitExceeded,
		appbilling.ErrUsageReservationConflict,
		appbilling.ErrModelPricingRequired,
	} {
		if persistErr := service.PersistMessageUsageRejection(context.Background(), SendMessageInput{}, err); persistErr != nil {
			t.Fatalf("PersistMessageUsageRejection(%v) error = %v", err, persistErr)
		}
	}
}

func TestCreateRejectedAssistantRetryReusesExistingUserMessage(t *testing.T) {
	repo := &rejectedMessageRepositoryStub{}
	service := &Service{repo: repo}
	existingUser := &model.Message{
		ID:             21,
		ConversationID: 7,
		UserID:         9,
		PublicID:       "msg_existing_user",
		Role:           "user",
		ContentType:    "text",
		Content:        "retry this message",
		Status:         "error",
	}
	sourceAssistantID := uint(22)

	pair, err := service.createMessagePair(
		context.Background(),
		SendMessageInput{UserID: 9, ConversationID: 7, Content: existingUser.Content},
		"run_retry_issue_544",
		&messageSendBranchPreparation{
			branchState: &messageBranchState{
				SourceMessageID:  &sourceAssistantID,
				SourcePublicID:   "msg_failed_assistant",
				ReuseUserMessage: existingUser,
			},
			normalizedBranchReason: "retry",
			reuseUserMessage:       true,
		},
		nil,
		&rejectedMessageState{
			errorCode:    messageUsageBalanceErrorCode,
			errorMessage: messageUsageBalanceErrorText,
		},
	)
	if err != nil {
		t.Fatalf("createMessagePair() error = %v", err)
	}
	if pair.user.ID != existingUser.ID {
		t.Fatalf("user message ID = %d, want reused ID %d", pair.user.ID, existingUser.ID)
	}
	if repo.pairCreateCalls != 0 || repo.branchCreateCalls != 1 {
		t.Fatalf("repository create calls = pair:%d branch:%d", repo.pairCreateCalls, repo.branchCreateCalls)
	}
	if pair.assistant.Status != "error" || pair.assistant.ErrorCode != messageUsageBalanceErrorCode {
		t.Fatalf("assistant rejection state = status:%q code:%q", pair.assistant.Status, pair.assistant.ErrorCode)
	}
	if pair.assistant.ParentMessageID == nil || *pair.assistant.ParentMessageID != existingUser.ID {
		t.Fatal("retry assistant is not attached to the reused user message")
	}
	if pair.assistant.SourceMessageID == nil || *pair.assistant.SourceMessageID != sourceAssistantID {
		t.Fatal("retry assistant does not reference the failed source assistant")
	}
}

type discussionBranchRepositoryStub struct {
	repository.ConversationRepository
	messagesByPublicID map[string]*model.Message
	branchCreateCalls  int
	createdAssistant   *model.Message
}

func (r *discussionBranchRepositoryStub) GetMessageByPublicID(
	_ context.Context,
	_ uint,
	_ uint,
	publicID string,
) (*model.Message, error) {
	if item, ok := r.messagesByPublicID[publicID]; ok {
		return item, nil
	}
	return nil, repository.ErrNotFound
}

func (r *discussionBranchRepositoryStub) ListMessageAncestors(
	context.Context,
	uint,
	uint,
	int,
) ([]model.Message, error) {
	return []model.Message{}, nil
}

func (r *discussionBranchRepositoryStub) CreateAssistantBranchMessage(
	_ context.Context,
	assistantMessage *model.Message,
) error {
	r.branchCreateCalls++
	assistantMessage.ID = 33
	r.createdAssistant = assistantMessage
	return nil
}

// 多模型讨论发言走 reuse 分支时，讨论 prompt（content）必须原样进入生成上下文，
// 不得回填原用户消息文本；无 DiscussionMeta 的普通 retry 保持原覆盖行为。
func TestPrepareMessageSendBranchKeepsDiscussionPromptContent(t *testing.T) {
	existingUser := &model.Message{
		ID:       21,
		PublicID: "msg_disc_user",
		Role:     "user",
		Content:  "original user question",
		Status:   "success",
	}
	sourceAssistant := &model.Message{
		ID:              22,
		PublicID:        "msg_disc_source",
		Role:            "assistant",
		Content:         "first turn answer",
		Status:          "success",
		ParentMessageID: &[]uint{21}[0],
	}
	repo := &discussionBranchRepositoryStub{
		messagesByPublicID: map[string]*model.Message{
			existingUser.PublicID:    existingUser,
			sourceAssistant.PublicID: sourceAssistant,
		},
	}
	service := &Service{repo: repo}

	discussionMeta := &model.MessageDiscussionMeta{
		DiscussionID: "disc_test",
		Round:        2,
		Role:         "participant",
		Index:        2,
		Participants: []string{"model-a", "model-b"},
		Rounds:       2,
	}

	discussionInput := SendMessageInput{
		UserID:                9,
		ConversationID:        7,
		Content:               "You are model-b, one participant in round 2 of a multi-model discussion.",
		ParentMessagePublicID: existingUser.PublicID,
		SourceMessagePublicID: sourceAssistant.PublicID,
		BranchReason:          "retry",
		DiscussionMeta:        discussionMeta,
	}
	if _, err := service.prepareMessageSendBranch(context.Background(), &discussionInput); err != nil {
		t.Fatalf("prepareMessageSendBranch() with discussion meta error = %v", err)
	}
	if discussionInput.Content == existingUser.Content {
		t.Fatal("discussion prompt content was overwritten by the reused user message")
	}
	if !strings.Contains(discussionInput.Content, "round 2 of a multi-model discussion") {
		t.Fatalf("discussion prompt content = %q", discussionInput.Content)
	}

	plainInput := SendMessageInput{
		UserID:                9,
		ConversationID:        7,
		Content:               "any retry content",
		ParentMessagePublicID: existingUser.PublicID,
		SourceMessagePublicID: sourceAssistant.PublicID,
		BranchReason:          "retry",
	}
	if _, err := service.prepareMessageSendBranch(context.Background(), &plainInput); err != nil {
		t.Fatalf("prepareMessageSendBranch() without discussion meta error = %v", err)
	}
	if plainInput.Content != existingUser.Content {
		t.Fatalf("plain retry content = %q, want reused %q", plainInput.Content, existingUser.Content)
	}
}

// 讨论发言标记随 assistant 消息透传落库（reuse 分支只建 assistant）。
func TestCreateAssistantDiscussionTurnPersistsMeta(t *testing.T) {	repo := &discussionBranchRepositoryStub{
		messagesByPublicID: map[string]*model.Message{},
	}
	service := &Service{repo: repo}
	existingUser := &model.Message{ID: 21, PublicID: "msg_disc_user", Role: "user", Content: "q"}
	sourceAssistantID := uint(22)
	meta := &model.MessageDiscussionMeta{
		DiscussionID: "disc_test_final",
		Round:        3,
		Role:         "final",
		Index:        7,
		Participants: []string{"model-a", "model-b"},
		Rounds:       2,
	}

	pair, err := service.createMessagePair(
		context.Background(),
		SendMessageInput{UserID: 9, ConversationID: 7, Content: "final prompt", DiscussionMeta: meta},
		"run_discussion_final",
		&messageSendBranchPreparation{
			branchState: &messageBranchState{
				SourceMessageID:  &sourceAssistantID,
				SourcePublicID:   "msg_disc_source",
				ReuseUserMessage: existingUser,
			},
			normalizedBranchReason: "retry",
			reuseUserMessage:       true,
		},
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("createMessagePair() error = %v", err)
	}
	if repo.branchCreateCalls != 1 {
		t.Fatalf("branchCreateCalls = %d, want 1", repo.branchCreateCalls)
	}
	if pair.assistant.DiscussionMeta == nil || pair.assistant.DiscussionMeta.DiscussionID != meta.DiscussionID {
		t.Fatalf("assistant DiscussionMeta = %+v, want %+v", pair.assistant.DiscussionMeta, meta)
	}
	if repo.createdAssistant.DiscussionMeta == nil || repo.createdAssistant.DiscussionMeta.Role != "final" {
		t.Fatal("persisted assistant message is missing the discussion meta")
	}
}

// 检索辅助通道（RAG/召回/记忆/图片处理）用原始问题而非讨论 wrapper，
// 避免 transcript 文本污染召回质量。
func TestMessageRetrievalQueryPrefersOriginalQuestionForDiscussionTurn(t *testing.T) {
	reusedUser := &model.Message{ID: 21, Role: "user", Content: "original user question"}

	discussion := messageRetrievalQuery(
		&SendMessageInput{Content: "wrapper with transcript", DiscussionMeta: &model.MessageDiscussionMeta{DiscussionID: "disc_test"}},
		&messageBranchState{ReuseUserMessage: reusedUser},
	)
	if discussion != "original user question" {
		t.Fatalf("discussion retrieval query = %q, want original user question", discussion)
	}

	// 普通 retry（无 meta）：content 已在 preparation 回填为原问题，直接使用。
	plainRetry := messageRetrievalQuery(
		&SendMessageInput{Content: "original user question"},
		&messageBranchState{ReuseUserMessage: reusedUser},
	)
	if plainRetry != "original user question" {
		t.Fatalf("plain retry retrieval query = %q, want reused content", plainRetry)
	}

	// 非 reuse 请求：本次输入即用户原始输入。
	fresh := messageRetrievalQuery(
		&SendMessageInput{Content: "brand new question"},
		&messageBranchState{},
	)
	if fresh != "brand new question" {
		t.Fatalf("fresh request retrieval query = %q, want input content", fresh)
	}

	if nilBranch := messageRetrievalQuery(&SendMessageInput{Content: "q"}, nil); nilBranch != "q" {
		t.Fatalf("nil branch retrieval query = %q, want input content", nilBranch)
	}
}

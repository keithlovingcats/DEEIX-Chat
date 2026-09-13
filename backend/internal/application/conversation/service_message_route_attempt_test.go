package conversation

import (
	"strings"
	"testing"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

func TestBuildMessageRoutePromptRebuildsRouteSpecificFields(t *testing.T) {
	service := &Service{cfg: config.NewRuntime(config.Config{})}
	domainMessages := []model.Message{
		{Role: "user", Content: "first question"},
		{Role: "assistant", Content: "first answer", ReasoningContent: "private reasoning"},
		{Role: "user", Content: "follow up"},
	}
	baseInput := messageRoutePromptInput{
		UserContent:         "follow up",
		DomainMessages:      domainMessages,
		ProjectSystemPrompt: "project policy",
		Config: config.Config{
			DefaultSystemPrompt: "platform policy",
		},
	}

	chatInput := baseInput
	chatInput.ReasoningContentPassback = true
	chatPlan, err := service.buildMessageRoutePrompt(t.Context(), &channel.ResolvedRoute{
		Protocol:      llm.AdapterOpenAIChatCompletions,
		UpstreamModel: "deepseek-chat",
	}, chatInput)
	if err != nil {
		t.Fatalf("build chat prompt: %v", err)
	}
	if len(chatPlan.Messages) < 4 || chatPlan.Messages[0].Role != "system" {
		t.Fatalf("expected native system prompt, got %#v", chatPlan.Messages)
	}
	if chatPlan.Messages[2].ReasoningContent != "private reasoning" {
		t.Fatalf("expected reasoning passback, got %#v", chatPlan.Messages[2])
	}

	interactionInput := baseInput
	interactionPlan, err := service.buildMessageRoutePrompt(t.Context(), &channel.ResolvedRoute{
		Protocol:      llm.AdapterGeminiInteractions,
		UpstreamModel: "gemini-2.5-pro",
	}, interactionInput)
	if err != nil {
		t.Fatalf("build interaction prompt: %v", err)
	}
	for _, message := range interactionPlan.Messages {
		if message.Role == "system" {
			t.Fatalf("expected system prompt to be inlined, got %#v", interactionPlan.Messages)
		}
		if message.Role == "assistant" && message.ReasoningContent != "" {
			t.Fatalf("expected reasoning to be removed, got %#v", message)
		}
	}
	latest := interactionPlan.Messages[len(interactionPlan.Messages)-1]
	if latest.Role != "user" || !strings.Contains(latest.Content, "platform policy") || !strings.Contains(latest.Content, "follow up") {
		t.Fatalf("expected inlined system prompt on latest user message, got %#v", latest)
	}
}

// 讨论发言（带 DiscussionMeta 的 retry）复用原 user 消息，本次 content（讨论 prompt，
// 含 transcript）未落库；必须覆盖链尾 user 文本才能进入生成上下文，且不得追加出
// 连续两条 user 消息。无标志的普通请求保持原行为（不覆盖、不追加）。
func TestBuildMessageRoutePromptOverridesReusedUserContentForDiscussionTurn(t *testing.T) {
	service := &Service{cfg: config.NewRuntime(config.Config{})}
	// reuse 分支链：历史问答 + 复用的 user 消息（原问题文本）。
	domainMessages := []model.Message{
		{Role: "user", Content: "earlier question", Status: "success"},
		{Role: "assistant", Content: "earlier answer", Status: "success"},
		{Role: "user", Content: "original user question", Status: "success"},
	}
	wrapper := "You are model-b, one participant in round 2 of a multi-model discussion.\n\n" +
		"User question:\noriginal user question\n\n" +
		"Previous discussion:\nRound 1\n- model-a: answer a"

	plan, err := service.buildMessageRoutePrompt(t.Context(), nil, messageRoutePromptInput{
		UserContent:               wrapper,
		DomainMessages:            domainMessages,
		SkipImageAttachments:      true,
		OverrideReusedUserContent: true,
	})
	if err != nil {
		t.Fatalf("buildMessageRoutePrompt() error = %v", err)
	}
	userCount := 0
	for _, message := range plan.Messages {
		if message.Role != "user" {
			continue
		}
		userCount++
	}
	if userCount != 2 {
		t.Fatalf("user message count = %d, want 2 (历史 + 被覆盖的链尾), messages = %#v", userCount, plan.Messages)
	}
	latest := plan.Messages[len(plan.Messages)-1]
	if latest.Role != "user" || latest.Content != wrapper {
		t.Fatalf("latest message = (%s, %q), want discussion wrapper on reused user slot", latest.Role, latest.Content)
	}
	if !strings.Contains(latest.Content, "- model-a: answer a") {
		t.Fatal("discussion transcript did not reach the generation context")
	}

	// 回归：普通请求（reuse 不带 meta / 非 reuse）不受影响，链尾保持原问题。
	plainPlan, err := service.buildMessageRoutePrompt(t.Context(), nil, messageRoutePromptInput{
		UserContent:          wrapper,
		DomainMessages:       domainMessages,
		SkipImageAttachments: true,
	})
	if err != nil {
		t.Fatalf("buildMessageRoutePrompt() plain error = %v", err)
	}
	for _, message := range plainPlan.Messages {
		if strings.Contains(message.Content, "multi-model discussion") {
			t.Fatalf("discussion wrapper leaked into plain request: %#v", message)
		}
	}
	plainLatest := plainPlan.Messages[len(plainPlan.Messages)-1]
	if plainLatest.Content != "original user question" {
		t.Fatalf("plain latest user content = %q, want reused original question", plainLatest.Content)
	}
}

// replaceLastUserMessageContent 仅覆盖文本，保留消息上已注入的多模态 Parts；
// 无 user 消息时退化为追加，保证输入不丢失。
func TestReplaceLastUserMessageContent(t *testing.T) {
	withParts := []llm.Message{
		{Role: "assistant", Content: "answer"},
		{Role: "user", Content: "old question", Parts: []llm.ContentPart{{Kind: llm.ContentPartImage, MimeType: "image/png", Data: []byte("png-bytes")}}},
	}
	got := replaceLastUserMessageContent(withParts, "wrapper prompt")
	if got[1].Content != "wrapper prompt" {
		t.Fatalf("content = %q, want wrapper prompt", got[1].Content)
	}
	if len(got[1].Parts) != 1 || string(got[1].Parts[0].Data) != "png-bytes" {
		t.Fatalf("image parts were dropped: %#v", got[1].Parts)
	}

	noUser := []llm.Message{{Role: "assistant", Content: "answer"}}
	appended := replaceLastUserMessageContent(noUser, "wrapper prompt")
	if len(appended) != 2 || appended[1].Role != "user" || appended[1].Content != "wrapper prompt" {
		t.Fatalf("append fallback = %#v", appended)
	}
}

func TestWithMessageRouteReasoningPassbackOptions(t *testing.T) {
	route := &channel.ResolvedRoute{
		ReasoningPassbackRequestOptions: map[string]any{
			"preserve_thinking": true,
		},
	}
	messages := []llm.Message{{Role: "assistant", ReasoningContent: "historical reasoning"}}

	got := withMessageRouteReasoningPassbackOptions(nil, nil, route, true, messages)
	if got["preserve_thinking"] != true {
		t.Fatalf("expected fallback route reasoning option, got %#v", got)
	}

	explicit := withMessageRouteReasoningPassbackOptions(
		nil,
		map[string]any{"preserve_thinking": false},
		route,
		true,
		messages,
	)
	if _, ok := explicit["preserve_thinking"]; ok {
		t.Fatalf("expected explicit option to prevent automatic override, got %#v", explicit)
	}

	withoutHistory := withMessageRouteReasoningPassbackOptions(nil, nil, route, true, []llm.Message{{Role: "user", Content: "hello"}})
	if _, ok := withoutHistory["preserve_thinking"]; ok {
		t.Fatalf("expected no option without historical reasoning, got %#v", withoutHistory)
	}
}

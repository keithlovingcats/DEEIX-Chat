package conversation

import (
	"context"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

type messageRoutePromptInput struct {
	UserContent              string
	ProjectSystemPrompt      string
	HTMLVisualPromptEnabled  bool
	ReasoningContentPassback bool
	DomainMessages           []model.Message
	StableAttachments        []AttachmentInput
	DynamicContext           userContextInput
	PreferencePrompt         string
	SkillPrompts             *skillPrompts
	ToolRuntime              selectedToolRuntime
	SkipImageAttachments     bool
	Config                   config.Config
	// OverrideReusedUserContent 表示本次请求复用了既有 user 消息（reuse 分支）且
	// 本次 content 未落库（带 DiscussionMeta 的讨论发言）。链尾 user 消息仍是
	// 原问题文本，若不覆盖，讨论 prompt（含 transcript）永远进不了生成上下文。
	OverrideReusedUserContent bool
}

func withMessageRouteReasoningPassbackOptions(
	options map[string]interface{},
	inputOptions map[string]interface{},
	route *channel.ResolvedRoute,
	reasoningContentPassback bool,
	messages []llm.Message,
) map[string]interface{} {
	if route == nil || !shouldApplyReasoningPassbackRequestOptions(
		reasoningContentPassback,
		route.ReasoningPassbackRequestOptions,
		messages,
	) {
		return options
	}
	return withReasoningPassbackRequestOptions(
		options,
		route.ReasoningPassbackRequestOptions,
		inputOptions,
		route.ModelCapabilitiesJSON,
	)
}

func (s *Service) buildMessageRoutePrompt(ctx context.Context, route *channel.ResolvedRoute, input messageRoutePromptInput) (PromptPlan, error) {
	// 模型上下文预算在最终 GenerateInput 完整组装后统一执行。这里保留完整活跃
	// 分支，避免先按历史消息耗尽预算，再遗漏文件、RAG、Skill 与工具定义开销。
	routeMessages := input.DomainMessages
	historyMessages := historyMessagesFromDomain(routeMessages, historyMessageOptions{
		ReasoningContentPassback: input.ReasoningContentPassback,
	})
	if !input.SkipImageAttachments {
		var err error
		historyMessages, err = s.injectConversationImageContext(ctx, historyMessages, routeMessages, input.StableAttachments, input.Config)
		if err != nil {
			return PromptPlan{}, err
		}
	}
	if input.OverrideReusedUserContent {
		// 讨论 prompt 内已含用户原问题，替换链尾（而非追加）避免重复，
		// 也避免 Anthropic 协议下连续两条 user 消息；只覆盖文本，保留注入的图片 Parts。
		historyMessages = replaceLastUserMessageContent(historyMessages, input.UserContent)
	} else if len(historyMessages) == 0 {
		historyMessages = append(historyMessages, llm.Message{Role: "user", Content: input.UserContent})
	}

	// ContextAssembler 只负责稳定的槽位排序与去重；最终模型窗口由完整请求预算器
	// 统一约束，避免旧的固定 32K 上限提前丢弃偏好等系统上下文。
	assembler := NewContextAssembler(0)
	systemPrompt := resolveMessageSystemPromptInjection(input.Config, route, input.ProjectSystemPrompt, input.HTMLVisualPromptEnabled)
	if systemPrompt.Content != "" {
		if systemPrompt.InlineToUser {
			historyMessages = inlineSystemPromptIntoLatestUserMessage(historyMessages, systemPrompt.Content)
		} else {
			assembler.Add(ContextSlot{Kind: SlotSystemPrompt, Content: systemPrompt.Content, Required: true})
		}
	}
	if input.PreferencePrompt != "" {
		assembler.Add(ContextSlot{Kind: SlotPreference, Content: input.PreferencePrompt})
	}
	baseMessages, _ := assembler.Assemble(historyMessages)
	return buildPromptPlan(ctx, promptPlanInput{
		BaseMessages:      baseMessages,
		StableAttachments: input.StableAttachments,
		DynamicContext:    input.DynamicContext,
		SkillPrompts:      input.SkillPrompts,
		ToolRuntime:       input.ToolRuntime,
		Config:            input.Config,
		StoreProvider:     s.storeProvider,
	}), nil
}

// replaceLastUserMessageContent 把最后一条 user 消息的文本替换为本次生成输入，
// 供复用 user 消息且本次 content 未落库的请求（讨论发言）把讨论 prompt 送进
// 生成上下文；仅覆盖 Content，保留消息上已注入的多模态 Parts。找不到 user
// 消息时退化为追加，保证输入不丢失。
func replaceLastUserMessageContent(messages []llm.Message, content string) []llm.Message {
	for index := len(messages) - 1; index >= 0; index -= 1 {
		if messages[index].Role == "user" {
			messages[index].Content = content
			return messages
		}
	}
	return append(messages, llm.Message{Role: "user", Content: content})
}

package conversation

import "testing"

// 空白 discussionID/role 在 trim 后必须被拦截：否则写侧持久化空 ID、
// 读侧 parseMessageDiscussionMeta 判非法丢弃，meta 静默消失。
func TestToMessageDiscussionMetaInputRejectsBlankAfterTrim(t *testing.T) {
	if got := toMessageDiscussionMetaInput(nil); got != nil {
		t.Fatalf("nil request should yield nil meta, got %+v", got)
	}
	if got := toMessageDiscussionMetaInput(&MessageDiscussionMetaRequest{
		DiscussionID: "   ",
		Round:        1,
		Role:         "participant",
	}); got != nil {
		t.Fatalf("whitespace discussionID should yield nil meta, got %+v", got)
	}
	meta := toMessageDiscussionMetaInput(&MessageDiscussionMetaRequest{
		DiscussionID: " disc_test ",
		Round:        2,
		Role:         "final",
		Index:        3,
		Participants: []string{" model-a ", "", "model-b"},
		Rounds:       2,
	})
	if meta == nil {
		t.Fatal("valid request should yield meta")
	}
	if meta.DiscussionID != "disc_test" || meta.Role != "final" || meta.Round != 2 || meta.Index != 3 {
		t.Fatalf("meta fields not normalized: %+v", meta)
	}
	if len(meta.Participants) != 2 || meta.Participants[0] != "model-a" || meta.Participants[1] != "model-b" {
		t.Fatalf("participants not trimmed/filtered: %+v", meta.Participants)
	}
}

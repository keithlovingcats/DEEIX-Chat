package globalchat

import (
	"testing"
)

func TestHubBroadcastDeliversToAllSubscribers(t *testing.T) {
	hub := NewHub(nil)
	eventsA, okA, cancelA := hub.Subscribe(1)
	eventsB, okB, cancelB := hub.Subscribe(2)
	defer cancelB()
	defer cancelA()
	if !okA || !okB {
		t.Fatalf("Subscribe() ok = %v, %v; want true, true", okA, okB)
	}

	hub.Broadcast(HubEvent{Type: EventMessage, Data: "hello"})

	for name, ch := range map[string]<-chan HubEvent{"A": eventsA, "B": eventsB} {
		event := nextDataEvent(t, ch)
		if event.Type != EventMessage {
			t.Fatalf("subscriber %s event type = %q, want %q", name, event.Type, EventMessage)
		}
	}
}

// nextDataEvent 跳过订阅时入队的 online_count 事件，返回首个业务事件。
func nextDataEvent(t *testing.T, ch <-chan HubEvent) HubEvent {
	t.Helper()
	for {
		select {
		case event := <-ch:
			if event.Type == EventOnlineCount {
				continue
			}
			return event
		default:
			t.Fatal("expected a data event but channel is empty")
			return HubEvent{}
		}
	}
}

func TestHubOnlineCountDeduplicatesUsers(t *testing.T) {
	hub := NewHub(nil)
	if count := hub.OnlineCount(); count != 0 {
		t.Fatalf("OnlineCount() = %d, want 0", count)
	}

	_, _, cancelA := hub.Subscribe(1)
	_, okB, _ := hub.Subscribe(1)
	defer cancelA()
	if !okB {
		t.Fatal("second connection of same user should be accepted")
	}
	if count := hub.OnlineCount(); count != 1 {
		t.Fatalf("OnlineCount() = %d, want 1 (deduplicated)", count)
	}
}

func TestHubCancelIsIdempotent(t *testing.T) {
	hub := NewHub(nil)
	_, _, cancel := hub.Subscribe(1)

	cancel()
	cancel()

	if count := hub.OnlineCount(); count != 0 {
		t.Fatalf("OnlineCount() after cancel = %d, want 0", count)
	}
}

func TestHubSubscribeBroadcastsOnlineCount(t *testing.T) {
	hub := NewHub(nil)
	events, _, cancel := hub.Subscribe(1)
	defer cancel()

	select {
	case event := <-events:
		if event.Type != EventOnlineCount {
			t.Fatalf("first event type = %q, want %q", event.Type, EventOnlineCount)
		}
	default:
		t.Fatal("subscribe did not deliver online_count event")
	}
}

func TestHubDropsSlowSubscriber(t *testing.T) {
	hub := NewHub(nil)
	events, _, cancel := hub.Subscribe(1)
	_ = cancel

	// 填满缓冲后继续广播，慢订阅者应被断开（channel 关闭）。
	for i := 0; i < 3*subscriberBuffer; i++ {
		hub.Broadcast(HubEvent{Type: EventHeartbeat, Data: i})
	}
	// 排空已缓冲事件后应观察到关闭。
	drained := false
	for range events {
		drained = true
	}
	if !drained {
		t.Fatal("expected at least one buffered event before close")
	}
	if count := hub.OnlineCount(); count != 0 {
		t.Fatalf("OnlineCount() after slow-subscriber drop = %d, want 0", count)
	}
}

func TestHubConnectionLimit(t *testing.T) {
	hub := NewHub(nil)
	hub.maxConns = 2

	if _, ok, _ := hub.Subscribe(1); !ok {
		t.Fatal("first connection should be accepted")
	}
	if _, ok, _ := hub.Subscribe(2); !ok {
		t.Fatal("second connection should be accepted")
	}
	if _, ok, cancel := hub.Subscribe(3); ok {
		cancel()
		t.Fatal("third connection should be rejected above limit")
	} else {
		cancel()
	}
	if count := hub.OnlineCount(); count != 2 {
		t.Fatalf("OnlineCount() = %d, want 2", count)
	}
}

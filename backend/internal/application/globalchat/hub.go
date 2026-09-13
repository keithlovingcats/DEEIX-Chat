package globalchat

import (
	"sync"

	"go.uber.org/zap"
)

// NDJSON 流事件类型。
const (
	EventMessage        = "message"
	EventMessageDeleted = "message_deleted"
	EventOnlineCount    = "online_count"
	EventHeartbeat      = "heartbeat"
	EventResync         = "resync"
)

// Hub 事件是广播给订阅者的领域事件；NDJSON 序列化形状由 transport 层决定。
type HubEvent struct {
	Type string
	Data any
}

const (
	// subscriberBuffer 是单个订阅者 channel 缓冲上限，
	// 与 conversation generation stream 的订阅者缓冲保持一致。
	subscriberBuffer = 128
	// defaultMaxConnections 是进程内最大并发长连接数。
	defaultMaxConnections = 5000
)

// Hub 管理全服聊天 NDJSON 长连接订阅者，进程内广播。
// 多实例部署需引入跨实例同步，本期仅支持单实例。
type Hub struct {
	mu       sync.Mutex
	clients  map[uint]map[chan HubEvent]struct{}
	logger   *zap.Logger
	maxConns int
}

// NewHub 创建广播中心。
func NewHub(logger *zap.Logger) *Hub {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Hub{
		clients:  make(map[uint]map[chan HubEvent]struct{}),
		logger:   logger,
		maxConns: defaultMaxConnections,
	}
}

// Subscribe 订阅全局事件流。返回 false 表示超过最大连接数上限。
// 返回的取消函数幂等，可重复调用。
func (h *Hub) Subscribe(userID uint) (<-chan HubEvent, bool, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.connectionCountLocked() >= h.maxConns {
		return nil, false, func() {}
	}
	ch := make(chan HubEvent, subscriberBuffer)
	if h.clients[userID] == nil {
		h.clients[userID] = make(map[chan HubEvent]struct{})
	}
	h.clients[userID][ch] = struct{}{}
	unsubscribed := false
	cancel := func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if unsubscribed {
			return
		}
		unsubscribed = true
		h.removeLocked(userID, ch)
		h.broadcastOnlineCountLocked()
	}
	h.broadcastOnlineCountLocked()
	return ch, true, cancel
}

// Broadcast 向所有订阅者广播事件。慢消费者（缓冲已满）会被断开，
// 由客户端断线重连 + after_id 回放自愈。
func (h *Hub) Broadcast(event HubEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.broadcastLocked(event)
}

// OnlineCount 返回去重后的在线用户数。
func (h *Hub) OnlineCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

// connectionCountLocked 返回当前总连接数（调用方持锁）。
func (h *Hub) connectionCountLocked() int {
	count := 0
	for _, channels := range h.clients {
		count += len(channels)
	}
	return count
}

// broadcastOnlineCountLocked 广播在线人数变更（调用方持锁）。
func (h *Hub) broadcastOnlineCountLocked() {
	h.broadcastLocked(HubEvent{
		Type: EventOnlineCount,
		Data: map[string]int{"count": len(h.clients)},
	})
}

// broadcastLocked 逐个发送事件，断开慢消费者（调用方持锁）。
func (h *Hub) broadcastLocked(event HubEvent) {
	for userID, channels := range h.clients {
		for ch := range channels {
			select {
			case ch <- event:
			default:
				h.logger.Warn("global chat hub: drop slow subscriber",
					zap.Uint("userID", userID))
				h.removeLocked(userID, ch)
				close(ch)
			}
		}
	}
}

// removeLocked 移除订阅者（调用方持锁），不关闭 channel。
func (h *Hub) removeLocked(userID uint, ch chan HubEvent) {
	channels, ok := h.clients[userID]
	if !ok {
		return
	}
	if _, exists := channels[ch]; !exists {
		return
	}
	delete(channels, ch)
	if len(channels) == 0 {
		delete(h.clients, userID)
	}
}

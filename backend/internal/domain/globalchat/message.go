package globalchat

import "time"

const (
	// MessageTypeText 表示文本消息（含 Emoji）。
	MessageTypeText = "text"
	// MessageTypeImage 表示图片消息。
	MessageTypeImage = "image"
)

// Message 表示一条全服聊天室消息。
type Message struct {
	ID          uint
	PublicID    string
	UserID      uint
	Username    string
	DisplayName string
	AvatarURL   string
	MessageType string
	Content     string
	ImageFileID string
	SessionID   string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// ImageFile 表示全服聊天图片引用的文件对象读取结果。
type ImageFile struct {
	FileID      string
	UserID      uint
	StoragePath string
	MimeType    string
	FileName    string
}

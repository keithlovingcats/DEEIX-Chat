package model

// GlobalChatMessage 记录全服聊天室消息。
type GlobalChatMessage struct {
	BaseModel
	PublicID    string `gorm:"size:32;not null;default:'';uniqueIndex:idx_global_chat_messages_public_id;comment:公开消息ID"`
	UserID      uint   `gorm:"not null;index:idx_global_chat_messages_user_id;comment:发送者用户ID"`
	Username    string `gorm:"size:64;not null;comment:发送时快照的用户名"`
	DisplayName string `gorm:"size:128;not null;default:'';comment:发送时快照的显示名称"`
	AvatarURL   string `gorm:"size:2048;not null;default:'';comment:发送时快照的头像URL"`
	MessageType string `gorm:"size:20;not null;default:'text';comment:消息类型(text/image)"`
	Content     string `gorm:"type:text;not null;comment:文本内容（含Emoji，原样存储）"`
	ImageFileID string `gorm:"size:64;not null;default:'';index:idx_global_chat_messages_image_file_id;comment:图片消息引用的文件ID"`
	SessionID   string `gorm:"size:128;not null;default:'';comment:发送时登录会话ID（同账号多设备区分）"`
}

// TableName 指定表名。
func (GlobalChatMessage) TableName() string {
	return "global_chat_messages"
}

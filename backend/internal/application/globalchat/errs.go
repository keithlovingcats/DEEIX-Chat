package globalchat

import "errors"

var (
	// ErrInvalidMessage 表示消息内容不合法。
	ErrInvalidMessage = errors.New("invalid message")
	// ErrMessageNotFound 表示消息不存在。
	ErrMessageNotFound = errors.New("message not found")
	// ErrImageFileInvalid 表示图片文件引用不合法或不属于当前用户。
	ErrImageFileInvalid = errors.New("invalid image file")
	// ErrImageFileNotFound 表示图片文件不存在。
	ErrImageFileNotFound = errors.New("image file not found")
	// ErrConnectionLimitReached 表示超过最大连接数上限。
	ErrConnectionLimitReached = errors.New("connection limit reached")
)

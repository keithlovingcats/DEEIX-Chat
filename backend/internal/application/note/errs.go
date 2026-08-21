package note

import "errors"

var (
	// ErrNoteNotFound 表示笔记不存在或当前用户无权访问。
	ErrNoteNotFound = errors.New("note not found")
	// ErrInvalidNote 表示笔记参数不合法。
	ErrInvalidNote = errors.New("invalid note")
)

// Package note 定义用户个人笔记领域对象。
package note

import "time"

// Note 表示用户的一条个人笔记（标题 + Markdown 内容）。
type Note struct {
	ID        uint
	UserID    uint
	Title     string
	Content   string
	CreatedAt time.Time
	UpdatedAt time.Time
}

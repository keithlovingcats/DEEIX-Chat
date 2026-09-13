package model

// Note 记录用户个人笔记（标题 + Markdown 内容）。
type Note struct {
	ControlPlaneModel
	UserID  uint   `gorm:"not null;default:0;index:idx_notes_user;comment:所属用户ID"`
	Title   string `gorm:"size:200;not null;default:'';comment:笔记标题"`
	Content string `gorm:"type:text;not null;default:'';comment:Markdown内容"`
}

// TableName 指定表名。
func (Note) TableName() string {
	return "notes"
}

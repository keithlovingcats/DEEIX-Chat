package note

// Module 聚合笔记 HTTP 处理器。
type Module struct {
	Handler *Handler
}

// NewModule 创建笔记 HTTP 模块。
func NewModule(handler *Handler) *Module {
	return &Module{Handler: handler}
}

package globalchat

import "github.com/gin-gonic/gin"

// RegisterRoutes 注册全服聊天用户侧路由。
func (m *Module) RegisterRoutes(authRequired *gin.RouterGroup) {
	authRequired.GET("/global-chat/messages", m.Handler.ListMessages)
	authRequired.POST("/global-chat/messages", m.Handler.SendMessage)
	authRequired.GET("/global-chat/stream", m.Handler.Stream)
	authRequired.GET("/global-chat/online-count", m.Handler.GetOnlineCount)
	authRequired.GET("/global-chat/files/:file_id/content", m.Handler.GetImageContent)
}

// RegisterAdminRoutes 注册全服聊天管理路由。
func (m *Module) RegisterAdminRoutes(adminGroup *gin.RouterGroup) {
	adminGroup.DELETE("/global-chat/messages/:id", m.Handler.DeleteMessage)
	adminGroup.POST("/global-chat/messages/batch-delete", m.Handler.BatchDeleteMessages)
}

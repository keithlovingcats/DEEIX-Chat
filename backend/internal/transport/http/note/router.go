package note

import "github.com/gin-gonic/gin"

// RegisterRoutes 注册笔记用户侧路由。
func (m *Module) RegisterRoutes(authRequired *gin.RouterGroup) {
	authRequired.GET("/notes", m.Handler.ListNotes)
	authRequired.POST("/notes", m.Handler.CreateNote)
	authRequired.GET("/notes/:id", m.Handler.GetNote)
	authRequired.PATCH("/notes/:id", m.Handler.PatchNote)
	authRequired.DELETE("/notes/:id", m.Handler.DeleteNote)
}

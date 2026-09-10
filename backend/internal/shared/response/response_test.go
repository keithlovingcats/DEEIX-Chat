package response

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestErrorWithClientMessagePassesThroughMessage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	summary := "模型请求失败（HTTP 502）\n错误：provider rejected"
	ErrorWithClientMessage(c, http.StatusBadGateway, CodeUpstreamUnavailable, summary)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusBadGateway)
	}
	var payload Envelope
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.ErrorMsg != summary {
		t.Fatalf("errorMsg = %q, want upstream summary passed through", payload.ErrorMsg)
	}
	if payload.ErrorCode != CodeUpstreamUnavailable {
		t.Fatalf("errorCode = %q, want %q", payload.ErrorCode, CodeUpstreamUnavailable)
	}
}

func TestErrorWithClientMessageInfersCodeWhenEmpty(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	ErrorWithClientMessage(c, http.StatusBadGateway, "", "model request failed")

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusBadGateway)
	}
	var payload Envelope
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.ErrorCode != CodeUpstreamUnavailable {
		t.Fatalf("errorCode = %q, want %q", payload.ErrorCode, CodeUpstreamUnavailable)
	}
}

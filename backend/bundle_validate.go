package main

import (
	"io"
	"net/http"

	"fangji/backend/reviewbundle"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const maxBundleUploadBytes = 20 << 20

// registerBundleValidation exposes a validate-only route. The handler must not
// read or write PocketBase collections; the uploaded bytes stay in memory.
func registerBundleValidation(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST("/api/fangji/bundles/validate", validateBundleUpload).Bind(
			apis.BodyLimit(maxBundleUploadBytes+1<<20),
			apis.RequireAuth("users"),
		)
		return e.Next()
	})
}

func validateBundleUpload(c *core.RequestEvent) error {
	if c.Auth == nil || c.Auth.GetBool("must_change_password") {
		return apis.NewForbiddenError("请先登录并完成初始密码修改。", nil)
	}
	uploaded, header, err := c.Request.FormFile("bundle")
	if err != nil {
		return apis.NewBadRequestError("请上传字段 bundle 中的压缩包。", nil)
	}
	defer uploaded.Close()
	if header.Size > maxBundleUploadBytes {
		return apis.NewBadRequestError("压缩包超过 20MB，已拒绝，未写入任何数据。", nil)
	}
	data, err := io.ReadAll(io.LimitReader(uploaded, maxBundleUploadBytes+1))
	if err != nil {
		return apis.NewBadRequestError("压缩包读取失败，已拒绝，未写入任何数据。", nil)
	}
	if len(data) > maxBundleUploadBytes {
		return apis.NewBadRequestError("压缩包超过 20MB，已拒绝，未写入任何数据。", nil)
	}
	report, err := reviewbundle.ValidateZip(data)
	if err != nil {
		return apis.NewBadRequestError("压缩包无法读取。已拒绝，未写入任何数据。", nil)
	}
	return c.JSON(http.StatusOK, report)
}

package main

import (
	"fmt"
	"path/filepath"

	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/require"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

// Reuse the source-review screen's authoritative completion calculation. In
// particular, source/policy changes can invalidate a basis without setting a
// convenient page flag. Do not replace this with a count of those flags.
func newTodoSourceReview(app recordReader, hooksDir string) (func([]*core.Record) (int, error), error) {
	if hooksDir == "" {
		hooksDir = filepath.Join(app.DataDir(), "..", "pb_hooks")
	}
	dir, err := filepath.Abs(hooksDir)
	if err != nil {
		return nil, err
	}
	vm := goja.New()
	new(require.Registry).Enable(vm)
	jsvm.BindCore(vm)
	jsvm.BindDbx(vm)
	jsvm.BindSecurity(vm)
	if err = vm.Set("__hooks", dir); err != nil {
		return nil, err
	}
	value, err := vm.RunString(`(function(dao,pages){
  return require(__hooks+"/lib/source_fidelity.js").countPendingReviews(dao,pages);
 })`)
	if err != nil {
		return nil, err
	}
	evaluate, ok := goja.AssertFunction(value)
	if !ok {
		return nil, fmt.Errorf("source review evaluator unavailable")
	}
	return func(pages []*core.Record) (int, error) {
		value, err := evaluate(goja.Undefined(), vm.ToValue(app), vm.ToValue(pages))
		if err != nil {
			return 0, err
		}
		return int(value.ToInteger()), nil
	}, nil
}

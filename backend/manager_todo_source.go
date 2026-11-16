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
func newTodoSourceReview(app recordReader, hooksDir string) (func(*core.Record) (bool, error), error) {
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
	value, err := vm.RunString(`(function(dao,page){
  if(!["approved","proofread","arbitration"].includes(page.getString("status"))) return false;
  // These conditions already make the existing review predicate true; avoid
  // reading text and historical judgments for rows awaiting approval.
  if(page.getString("status")!=="approved"&&!page.getBool("source_empty")) return true;
  if(page.getBool("verification_hold")||page.getBool("verification_needs_recheck")) return true;
  const item=require(__hooks+"/lib/source_fidelity.js").completion(dao,page);
  return (!item.business_complete&&!item.source_empty)||item.needs_review||item.pending_review;
 })`)
	if err != nil {
		return nil, err
	}
	evaluate, ok := goja.AssertFunction(value)
	if !ok {
		return nil, fmt.Errorf("source review evaluator unavailable")
	}
	return func(page *core.Record) (bool, error) {
		value, err := evaluate(goja.Undefined(), vm.ToValue(app), vm.ToValue(page))
		if err != nil {
			return false, err
		}
		return value.ToBoolean(), nil
	}, nil
}

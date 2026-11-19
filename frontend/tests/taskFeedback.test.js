import test from 'node:test'
import assert from 'node:assert/strict'
import { proofreadSubmitLabel, proofreadTaskFeedback } from '../src/lib/taskFeedback.js'

test('only an acknowledged submission is presented as submitted; local drafts and network recovery are not', () => {
  for (const state of [
    {},
    { draftStatus: '草稿保存中…' },
    { draftStatus: '草稿已保存于 10:22:33' },
    { online: false },
    { online: true },
    { saved: '原任务已被重新领取；本地草稿仍保留，已为你打开另一条任务。' }
  ]) {
    const feedback = proofreadTaskFeedback(state)
    assert.notEqual(feedback.kind, 'submitted')
    assert.doesNotMatch(feedback.label, /已提交/)
  }
  const submitted = proofreadTaskFeedback({
    submittedHere: true,
    saved: '该条目将由管理员继续处理。',
    claimNextFailure: true,
    online: false
  })
  assert.equal(submitted.kind, 'submitted')
  assert.match(submitted.text, /尚未领取/)
  assert.equal(submitted.detail, '该条目将由管理员继续处理。')
  const newTask = proofreadTaskFeedback({ saved: '校对已提交。' })
  assert.equal(newTask.kind, 'editing')
  assert.equal(newTask.label, '待提交')
  assert.match(newTask.text, /当前条目尚未提交/)
  assert.doesNotMatch(newTask.text, /校对已提交/)
  const continued = proofreadTaskFeedback({ previousSubmission: '该条目将由管理员继续处理。' })
  assert.equal(continued.kind, 'editing')
  assert.equal(continued.text, '上一条已提交 · 当前条目尚未提交')
  assert.equal(continued.detail, '该条目将由管理员继续处理。')
  for (const state of [{ saving: true }, { retryingClaim: true, claimNextFailure: true }]) {
    const claiming = proofreadTaskFeedback({
      submittedHere: true,
      saved: '校对已提交。',
      ...state
    })
    assert.equal(claiming.kind, 'submitted')
    assert.match(claiming.text, /正在领取下一条/)
    assert.doesNotMatch(claiming.text, /暂无|等待服务端确认|重试领取/)
  }
})

test('storage failure, source-bound old drafts, lease loss and operation failures keep distinct truthful feedback', () => {
  const disk = proofreadTaskFeedback({ draftStatus: '草稿保存失败，请勿关闭页面' })
  assert.equal(disk.kind, 'error')
  assert.match(disk.text, /避免输入丢失/)
  assert.doesNotMatch(disk.text, /已保留|已存|已保存/)
  const stale = proofreadTaskFeedback({
    draftStatus: '本机草稿来源已变化，旧值保留，未自动恢复'
  })
  assert.match(stale.text, /未自动恢复/)
  const lease = proofreadTaskFeedback({ leaseLost: true, online: false })
  assert.equal(lease.label, '租约失效')
  const error = proofreadTaskFeedback({ saveError: '来源已变化，409', online: false })
  assert.equal(error.label, '操作未完成')
  assert.match(error.text, /下方原因/)
  assert.doesNotMatch(error.text, /已保存|已提交/)
})

test('loading and read-only states do not imply editable or submitted current work', () => {
  assert.equal(proofreadTaskFeedback({ loading: true }).kind, 'loading')
  assert.equal(proofreadTaskFeedback({ hasPage: false }).kind, 'empty')
  const ownReview = proofreadTaskFeedback({ ownReview: true, draftStatus: '草稿已保存于 10:22' })
  assert.equal(ownReview.kind, 'readonly')
  assert.match(ownReview.text, /不能修改或再次提交/)
  const submitting = proofreadTaskFeedback({ saving: true, online: false })
  assert.equal(submitting.kind, 'submitting')
  assert.match(submitting.text, /等待服务端确认/)
})

test('desktop and mobile submit labels distinguish acknowledgement from claiming and never infer success from flash copy', () => {
  assert.equal(proofreadSubmitLabel({ saved: '校对已提交。' }), '检查并提交')
  assert.equal(proofreadSubmitLabel({ saving: true }), '提交中…')
  assert.equal(proofreadSubmitLabel({ submittedHere: true, saving: true }), '正在领取…')
  assert.equal(proofreadSubmitLabel({ submittedHere: true, retryingClaim: true }), '正在领取…')
  assert.equal(proofreadSubmitLabel({ submittedHere: true }), '本条已提交')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAIM_NEXT_FAILURE_NOTICE,
  IRREVERSIBLE_SUBMIT_NOTICE,
  KEYBOARD_DISCOVERY_NOTICE,
  MISSING_PDF_PAGE_NOTICE,
  dismissKeyboardHint,
  isKeyboardHintDismissed,
  missingPdfPageNotice
} from '../src/lib/proofreadNotices.js'

function memoryStorage() {
  const data = new Map()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value))
  }
}

test('irreversible submit copy stays a single confirmation', () => {
  assert.match(IRREVERSIBLE_SUBMIT_NOTICE, /不能自行撤回/)
  assert.doesNotMatch(IRREVERSIBLE_SUBMIT_NOTICE, /再次|第二步|下一步/)
})

test('keyboard discovery names the character keyboard', () => {
  assert.match(KEYBOARD_DISCOVERY_NOTICE, /字符键盘/)
  assert.match(KEYBOARD_DISCOVERY_NOTICE, /生僻字/)
})

test('claim-next failure offers hall and retry in the same sentence', () => {
  assert.match(CLAIM_NEXT_FAILURE_NOTICE, /返回大厅/)
  assert.match(CLAIM_NEXT_FAILURE_NOTICE, /再试一次领取/)
  assert.match(CLAIM_NEXT_FAILURE_NOTICE, /已经提交/)
})

test('missing pdf page explains the fallback and the risk', () => {
  assert.equal(missingPdfPageNotice(null), '')
  assert.equal(missingPdfPageNotice({ pdf_page: 3 }), '')
  assert.equal(missingPdfPageNotice({ pdf_page: 0 }), MISSING_PDF_PAGE_NOTICE)
  assert.equal(missingPdfPageNotice({}), MISSING_PDF_PAGE_NOTICE)
  assert.match(MISSING_PDF_PAGE_NOTICE, /任务序号/)
  assert.match(MISSING_PDF_PAGE_NOTICE, /原文仅供大致参考，请谨慎对照/)
})

test('keyboard hint dismissal survives a later read and ignores storage failures', () => {
  const storage = memoryStorage()
  assert.equal(isKeyboardHintDismissed(storage), false)
  dismissKeyboardHint(storage)
  assert.equal(isKeyboardHintDismissed(storage), true)
  const denied = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') }
  }
  assert.equal(isKeyboardHintDismissed(denied), false)
  assert.doesNotThrow(() => dismissKeyboardHint(denied))
})

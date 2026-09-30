export const IRREVERSIBLE_SUBMIT_NOTICE = '提交后不能自行撤回。请确认这一条已经核对完成。'

export const KEYBOARD_DISCOVERY_NOTICE = '特殊字符（生僻字、国际音标）从「字符键盘」输入。'

export const KEYBOARD_HINT_STORAGE_KEY = 'wanyu.keyboard-hint-dismissed'

export const CLAIM_NEXT_FAILURE_NOTICE = '自动领取下一条没有成功。这一条已经提交，你可以返回大厅，或再试一次领取。'

export const MISSING_PDF_PAGE_NOTICE = '此条目没有记录 PDF 页码，当前按任务序号打开原文，看到的页可能不是这一条。原文仅供大致参考，请谨慎对照。'

export function missingPdfPageNotice(page) {
  if (!page || page.pdf_page) return ''
  return MISSING_PDF_PAGE_NOTICE
}

export function isKeyboardHintDismissed(storage) {
  try {
    return storage?.getItem(KEYBOARD_HINT_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissKeyboardHint(storage) {
  try {
    storage?.setItem(KEYBOARD_HINT_STORAGE_KEY, '1')
  } catch {
    // 无痕模式写不进本地存储时，本次仍收起提示。
  }
}

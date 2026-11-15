import { nextTick, ref } from 'vue'
import { locateSpan, prepareFieldHints } from '../../lib/fieldHints.js'
import { getPageFindings } from '../../services/pagesService.js'

export function useProofreadFields({
  sourceChecked,
  saved,
  saveError,
  markChanged,
  scheduleDraftSave,
  ownReview,
  saving,
  submittedHere,
  leaseLost,
  leaseToken,
  mobile,
  overview,
  currentField,
  activeField,
  rowHeaders,
  textareaRefs,
  activeSelection,
  fieldSelections,
  insertIntoActiveField,
  selectField,
  changedFields,
  fieldHints,
  rawFindings,
  originalRow,
  locatedSpan,
  page,
  researchSession,
  findingsTruncated,
  findingsSuppressed,
  editedRow
}) {
  const findingsState = ref('idle')
  let findingsRequest
  function invalidateFindings() {
    findingsRequest?.abort()
    findingsRequest = null
    findingsState.value = 'idle'
  }

  function onTextChange() {
    sourceChecked.value = false
    saved.value = ''
    saveError.value = ''
    markChanged()
    scheduleDraftSave()
  }

  async function insertText(char) {
    if (
      ownReview.value ||
      saving.value ||
      submittedHere.value ||
      leaseLost.value ||
      !leaseToken.value
    )
      return
    if (mobile.value && overview.value) return
    const field = mobile.value ? currentField.value : activeField.value || rowHeaders.value[0]
    if (!field) return
    activeField.value = field
    const textarea = textareaRefs.get(field)
    const selection =
      activeSelection.value.field === field
        ? activeSelection.value
        : fieldSelections.get(field) || {
            start: textarea?.selectionStart,
            end: textarea?.selectionEnd
          }
    const cursor = insertIntoActiveField(char, selection)
    onTextChange()
    if (cursor == null) return
    await nextTick()
    const target = textareaRefs.get(field)
    target?.focus({ preventScroll: true })
    if (mobile.value) target?.scrollIntoView({ block: 'nearest' })
    target?.setSelectionRange(cursor, cursor)
    activeSelection.value = { field, start: cursor, end: cursor }
    fieldSelections.set(field, { ...activeSelection.value })
  }

  function setTextareaRef(header, element) {
    if (element) textareaRefs.set(header, element)
    else textareaRefs.delete(header)
  }

  function activateField(header, event) {
    rememberSelection(header, event)
  }

  function rememberSelection(header, event) {
    const target = event?.target
    const selection = {
      field: header,
      start: Number.isInteger(target?.selectionStart) ? target.selectionStart : null,
      end: Number.isInteger(target?.selectionEnd) ? target.selectionEnd : null
    }
    fieldSelections.set(header, selection)
    // A delayed blur/select from the previous field must not retarget mobile input.
    if (mobile.value && header !== currentField.value) return
    activeField.value = header
    activeSelection.value = selection
    if (!mobile.value) {
      const index = rowHeaders.value.indexOf(header)
      if (index >= 0) selectField(index)
    }
  }

  function isFieldChanged(header) {
    return changedFields.value.includes(header)
  }

  function clearHintLocation() {
    locatedSpan.value = null
  }

  async function locateHint(hint) {
    const header = hint.targetField
    const index = rowHeaders.value.indexOf(header)
    const textarea = textareaRefs.get(header)
    clearHintLocation()
    if (index < 0 || !textarea) return

    selectField(index)
    activeField.value = header
    if (hint.inputStatus !== 'different_input') {
      const source = String(originalRow.value?.[header] ?? '')
      const span = locateSpan(source, hint.evidence?.char_offsets)
      if (span) locatedSpan.value = { field: header, span }
    }
    await nextTick()
    if (textareaRefs.get(header) !== textarea) return
    const card = textarea.closest('.proofread-field')
    card?.focus({ preventScroll: true })
    card?.scrollIntoView({ block: 'nearest' })
  }

  // 无定位结果时返回 null——模板走与今天完全一致的单一文本分支。
  function sourceSegments(header) {
    if (locatedSpan.value?.field !== header) return null
    const source = String(originalRow.value?.[header] ?? '')
    const { start, end } = locatedSpan.value.span
    if (start >= end || end > source.length) return null
    const segments = []
    if (start > 0) segments.push({ text: source.slice(0, start), hit: false })
    segments.push({ text: source.slice(start, end), hit: true })
    if (end < source.length) segments.push({ text: source.slice(end), hit: false })
    return segments
  }

  async function loadFindings(pageId) {
    if (!pageId || page.value?.id !== pageId) return
    findingsRequest?.abort()
    const request = new AbortController()
    findingsRequest = request
    const current = () => findingsRequest === request && page.value?.id === pageId
    findingsState.value = 'loading'
    try {
      const result = await getPageFindings(pageId, { signal: request.signal })
      if (!current()) return
      fieldHints.value = prepareFieldHints(result.hints, rowHeaders.value)
      rawFindings.value = result.hints
      researchSession.value = result.research
      findingsTruncated.value = result.truncated
      findingsSuppressed.value = result.suppressedByGate
      findingsState.value = 'ready'
    } catch {
      if (current()) findingsState.value = 'error'
    } finally {
      if (findingsRequest === request) findingsRequest = null
    }
  }

  async function restoreField(header) {
    if (!isFieldChanged(header)) return
    editedRow.value[header] = String(originalRow.value[header] ?? '')
    activeField.value = header
    onTextChange()
    await nextTick()
    textareaRefs.get(header)?.focus()
  }

  return {
    onTextChange,
    insertText,
    setTextareaRef,
    activateField,
    rememberSelection,
    isFieldChanged,
    locateHint,
    clearHintLocation,
    sourceSegments,
    findingsState,
    loadFindings,
    restoreField,
    invalidateFindings
  }
}

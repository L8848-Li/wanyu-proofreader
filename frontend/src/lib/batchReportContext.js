const reportAnchors = {
  adoption: '#report-adoption',
  delivery: '#report-delivery',
  findings: '#report-findings',
  exports: '#report-exports',
  overview: '#batch-overview-heading'
}

function recordId(value) {
  return typeof value === 'string' && /^[a-z0-9]{15}$/.test(value) ? value : ''
}

export function normalizeReportHistoryPage(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 1
  if (!/^[1-9]\d*$/.test(String(value))) return 1
  const page = Number(value)
  return Number.isSafeInteger(page) && page <= 1000000 ? page : 1
}

// Navigation provenance only: this does not constrain an adoption or delivery.
// The destination reads its own authorized, current business record.
export function readBatchReportContext(query = {}, projectId) {
  const project = recordId(query.reportProject)
  const batchId = recordId(query.reportBatch)
  if (!project || !batchId || project !== projectId) return null
  return {
    projectId: project,
    batchId,
    exportId: recordId(query.reportExport),
    historyPage: normalizeReportHistoryPage(query.reportHistoryPage),
    section:
      typeof query.reportSection === 'string' && Object.hasOwn(reportAnchors, query.reportSection)
        ? query.reportSection
        : 'overview'
  }
}

function normalizedContext(context) {
  return readBatchReportContext(
    {
      reportProject: context?.projectId,
      reportBatch: context?.batchId,
      reportExport: context?.exportId,
      reportHistoryPage: context?.historyPage,
      reportSection: context?.section
    },
    context?.projectId
  )
}

export function batchReportNavigationQuery(context) {
  const value = normalizedContext(context)
  if (!value) return {}
  return {
    reportProject: value.projectId,
    reportBatch: value.batchId,
    ...(value.exportId ? { reportExport: value.exportId } : {}),
    reportHistoryPage: String(value.historyPage),
    reportSection: value.section
  }
}

export function batchReportReturnTarget(context) {
  const value = normalizedContext(context)
  if (!value) return null
  return {
    name: 'ProjectBatchReport',
    params: { id: value.projectId, batchId: value.batchId },
    query: {
      ...(value.exportId ? { export: value.exportId } : {}),
      historyPage: String(value.historyPage)
    },
    hash: reportAnchors[value.section]
  }
}

import { listRows, saveRows } from '@/data/local-store'
import {
  FUELING_ACTIONS,
  FUELING_COMPLETED_STATUS,
  FUELING_STATUSES,
  FUELING_USAGE_COLUMNS,
} from '@/data/fueling-domain'
import type { ActionResult, EntryRow } from '@/data/types'

const CHECKPOINT_KEY = 'airport-ground-ops:fueling-export-checkpoint'
const RECEIPT_KEY = 'airport-ground-ops:fueling-export-receipts'
const EXPORT_SCHEMA_VERSION = 'fueling-usage-export-v1'

export type FuelingQuery = {
  month: string
  filters?: Record<string, string>
}

export type FuelingUsageSummary = {
  month: string
  completedCount: number
  totalVolume: number
  totalAmount: number
}

export type FuelingReport = {
  rows: EntryRow[]
  usageRows: EntryRow[]
  summary: FuelingUsageSummary
}

export type ExportStage = 'prepare' | 'write-row' | 'build-file' | 'save-file' | 'persist-record'

export type ExportReceipt = {
  month: string
  filename: string
  count: number
  totalVolume: number
  totalAmount: number
  sourceSignature: string
  exportedAt: string
}

type ExportCheckpoint = {
  schemaVersion: string
  month: string
  sourceSignature: string
  total: number
  nextIndex: number
  serializedRows: string[]
  filename: string
  startedAt: string
  updatedAt: string
  failedStage: ExportStage
  failedJobCode: string
  message: string
}

export type FuelingExportResult =
  | {
      ok: true
      resumed: boolean
      discardedStale: boolean
      filename: string
      receipt: ExportReceipt
    }
  | {
      ok: false
      resumed: boolean
      discardedStale: boolean
      stage: ExportStage
      failedJobCode: string
      nextIndex: number
      total: number
      message: string
      checkpoint: ExportCheckpoint
    }

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function currentReportMonth(): string {
  return todayText().slice(0, 7)
}

function asNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function matchesMonth(row: EntryRow, month: string): boolean {
  return /^\d{4}-\d{2}$/.test(month) && String(row['航班日期'] ?? '').startsWith(month)
}

function keywordFilter(rows: EntryRow[], filters: Record<string, string> = {}): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function monthlyUsageRows(month: string): EntryRow[] {
  // 页面合计、导出文件、导出成功后的回执都从这个函数取数，禁止再各自拼台账。
  return listRows('fueling')
    .filter((row) => matchesMonth(row, month))
    .filter((row) => String(row.status) === FUELING_COMPLETED_STATUS)
    .sort((a, b) =>
      String(a['航班日期']).localeCompare(String(b['航班日期'])) ||
      String(a['作业编号']).localeCompare(String(b['作业编号'])),
    )
}

export function summarizeUsage(month: string, rows = monthlyUsageRows(month)): FuelingUsageSummary {
  return rows.reduce<FuelingUsageSummary>(
    (summary, row) => ({
      ...summary,
      completedCount: summary.completedCount + 1,
      totalVolume: summary.totalVolume + asNumber(row['加注量']),
      totalAmount: summary.totalAmount + asNumber(row['加注金额']),
    }),
    { month, completedCount: 0, totalVolume: 0, totalAmount: 0 },
  )
}

export function listFuelingEntries(query: FuelingQuery) {
  const monthRows = listRows('fueling').filter((row) => matchesMonth(row, query.month))
  const rows = keywordFilter(monthRows, query.filters)
  return {
    items: rows,
    total: rows.length,
    page: 1,
    size: rows.length,
    usageRows: monthlyUsageRows(query.month),
    summary: summarizeUsage(query.month),
  }
}

export function fuelingStats(month: string) {
  const all = listRows('fueling')
  const monthRows = all.filter((row) => matchesMonth(row, month))
  const summary = summarizeUsage(month)
  const today = todayText()
  return {
    todayCompleted: all.filter(
      (row) => row.status === FUELING_COMPLETED_STATUS && row['航班日期'] === today,
    ).length,
    inProgress: monthRows.filter((row) => row.status === '加注中').length,
    monthVolume: summary.totalVolume,
    monthAmount: summary.totalAmount,
  }
}

export function runFuelingAction(id: number, action: string): ActionResult {
  const target = FUELING_ACTIONS[action as keyof typeof FUELING_ACTIONS]
  if (!target) {
    return { ok: false, message: `加油作业没有登记「${action}」这个动作` }
  }

  const rows = listRows('fueling')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的加油作业` }
  }

  const current = rows[index]
  const currentStatus = String(current.status)
  if (currentStatus === target) {
    return { ok: false, message: `加油作业已经是「${target}」，不用重复操作` }
  }

  const currentIndex = (FUELING_STATUSES as readonly string[]).indexOf(currentStatus)
  const targetIndex = (FUELING_STATUSES as readonly string[]).indexOf(target)
  if (targetIndex !== currentIndex + 1) {
    return {
      ok: false,
      message: `加油作业需按 ${FUELING_STATUSES.join(' → ')} 顺序流转，不能从「${currentStatus}」直接${action}`,
    }
  }
  if (target === FUELING_COMPLETED_STATUS && current['静电接地检查'] !== '合格') {
    return { ok: false, message: '静电接地检查未合格，不能确认完成；请先补齐接地检查结果' }
  }

  const updated: EntryRow = {
    ...current,
    status: target,
    pending: target !== FUELING_COMPLETED_STATUS,
    abnormal: target === FUELING_COMPLETED_STATUS ? false : Boolean(current.abnormal),
    作业状态: target,
    更新时间: new Date().toISOString(),
  }
  const next = [...rows]
  next[index] = updated
  saveRows('fueling', next)
  return { ok: true, message: `加油作业已${action}，当前状态「${target}」` }
}

function readStorageValue<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(key)
  if (raw === null) {
    return fallback
  }
  return JSON.parse(raw) as T
}

function writeStorageValue(key: string, value: unknown): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('浏览器本地存储不可用，无法保存导出进度')
  }
  window.localStorage.setItem(key, JSON.stringify(value))
}

function removeStorageValue(key: string): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.removeItem(key)
}

function sourceSignature(rows: EntryRow[]): string {
  const payload = JSON.stringify(
    rows.map((row) =>
      FUELING_USAGE_COLUMNS.map((column) => row[column] ?? '')
        .concat(String(row.status))
        .join('|'),
    ),
  )
  let hash = 5381
  for (let index = 0; index < payload.length; index += 1) {
    hash = (hash * 33) ^ payload.charCodeAt(index)
  }
  return `sig-${(hash >>> 0).toString(16)}-${payload.length}`
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function validateUsageRow(row: EntryRow, index: number): void {
  const required = ['作业编号', '航班号', '航班日期', '油品规格', '加注量', '加注金额'] as const
  const missing = required.filter((field) => String(row[field] ?? '').trim() === '')
  if (missing.length > 0) {
    throw new Error(`第 ${index + 1} 条（${row['作业编号'] ?? '未知作业'}）缺少 ${missing.join('、')}`)
  }
  if (!Number.isFinite(Number(row['加注量'])) || Number(row['加注量']) <= 0) {
    throw new Error(`第 ${index + 1} 条（${row['作业编号']}）加注量必须为正数`)
  }
  if (!Number.isFinite(Number(row['加注金额'])) || Number(row['加注金额']) < 0) {
    throw new Error(`第 ${index + 1} 条（${row['作业编号']}）加注金额必须为非负数`)
  }
  if (row['静电接地检查'] !== '合格') {
    throw new Error(`第 ${index + 1} 条（${row['作业编号']}）静电接地检查未合格`)
  }
}

function serializeRow(row: EntryRow): string {
  return FUELING_USAGE_COLUMNS.map((column) => csvCell(row[column])).join(',')
}

function totalLine(summary: FuelingUsageSummary): string {
  return [
    '合计',
    `${summary.completedCount} 架`,
    '',
    '',
    summary.totalVolume,
    summary.totalAmount,
    '',
    '',
    '',
  ]
    .map(csvCell)
    .join(',')
}

function buildCsv(rows: string[], summary: FuelingUsageSummary): string {
  const header = FUELING_USAGE_COLUMNS.map(csvCell).join(',')
  return `\uFEFF${[header, ...rows, totalLine(summary)].join('\n')}`
}

function downloadFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  } finally {
    // 只有内容全部生成后才会走到这里；不会预先创建空文件。
    URL.revokeObjectURL(url)
  }
}

function loadCheckpoint(month: string, signature: string): ExportCheckpoint | null {
  const checkpoint = readStorageValue<ExportCheckpoint | null>(CHECKPOINT_KEY, null)
  if (!checkpoint || checkpoint.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    return null
  }
  if (checkpoint.month !== month) {
    return null
  }
  // 数据在中断后发生变化时丢弃旧分片，避免重试文件里混入旧值。
  return checkpoint.sourceSignature === signature ? checkpoint : null
}

function failure(
  stage: ExportStage,
  checkpoint: ExportCheckpoint,
  error: unknown,
  discardedStale: boolean,
): FuelingExportResult {
  const message = error instanceof Error ? error.message : String(error)
  const failed: ExportCheckpoint = {
    ...checkpoint,
    updatedAt: new Date().toISOString(),
    failedStage: stage,
    message,
  }
  writeStorageValue(CHECKPOINT_KEY, failed)
  return {
    ok: false,
    resumed: false,
    discardedStale,
    stage,
    failedJobCode: failed.failedJobCode,
    nextIndex: failed.nextIndex,
    total: failed.total,
    message: `${stageLabel(stage)}失败：${message}。已保留到第 ${failed.nextIndex + 1}/${failed.total} 条，可从该条重试。`,
    checkpoint: failed,
  }
}

function stageLabel(stage: ExportStage): string {
  return {
    prepare: '准备导出数据',
    'write-row': '生成作业行',
    'build-file': '生成 CSV 文件',
    'save-file': '保存文件到浏览器',
    'persist-record': '登记导出记录',
  }[stage]
}

function loadReceipts(): ExportReceipt[] {
  return readStorageValue<ExportReceipt[]>(RECEIPT_KEY, [])
}

export function monthlyExportReceipt(month: string): ExportReceipt | null {
  return loadReceipts()
    .filter((receipt) => receipt.month === month)
    .sort((a, b) => b.exportedAt.localeCompare(a.exportedAt))[0] ?? null
}

export function pendingFuelingExport(month: string) {
  const rows = monthlyUsageRows(month)
  const signature = sourceSignature(rows)
  const checkpoint = loadCheckpoint(month, signature)
  if (checkpoint) {
    return {
      kind: 'resumable' as const,
      stage: checkpoint.failedStage,
      nextIndex: checkpoint.nextIndex,
      total: checkpoint.total,
      message: checkpoint.message,
    }
  }
  const stored = readStorageValue<ExportCheckpoint | null>(CHECKPOINT_KEY, null)
  if (stored && stored.schemaVersion === EXPORT_SCHEMA_VERSION && stored.month === month) {
    return {
      kind: 'stale' as const,
      stage: stored.failedStage,
      nextIndex: stored.nextIndex,
      total: stored.total,
      message: '中断后源数据已变化，旧分片作废，重试将从第 1 条按最新数据重新生成',
    }
  }
  return null
}

export async function exportMonthlyFuelingUsage(month: string): Promise<FuelingExportResult> {
  const rows = monthlyUsageRows(month)
  const summary = summarizeUsage(month, rows)
  const signature = sourceSignature(rows)
  const filename = `航油加注月度用量-${month}.csv`
  const stored = readStorageValue<ExportCheckpoint | null>(CHECKPOINT_KEY, null)
  const sameMonthStored =
    stored && stored.schemaVersion === EXPORT_SCHEMA_VERSION && stored.month === month ? stored : null
  // 中断后源数据若被修正，旧分片全部作废重来，绝不把旧值拼进新文件。
  const discardedStale = Boolean(sameMonthStored && sameMonthStored.sourceSignature !== signature)
  const previous =
    sameMonthStored && sameMonthStored.sourceSignature === signature ? sameMonthStored : null
  const resumed = Boolean(previous)
  let checkpoint: ExportCheckpoint = previous ?? {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    month,
    sourceSignature: signature,
    total: rows.length,
    nextIndex: 0,
    serializedRows: [],
    filename,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    failedStage: 'prepare',
    failedJobCode: '',
    message: discardedStale
      ? '中断后源数据已变化，旧分片作废，本次从第 1 条重新生成'
      : '',
  }

  try {
    checkpoint = { ...checkpoint, total: rows.length, filename, sourceSignature: signature }
    writeStorageValue(CHECKPOINT_KEY, checkpoint)

    while (checkpoint.nextIndex < rows.length) {
      const index = checkpoint.nextIndex
      const row = rows[index]
      try {
        validateUsageRow(row, index)
        checkpoint = {
          ...checkpoint,
          failedJobCode: String(row['作业编号']),
          serializedRows: [...checkpoint.serializedRows, serializeRow(row)],
          nextIndex: index + 1,
          updatedAt: new Date().toISOString(),
        }
        writeStorageValue(CHECKPOINT_KEY, checkpoint)
        // 让出事件循环，让页面展示“已生成到哪一条”。
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      } catch (error) {
        return failure('write-row', checkpoint, error, discardedStale)
      }
    }

    let content = ''
    try {
      content = buildCsv(checkpoint.serializedRows, summary)
    } catch (error) {
      return failure('build-file', checkpoint, error, discardedStale)
    }

    try {
      downloadFile(checkpoint.filename, content)
    } catch (error) {
      return failure('save-file', checkpoint, error, discardedStale)
    }

    const receipt: ExportReceipt = {
      month,
      filename: checkpoint.filename,
      count: summary.completedCount,
      totalVolume: summary.totalVolume,
      totalAmount: summary.totalAmount,
      sourceSignature: signature,
      exportedAt: new Date().toISOString(),
    }
    try {
      const receipts = [...loadReceipts().filter((item) => item.month !== month), receipt]
      writeStorageValue(RECEIPT_KEY, receipts)
      removeStorageValue(CHECKPOINT_KEY)
    } catch (error) {
      return failure('persist-record', checkpoint, error, discardedStale)
    }

    return { ok: true, resumed, discardedStale, filename: checkpoint.filename, receipt }
  } catch (error) {
    return failure('prepare', checkpoint, error, discardedStale)
  }
}

import { getFuelingRows } from './store'
import { summarizeMonth } from './reconcile'
import { FUELING_DONE_STATUS } from './types'
import type { FuelingUsageRow } from './types'

/**
 * 月度用量报表导出管线。
 *
 * 三个阶段，每一步失败都带上阶段名和当前处理到的行，页面能讲清「失败在哪一步」：
 *   collect  取数：走统一选择器（与页面合计同一个函数），按航班日期归属月份、去重已在选择器完成
 *   write    逐行生成：每写一条就把检查点落 localStorage，中断后重试从下一条继续
 *   deliver  产出：内容完整拼好才交给浏览器下载，任何失败都不会留下空文件
 *
 * 检查点按「月份 + 每行指纹」校验：重试时若源数据变了（作业被改/补录），
 * 旧检查点作废从头再来，保证文件里不会出现显示成旧值的行。
 */

const CHECKPOINT_KEY = 'airport-ground-ops:fueling-export-checkpoint'

export type ExportStage = 'collect' | 'write' | 'deliver'

export type ExportProgress = {
  month: string
  stage: ExportStage
  total: number
  written: number
  /** write 阶段已落检查点的行，deliver 前不产生任何文件。 */
  lines: string[]
  /** 已写入行的指纹，重试时逐行核对，源数据变动即整单重跑。 */
  fingerprints: string[]
  startedAt: string
  updatedAt: string
}

export class ExportError extends Error {
  stage: ExportStage
  row: number
  month: string
  causeDetail: string

  constructor(stage: ExportStage, month: string, row: number, message: string) {
    super(`月度用量报表在「${stageLabel(stage)}」阶段失败：${message}`)
    this.name = 'ExportError'
    this.stage = stage
    this.month = month
    this.row = row
    this.causeDetail = message
  }
}

export type ExportOutcome =
  | {
      ok: true
      filename: string
      content: string
      resumed: boolean
      skipped: number
    }
  | {
      ok: false
      error: ExportError
      resumable: boolean
    }

function stageLabel(stage: ExportStage): string {
  return { collect: '取数', write: '逐行生成', deliver: '产出文件' }[stage]
}

function csvCell(value: string | number): string {
  const text = String(value)
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/** 行指纹：一行里参与报表的全部字段都在，任一字段变了都判定为源数据已变。 */
function fingerprint(row: FuelingUsageRow): string {
  return JSON.stringify([
    row.作业编号,
    row.航班号,
    row.航班日期,
    row.油品规格,
    row.加注量,
    row.单价,
    row.金额,
    row.静电接地检查,
    row.status,
  ])
}

export const REPORT_HEADER = [
  '作业编号',
  '航班号',
  '航班日期',
  '归属月份',
  '油品规格',
  '加注量(升)',
  '单价(元/升)',
  '金额(元)',
  '加油车号',
  '作业人员',
  '静电接地检查',
  '作业状态',
  '数据告警',
]

function headerLine(): string {
  return REPORT_HEADER.map(csvCell).join(',')
}

function dataLine(row: FuelingUsageRow): string {
  return [
    row.作业编号,
    row.航班号,
    row.航班日期,
    row.归属月份,
    row.油品规格,
    row.加注量,
    row.单价,
    row.金额,
    row.加油车号,
    row.作业人员,
    row.静电接地检查,
    row.status,
    row.warnings.join('；'),
  ]
    .map(csvCell)
    .join(',')
}

function totalLine(rows: FuelingUsageRow[]): string {
  const summary = summarizeMonth(
    rows.filter((row) => row.status === FUELING_DONE_STATUS),
    rows[0]?.归属月份 ?? '',
  )
  return ['合计', '', '', summary.month, '', summary.volume, '', summary.amount, '', '', '', '', '']
    .map(csvCell)
    .join(',')
}

/** collect：与页面合计同一份选择器结果，按月份与「已完成」口径取行。 */
function collectRows(month: string): FuelingUsageRow[] {
  const rows = getFuelingRows()
  return rows.filter((row) => row.归属月份 === month && row.status === FUELING_DONE_STATUS)
}

function loadCheckpoint(month: string): ExportProgress | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(CHECKPOINT_KEY)
  if (!raw) {
    return null
  }
  try {
    const point = JSON.parse(raw) as ExportProgress
    return point.month === month ? point : null
  } catch {
    return null
  }
}

function saveCheckpoint(point: ExportProgress): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(point))
  }
}

export function clearExportCheckpoint(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(CHECKPOINT_KEY)
  }
}

export function getExportCheckpoint(month: string): { written: number; total: number } | null {
  const point = loadCheckpoint(month)
  return point ? { written: point.written, total: point.total } : null
}

/**
 * 组装月度用量报表。
 *
 * 失败语义：
 * - collect 阶段失败：数据本身读不出来，不允许产出文件，不可续跑（重试即重新取数）；
 * - write 阶段失败：检查点已落，重试从断的那一条继续；若源数据指纹对不上则整单重跑；
 * - deliver 阶段失败：内容已在内存里完整生成，只是浏览器下载动作失败，可直接再试一次。
 *
 * 注意：本函数只生成内容，真正创建 Blob/触发下载在 downloadMonthlyReport 里，
 * 两者分开保证「生成失败」绝不可能在磁盘上留下空文件。
 */
export function buildMonthlyReport(
  month: string,
  options: { onProgress?: (point: ExportProgress) => void } = {},
): ExportOutcome {
  const onProgress = options.onProgress ?? (() => undefined)

  // —— collect ——
  let rows: FuelingUsageRow[]
  try {
    rows = collectRows(month)
  } catch (error) {
    return {
      ok: false,
      resumable: false,
      error: new ExportError(
        'collect',
        month,
        0,
        error instanceof Error ? `统一取数失败：${error.message}` : '统一取数失败',
      ),
    }
  }

  // 重试入口：校验已有检查点。指纹对不上说明源数据已变，旧文件半成品必须作废重来。
  let resumed = false
  let point = loadCheckpoint(month)
  if (point) {
    const stale =
      point.total !== rows.length ||
      point.fingerprints.some((mark, index) => mark !== fingerprint(rows[index]))
    if (stale) {
      point = null
      clearExportCheckpoint()
    } else if (point.written > 0) {
      resumed = true
    }
  }
  if (!point) {
    point = {
      month,
      stage: 'write',
      total: rows.length,
      written: 0,
      lines: [headerLine()],
      fingerprints: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  // 续跑开始前已落检查点的行数：用于回报「本次跳过了几条」，不能用跑完后的总数
  const resumedStartWritten = resumed ? point.written : 0

  // —— write：逐行生成，每条落检查点；从中断的那一条之后继续 ——
  try {
    for (let index = point.written; index < rows.length; index += 1) {
      // 先算内容再动检查点：本行序列化失败时，检查点停在上一条完整行，不会留半行
      const line = dataLine(rows[index])
      const mark = fingerprint(rows[index])
      point.lines.push(line)
      point.fingerprints.push(mark)
      point.written = index + 1
      point.updatedAt = new Date().toISOString()
      saveCheckpoint(point)
      onProgress(point)
    }
  } catch (error) {
    return {
      ok: false,
      resumable: true,
      error: new ExportError(
        'write',
        month,
        point.written,
        error instanceof Error
          ? `生成第 ${point.written + 1} 行（作业 ${rows[point.written]?.作业编号 ?? '?'}）时中断：${error.message}`
          : '逐行生成中断',
      ),
    }
  }

  // —— deliver：拼上合计行、收尾，全部成功才允许进入下载 ——
  try {
    // 续跑时若上一单已走到 deliver（合计行已在检查点里），不能重复追加
    if (point.stage !== 'deliver') {
      point.stage = 'deliver'
      point.lines.push(totalLine(rows))
    }
    point.updatedAt = new Date().toISOString()
    saveCheckpoint(point)

    const content = `\uFEFF${point.lines.join('\n')}`
    const filename = `航油加注月度用量-${month}.csv`
    const skipped = resumedStartWritten
    // 内容已完整交付，清掉检查点；下一次导出是全新一单。
    clearExportCheckpoint()
    return { ok: true, filename, content, resumed, skipped }
  } catch (error) {
    return {
      ok: false,
      resumable: true,
      error: new ExportError(
        'deliver',
        month,
        point.written,
        error instanceof Error ? error.message : '产出文件失败，已生成的内容保留，可直接重试',
      ),
    }
  }
}

/**
 * 触发浏览器下载。只有 buildMonthlyReport 成功后才会走到这里，
 * 因此失败时不可能留下空文件；本步失败可原样再试（内容已生成完）。
 */
export function downloadMonthlyReport(filename: string, content: string): void {
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
    URL.revokeObjectURL(url)
  }
}

/** 供页面展示：当前数据集三源对账后待人工补录的问题行。 */
export function exportHealthWarnings(): { month: string; rows: FuelingUsageRow[] }[] {
  const rows = getFuelingRows().filter((row) => row.warnings.length > 0)
  const byMonth = new Map<string, FuelingUsageRow[]>()
  for (const row of rows) {
    const list = byMonth.get(row.归属月份) ?? []
    list.push(row)
    byMonth.set(row.归属月份, list)
  }
  return [...byMonth.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, scoped]) => ({ month, rows: scoped }))
}

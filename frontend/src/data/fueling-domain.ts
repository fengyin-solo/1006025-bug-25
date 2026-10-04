import type { EntryRow } from '@/data/types'

export const FUELING_MODULE_KEY = 'fueling'
export const FUELING_COMPLETED_STATUS = '已完成'
export const FUELING_STATUSES = ['待加注', '加注中', '待确认', '已完成'] as const
export const FUELING_ACTIONS = {
  开始加注: '加注中',
  提交确认: '待确认',
  确认完成: '已完成',
} as const

export const FUELING_USAGE_COLUMNS = [
  '作业编号',
  '航班号',
  '航班日期',
  '油品规格',
  '加注量',
  '加注金额',
  '加油车号',
  '作业人员',
  '静电接地检查',
] as const

export type FuelingStatus = (typeof FUELING_STATUSES)[number]
export type FuelingSourceName = 'main' | 'usage' | 'spec' | 'grounding'
export type FuelingLegacyRow = Record<string, unknown>

export type FuelingSources = {
  main?: FuelingLegacyRow[]
  usage?: FuelingLegacyRow[]
  spec?: FuelingLegacyRow[]
  grounding?: FuelingLegacyRow[]
}

export type FuelingReconcileAudit = {
  version: string
  policy: 'completed-usage-by-flight-date'
  reconciledAt: string
  sourceCounts: Record<FuelingSourceName, number>
  retainedCount: number
  duplicateJobs: { code: string; mainCount: number }[]
  backfilledJobs: { code: string; flightDate: string }[]
  archivedSources: FuelingSources
}

export type FuelingReconcileResult = {
  rows: EntryRow[]
  audit: FuelingReconcileAudit
}

type FuelingCandidate = EntryRow & {
  __code: string
  __source: FuelingSourceName
  __sourceIndex: number
  __updatedAt: number
}

export const FUELING_DATA_VERSION = 'fueling-v2-2026-10-04'

const SOURCE_NAMES: FuelingSourceName[] = ['main', 'usage', 'spec', 'grounding']
const SOURCE_PRIORITY: Record<FuelingSourceName, number> = {
  main: 30,
  usage: 20,
  spec: 10,
  grounding: 10,
}
const FIELD_SOURCE_RANK: Record<string, Partial<Record<FuelingSourceName, number>>> = {
  航班号: { main: 40, usage: 30 },
  航班日期: { usage: 40, main: 30 },
  油品规格: { spec: 40, main: 30 },
  加注量: { usage: 40, main: 30 },
  加注金额: { usage: 40, main: 30 },
  加油车号: { main: 40, usage: 30 },
  作业人员: { main: 40, usage: 30 },
  静电接地检查: { grounding: 40, main: 30 },
  status: { main: 40, usage: 30 },
  更新时间: { usage: 40, grounding: 35, spec: 30, main: 20 },
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

function nonEmpty(value: unknown): boolean {
  return text(value) !== ''
}

function parseTimestamp(value: unknown): number {
  if (!nonEmpty(value)) {
    return 0
  }
  const parsed = Date.parse(text(value))
  return Number.isNaN(parsed) ? 0 : parsed
}

function parseFlightDate(value: unknown): string {
  const raw = text(value)
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!matched) {
    return ''
  }
  const [, year, month, day] = matched
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return ''
  }
  return raw
}

function parseAmount(value: unknown): number | null {
  const raw = text(value).replace(/,/g, '').replace(/(升|元|¥|￥)$/g, '')
  if (raw === '') {
    return null
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function normalizeGrounding(value: unknown): string {
  const raw = text(value)
  if (['合格', '通过', '正常', '已接地'].includes(raw)) {
    return '合格'
  }
  if (['不合格', '不通过', '异常'].includes(raw)) {
    return '不合格'
  }
  return '未检查'
}

function normalizeSpec(value: unknown): string {
  return text(value).replace(/\s+/g, ' ').toUpperCase()
}

function toCandidate(
  source: FuelingSourceName,
  index: number,
  raw: FuelingLegacyRow,
): FuelingCandidate | null {
  const code = text(raw['作业编号']).toUpperCase()
  if (!code) {
    return null
  }

  const candidate: FuelingCandidate = {
    id: source === 'main' && Number.isFinite(Number(raw.id)) ? Number(raw.id) : 100000 + index,
    status: source === 'usage' ? FUELING_COMPLETED_STATUS : text(raw.status),
    pending: false,
    abnormal: Boolean(raw.abnormal),
    __code: code,
    __source: source,
    __sourceIndex: index,
    __updatedAt: parseTimestamp(raw['更新时间'] ?? raw['检查时间']),
  }

  const copyIfPresent = (target: string, ...sourceFields: string[]) => {
    for (const field of sourceFields) {
      if (nonEmpty(raw[field])) {
        candidate[target] = text(raw[field])
        return
      }
    }
  }

  copyIfPresent('航班号', '航班号')
  copyIfPresent('加油车号', '加油车号', '加油车')
  copyIfPresent('作业人员', '作业人员', '操作人员')
  copyIfPresent('油品规格', '油品规格')
  copyIfPresent('静电接地检查', '静电接地检查', '接地检查')
  copyIfPresent('更新时间', '更新时间')

  const flightDate = parseFlightDate(raw['航班日期'])
  if (flightDate) {
    candidate['航班日期'] = flightDate
  }

  const volume = parseAmount(raw['加注量'])
  if (volume !== null) {
    candidate['加注量'] = volume
  }

  const amount = parseAmount(raw['加注金额'])
  if (amount !== null) {
    candidate['加注金额'] = amount
  }

  if (source === 'grounding') {
    candidate['静电接地检查'] = normalizeGrounding(raw['静电接地检查'] ?? raw['接地检查'])
    candidate.__updatedAt ||= parseTimestamp(raw['检查时间'])
  }
  if (source === 'spec') {
    candidate['油品规格'] = normalizeSpec(raw['油品规格'])
  }
  if (nonEmpty(candidate['油品规格'])) {
    candidate['油品规格'] = normalizeSpec(candidate['油品规格'])
  }
  if (nonEmpty(candidate['静电接地检查'])) {
    candidate['静电接地检查'] = normalizeGrounding(candidate['静电接地检查'])
  }

  return candidate
}

function pickValue(candidates: FuelingCandidate[], field: string): string | number | boolean {
  let best: FuelingCandidate | null = null
  let bestScore = -Infinity

  for (const candidate of candidates) {
    const value = candidate[field]
    if (value === undefined || value === '') {
      continue
    }
    const rank = FIELD_SOURCE_RANK[field]?.[candidate.__source] ?? SOURCE_PRIORITY[candidate.__source]
    const score = rank * 1e14 + candidate.__updatedAt * 10 + (100 - candidate.__sourceIndex % 100)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best ? (best[field] as string | number | boolean) : ''
}

function pickStatus(candidates: FuelingCandidate[]): string {
  const status = text(pickValue(candidates, 'status'))
  return (FUELING_STATUSES as readonly string[]).includes(status) ? status : '待加注'
}

/**
 * 航油加注唯一取数口径：主登记表、用量台账、油品规格台账、静电接地检查表
 * 都先在这里按作业编号合并，页面合计、状态流转后的读取和月度导出只能读合并结果。
 */
export function reconcileFuelingRows(sources: FuelingSources): FuelingReconcileResult {
  const normalizedSources = SOURCE_NAMES.reduce<Required<FuelingSources>>((acc, name) => {
    acc[name] = Array.isArray(sources[name]) ? (sources[name] as FuelingLegacyRow[]) : []
    return acc
  }, { main: [], usage: [], spec: [], grounding: [] })

  const groups = new Map<string, FuelingCandidate[]>()
  SOURCE_NAMES.forEach((sourceName) => {
    normalizedSources[sourceName].forEach((raw, index) => {
      const candidate = toCandidate(sourceName, index, raw)
      if (!candidate) {
        return
      }
      const group = groups.get(candidate.__code) ?? []
      group.push(candidate)
      groups.set(candidate.__code, group)
    })
  })

  const merged = [...groups.entries()].map(([code, candidates]) => {
    const mainCandidates = candidates.filter((candidate) => candidate.__source === 'main')
    const status = pickStatus(candidates)
    const grounding = normalizeGrounding(pickValue(candidates, '静电接地检查'))
    const updatedAt = pickValue(candidates, '更新时间')
    const row: EntryRow = {
      id: 0,
      status,
      pending: status !== FUELING_COMPLETED_STATUS,
      abnormal: grounding === '不合格',
      作业编号: code,
      航班号: text(pickValue(candidates, '航班号')),
      航班日期: parseFlightDate(pickValue(candidates, '航班日期')),
      油品规格: normalizeSpec(pickValue(candidates, '油品规格')),
      加注量: parseAmount(pickValue(candidates, '加注量')) ?? '',
      加注金额: parseAmount(pickValue(candidates, '加注金额')) ?? '',
      加油车号: text(pickValue(candidates, '加油车号')),
      作业人员: text(pickValue(candidates, '作业人员')),
      静电接地检查: grounding,
      作业状态: status,
      更新时间: text(updatedAt),
    }
    return {
      row,
      flightDate: row['航班日期'] as string,
      code,
      mainCount: mainCandidates.length,
      hadMain: mainCandidates.length > 0,
    }
  })

  merged.sort((a, b) => {
    const dateCompare = a.flightDate.localeCompare(b.flightDate)
    return dateCompare || a.code.localeCompare(b.code)
  })

  const rows = merged.map((item, index) => ({ ...item.row, id: index + 1 }))
  const audit: FuelingReconcileAudit = {
    version: FUELING_DATA_VERSION,
    policy: 'completed-usage-by-flight-date',
    reconciledAt: new Date().toISOString(),
    sourceCounts: SOURCE_NAMES.reduce(
      (acc, name) => ({ ...acc, [name]: normalizedSources[name].length }),
      {} as Record<FuelingSourceName, number>,
    ),
    retainedCount: rows.length,
    duplicateJobs: merged
      .filter((item) => item.mainCount > 1)
      .map((item) => ({ code: item.code, mainCount: item.mainCount })),
    backfilledJobs: merged
      .filter((item) => !item.hadMain && item.flightDate)
      .map((item) => ({ code: item.code, flightDate: item.flightDate })),
    archivedSources: normalizedSources,
  }

  return { rows, audit }
}

/** 后续状态流转保存的已经是规范数据；再过一次同一口径，保证其它入口读到同样的值。 */
export function stabilizeFuelingRows(rows: EntryRow[]): EntryRow[] {
  return reconcileFuelingRows({ main: rows as FuelingLegacyRow[] }).rows
}

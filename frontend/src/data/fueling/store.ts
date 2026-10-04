import { deleteGenericKey, hasGenericKey } from '../local-store'
import { FUELING_SEED } from './seed'
import { reconcile, summarizeMonth, usageRows } from './reconcile'
import { FUELING_STATUSES } from './types'
import type { FuelingDataset, FuelingUsageRow, FuelingSummary, RepairLog } from './types'

// 航油加注的独立持久化位置：与其它模块的通用存储分开，
// 作业主档、计量读数、接地检查三处源数据放同一个数据集里一起落库、一起读。
const STORAGE_KEY = 'airport-ground-ops:fueling'
// 与 exporter.ts 的检查点键保持一致：重置数据时半成品报表也必须作废。
const CHECKPOINT_KEY = 'airport-ground-ops:fueling-export-checkpoint'
const SCHEMA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: FuelingDataset | null = null

function readRaw(): FuelingDataset {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(FUELING_SEED)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return clone(FUELING_SEED)
  }
  try {
    return JSON.parse(raw) as FuelingDataset
  } catch {
    // 存储损坏不静默吞：回到播种数据，损坏的问题留给对账日志/页面暴露。
    return clone(FUELING_SEED)
  }
}

function persist(dataset: FuelingDataset): void {
  cache = dataset
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(dataset))
  }
}

/**
 * 旧版本航油数据混在通用存储里（占位数组），与新的三源数据集会各算各的。
 * 首次加载时把通用存储里的 fueling 键清掉，只保留专用数据集这一个数据来源。
 */
function migrateLegacy(dataset: FuelingDataset): FuelingDataset {
  if (!hasGenericKey('fueling')) {
    return dataset
  }
  deleteGenericKey('fueling')
  const logs: RepairLog[] = [...dataset.logs]
  const detail = '旧版航油数据与通用清单混存在一处，已清除该入口，统一改读作业主档/计量读数/接地检查三源数据集'
  if (!logs.some((log) => log.type === 'cleanup_legacy' && log.detail === detail)) {
    logs.push({ type: 'cleanup_legacy', detail })
  }
  return { ...dataset, logs }
}

/**
 * 唯一读入口：迁移 → 对账 → 落库，然后任何页面/导出/后续操作拿到的都是同一份结果。
 * 落库与读取在同一步完成：不存在「页面已读到新值、导出还在用旧值」的窗口。
 */
export function getFuelingDataset(): FuelingDataset {
  if (cache) {
    return cache
  }
  const migrated = migrateLegacy(readRaw())
  const reconciled = reconcile(migrated)
  // 缓存永远指向对账后的规范对象；有实质修正时再写 localStorage，避免无谓写入。
  if (JSON.stringify(reconciled) !== JSON.stringify(migrated)) {
    persist(reconciled)
  } else {
    cache = reconciled
  }
  return cache as FuelingDataset
}

/** 统一行选择器：页面表格、合计、月度导出、看板全部只允许通过它取数。 */
export function getFuelingRows(): FuelingUsageRow[] {
  return usageRows(getFuelingDataset())
}

export function getFuelingMonthSummary(month: string): FuelingSummary {
  return summarizeMonth(getFuelingRows(), month)
}

export function getFuelingMonths(): string[] {
  return [...new Set(getFuelingRows().map((row) => row.归属月份))].sort().reverse()
}

export function getFuelingRepairLogs(): RepairLog[] {
  return getFuelingDataset().logs
}

/** 状态流转直接改作业主档，改完立刻重新对账并落库，下一次任何入口读到的都是新值。 */
export function updateFuelingJobStatus(
  id: number,
  target: string,
): { ok: boolean; message: string } {
  if (!FUELING_STATUSES.includes(target as (typeof FUELING_STATUSES)[number])) {
    return { ok: false, message: `加油作业没有「${target}」这个状态` }
  }
  const dataset = getFuelingDataset()
  const index = dataset.jobs.findIndex((job) => job.id === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的加油作业` }
  }
  const job = dataset.jobs[index]
  if (job.status === target) {
    return { ok: false, message: `加油作业已经是「${target}」，不用重复操作` }
  }
  const jobs = [...dataset.jobs]
  jobs[index] = {
    ...job,
    status: target,
    pending: target !== '已完成',
  }
  persist(reconcile({ ...dataset, jobs }))
  return { ok: true, message: `加油作业状态已更新为「${target}」` }
}

/** 重置航油数据：专用存储清掉后重新播种并对账；旧通用入口若还在，由首次加载迁移摘除。 */
export function resetFuelingDataset(): FuelingDataset {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY)
    window.localStorage.removeItem(CHECKPOINT_KEY)
  }
  cache = null
  return getFuelingDataset()
}

export function fuelingSchemaVersion(): number {
  return SCHEMA_VERSION
}

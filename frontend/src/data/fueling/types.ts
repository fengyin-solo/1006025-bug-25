/**
 * 航油加注领域模型。
 *
 * 三类数据原本分散在两处甚至三处，各自登记：
 * - FuelingJob       加油作业主档：油品规格、航班、航班日期、状态（页面合计按它算）
 * - FuelMeterReading 计量点读数：加注量、计量点登记的油品规格、计量日期（旧导出按它算）
 * - GroundingCheck   静电接地检查：结果单独登记，旧导出根本没有并进来
 *
 * 任何入口都不许直接拿其中某一笔源数据做统计，统一走 store.ts 里对账后的选择器。
 */

export const FUELING_KEY = 'fueling'

/** 作业主档的状态流，与 modules.ts 中 fueling 模块保持一致。 */
export const FUELING_STATUSES = ['待加注', '加注中', '待确认', '已完成'] as const
export const FUELING_DONE_STATUS = '已完成'

/**
 * 油品单价（元/升）。规格名以作业主档为准，计量点规格经对账后与其对齐。
 * 未登记单价的规格按 0 计并在结果上挂告警，不允许悄悄算出错金额。
 */
export const FUEL_UNIT_PRICE: Record<string, number> = {
  'JET A-1': 6.85,
  '3号喷气燃料': 6.9,
}

export interface FuelingJob {
  id: number
  作业编号: string
  航班号: string
  /** YYYY-MM-DD，月度用量归属月份的唯一依据（不按计量日期归属）。 */
  航班日期: string
  油品规格: string
  加油车号: string
  作业人员: string
  status: string
  pending: boolean
  abnormal: boolean
}

export interface FuelMeterReading {
  id: number
  作业编号: string
  /** 实际加注量，单位升。 */
  加注量: number
  /** 计量点登记的油品规格；与作业主档不一致时由对账步骤对齐。 */
  油品规格: string
  /** 计量点登记日期，仅作留档，月份归属一律以作业主档的航班日期为准。 */
  计量日期: string
  /** 计量日期与航班日期跨月、已按航班日期回填修正时置 true。 */
  dateCorrected?: boolean
  /** 找不到对应作业主档的孤立读数，保留留档但不进任何统计。 */
  orphan?: boolean
}

export interface GroundingCheck {
  id: number
  作业编号: string
  检查结果: string
  检查时间: string
  /** 找不到对应作业主档的孤立检查记录，保留留档但不进报表。 */
  orphan?: boolean
}

export type RepairType =
  | 'cleanup_legacy' // 清掉旧版通用存储里的航油占位数据
  | 'dedup_reading' // 同一作业编号的重复计量读数，保留第一条
  | 'align_spec' // 计量点油品规格与作业主档不一致，对齐到主档
  | 'correct_month' // 计量日期跨月，按航班日期回填归属月份
  | 'missing_reading' // 已完成作业缺计量读数
  | 'missing_grounding' // 已完成作业缺静电接地检查结果
  | 'orphan_reading' // 计量读数没有对应作业
  | 'orphan_grounding' // 接地检查没有对应作业

export interface RepairLog {
  type: RepairType
  jobNo?: string
  detail: string
}

/** 对账落库后的规范数据集，schemaVersion 变化时重新对账。 */
export interface FuelingDataset {
  schemaVersion: 2
  jobs: FuelingJob[]
  readings: FuelMeterReading[]
  grounding: GroundingCheck[]
  /** 每一项对账修正都留痕，修正只做一次、幂等重跑不再产生新记录。 */
  logs: RepairLog[]
  repairedAt: string | null
}

/** 三源对账合并后的统一行，页面表格、月度合计、导出报表全部读它。 */
export interface FuelingUsageRow {
  id: number
  作业编号: string
  航班号: string
  航班日期: string
  /** YYYY-MM，取自航班日期。 */
  归属月份: string
  油品规格: string
  加注量: number
  单价: number
  金额: number
  加油车号: string
  作业人员: string
  静电接地检查: string
  status: string
  pending: boolean
  abnormal: boolean
  /** 仍需人工关注的数据质量问题（已被对账修复的历史问题不在此列）。 */
  warnings: string[]
}

export interface FuelingSummary {
  month: string
  count: number
  volume: number
  amount: number
}

import { FUELING_DONE_STATUS, FUEL_UNIT_PRICE } from './types'
import type {
  FuelingDataset,
  FuelingJob,
  FuelingUsageRow,
  FuelingSummary,
  FuelMeterReading,
  GroundingCheck,
  RepairLog,
} from './types'

/** 月份归属一律取作业主档的航班日期（YYYY-MM），计量日期只留档不参与归属。 */
export function monthOf(date: string): string {
  return date.slice(0, 7)
}

/**
 * 三源对账，幂等：对已经是规范态的数据集重跑，不产生新的修正日志。
 *
 * 修正规则（每一笔修正都写 logs，页面上能看到，落库只做这一次）：
 * 1. 计量读数按作业编号去重，保留 id 最小的一条，另一条只留日志；
 * 2. 计量点油品规格与作业主档不一致的，对齐到作业主档（规格以主档为准）；
 * 3. 计量日期与航班日期跨月的，标记 dateCorrected，归属月份按航班日期回填；
 * 4. 已完成却没有计量读数的作业，加注量按 0 纳入并挂告警（宁可见零，不许漏行）；
 * 5. 已完成却没有静电接地检查的，检查结果显示「未记录」并挂告警；
 * 6. 找不到作业主档的孤立读数/检查保留留档，标 orphan，不进任何统计。
 */
export function reconcile(raw: FuelingDataset): FuelingDataset {
  const logs: RepairLog[] = [...raw.logs]
  // 幂等关键：同一修正（type+作业+详情）只写一次，补录前重跑不产生重复日志。
  const pushLog = (log: RepairLog) => {
    const duplicated = logs.some(
      (item) =>
        item.type === log.type && item.jobNo === log.jobNo && item.detail === log.detail,
    )
    if (!duplicated) {
      logs.push(log)
    }
  }
  const jobsById = new Map(raw.jobs.map((job) => [job.作业编号, job]))

  // 1. 读数去重：同一作业编号保留第一条
  const seenReading = new Set<string>()
  const readings: FuelMeterReading[] = []
  for (const reading of raw.readings) {
    const job = jobsById.get(reading.作业编号)
    if (!job) {
      const next = { ...reading, orphan: true as const }
      readings.push(next)
      pushLog({
        type: 'orphan_reading',
        jobNo: reading.作业编号,
        detail: `计量读数 R${reading.id} 找不到对应作业主档，已保留留档但不纳入统计`,
      })
      continue
    }
    if (seenReading.has(reading.作业编号)) {
      pushLog({
        type: 'dedup_reading',
        jobNo: reading.作业编号,
        detail: `作业 ${reading.作业编号} 存在重复计量读数 R${reading.id}，与保留值同为 ${reading.加注量} 升，已剔除重复行`,
      })
      continue
    }
    seenReading.add(reading.作业编号)

    let next = { ...reading }
    // 2. 规格对齐到主档
    if (next.油品规格 !== job.油品规格) {
      pushLog({
        type: 'align_spec',
        jobNo: job.作业编号,
        detail: `作业 ${job.作业编号} 计量点规格「${next.油品规格}」与主档「${job.油品规格}」不一致，已按主档对齐`,
      })
      next = { ...next, 油品规格: job.油品规格 }
    }
    // 3. 跨月计量日期按航班日期回填归属
    if (monthOf(next.计量日期) !== monthOf(job.航班日期)) {
      pushLog({
        type: 'correct_month',
        jobNo: job.作业编号,
        detail: `作业 ${job.作业编号} 计量日期 ${next.计量日期} 与航班日期 ${job.航班日期} 跨月，已按航班日期回填到 ${monthOf(job.航班日期)}`,
      })
      next = { ...next, dateCorrected: true }
    }
    readings.push(next)
  }

  // 4/5. 接地检查去重并找出已完成却缺失检查的作业
  const seenGrounding = new Set<string>()
  const grounding: GroundingCheck[] = []
  for (const check of raw.grounding) {
    const job = jobsById.get(check.作业编号)
    if (!job) {
      grounding.push({ ...check, orphan: true })
      pushLog({
        type: 'orphan_grounding',
        jobNo: check.作业编号,
        detail: `静电接地检查 G${check.id} 找不到对应作业主档，已保留留档但不纳入报表`,
      })
      continue
    }
    if (seenGrounding.has(check.作业编号)) {
      pushLog({
        type: 'dedup_reading',
        jobNo: check.作业编号,
        detail: `作业 ${check.作业编号} 静电接地检查重复登记 G${check.id}，已只保留首次检查结果`,
      })
      continue
    }
    seenGrounding.add(check.作业编号)
    grounding.push({ ...check })
  }

  const readingByJob = new Map(readings.filter((r) => !r.orphan).map((r) => [r.作业编号, r]))
  const groundingByJob = new Map(grounding.filter((g) => !g.orphan).map((g) => [g.作业编号, g]))

  // 已完成作业缺读数 / 缺检查：不静默补数，进统一口径并挂告警
  for (const job of raw.jobs) {
    if (job.status !== FUELING_DONE_STATUS) {
      continue
    }
    if (!readingByJob.has(job.作业编号)) {
      pushLog({
        type: 'missing_reading',
        jobNo: job.作业编号,
        detail: `作业 ${job.作业编号} 已完成但缺计量读数，已按 0 升纳入 ${monthOf(job.航班日期)} 月用量，待计量点补录`,
      })
    }
    if (!groundingByJob.has(job.作业编号)) {
      pushLog({
        type: 'missing_grounding',
        jobNo: job.作业编号,
        detail: `作业 ${job.作业编号} 已完成但静电接地检查结果缺失，报表显示「未记录」，待检查点补录`,
      })
    }
  }

  return {
    schemaVersion: 2,
    jobs: raw.jobs.map((job) => ({ ...job })),
    readings,
    grounding,
    logs,
    repairedAt: raw.repairedAt ?? new Date().toISOString(),
  }
}

/**
 * 唯一统计口径：三源 LEFT JOIN，以作业主档为基准，按作业编号去重。
 * 页面表格、页面合计、月度报表导出、概览看板以及任何后续入口都只能读这里。
 */
export function usageRows(data: FuelingDataset): FuelingUsageRow[] {
  const readingByJob = new Map(data.readings.filter((r) => !r.orphan).map((r) => [r.作业编号, r]))
  const groundingByJob = new Map(data.grounding.filter((g) => !g.orphan).map((g) => [g.作业编号, g]))

  return data.jobs
    .map((job: FuelingJob): FuelingUsageRow => {
      const reading = readingByJob.get(job.作业编号)
      const grounding = groundingByJob.get(job.作业编号)
      const warnings: string[] = []
      if (job.status === FUELING_DONE_STATUS && !reading) {
        warnings.push('已完成但缺计量读数，加注量暂按 0 升计，待补录')
      }
      if (job.status === FUELING_DONE_STATUS && !grounding) {
        warnings.push('已完成但静电接地检查未记录')
      }
      const unitPrice = FUEL_UNIT_PRICE[job.油品规格]
      if (unitPrice === undefined) {
        warnings.push(`油品规格「${job.油品规格}」未登记单价，金额暂按 0 计`)
      }
      const volume = reading ? reading.加注量 : 0
      const price = unitPrice ?? 0
      return {
        id: job.id,
        作业编号: job.作业编号,
        航班号: job.航班号,
        航班日期: job.航班日期,
        归属月份: monthOf(job.航班日期),
        油品规格: job.油品规格,
        加注量: volume,
        单价: price,
        金额: Math.round(volume * price * 100) / 100,
        加油车号: job.加油车号,
        作业人员: job.作业人员,
        静电接地检查: grounding ? grounding.检查结果 : '未记录',
        status: job.status,
        pending: job.pending,
        abnormal: job.abnormal || warnings.length > 0,
        warnings,
      }
    })
    .sort((a, b) =>
      a.航班日期 === b.航班日期
        ? a.作业编号.localeCompare(b.作业编号)
        : a.航班日期.localeCompare(b.航班日期),
    )
}

/** 月度用量合计：月度报表与页面合计必须用这同一个函数，差一行都对不上即视为缺陷。 */
export function summarizeMonth(rows: FuelingUsageRow[], month: string): FuelingSummary {
  const scoped = rows.filter(
    (row) => row.归属月份 === month && row.status === FUELING_DONE_STATUS,
  )
  return {
    month,
    count: scoped.length,
    volume: scoped.reduce((sum, row) => sum + row.加注量, 0),
    amount: Math.round(scoped.reduce((sum, row) => sum + row.金额, 0) * 100) / 100,
  }
}

import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  getFuelingRows,
  resetFuelingDataset,
  updateFuelingJobStatus,
} from '@/data/fueling/store'
import { FUELING_KEY } from '@/data/fueling/types'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

/**
 * 航油加注的通用入口适配：三源对账后的统一行在这里投影成通用 EntryRow。
 * 任何拿着模块名走通用入口（列表、看板、后续操作）的地方，读到的航油数据
 * 都必须和航油页面、月度报表完全一致，不允许再出现第二套取数口径。
 */
function fuelingAsEntries(): EntryRow[] {
  return getFuelingRows().map((row) => ({
    id: row.id,
    status: row.status,
    pending: row.pending,
    abnormal: row.abnormal,
    作业编号: row.作业编号,
    航班号: row.航班号,
    航班日期: row.航班日期,
    归属月份: row.归属月份,
    油品规格: row.油品规格,
    加注量: row.加注量,
    单价: row.单价,
    金额: row.金额,
    加油车号: row.加油车号,
    作业人员: row.作业人员,
    静电接地检查: row.静电接地检查,
    作业状态: row.status,
  }))
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  if (key === FUELING_KEY) {
    const matched = filterRows(fuelingAsEntries(), filters)
    return { items: matched, total: matched.length, page: 1, size: matched.length }
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 航油状态流转改作业主档，改完立即重新对账落库，所有入口下一次读到的都是新值。
  if (key === FUELING_KEY) {
    return updateFuelingJobStatus(id, target)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  if (key === FUELING_KEY) {
    resetFuelingDataset()
    return listEntries(key)
  }
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  if (key === FUELING_KEY) {
    // 旧的全量清单导出口径已废弃：它就是漏加/重复/空文件三个毛病的来源。
    throw new Error('航油加注请使用「导出月度用量报表」入口（exportFuelingMonthlyReport）')
  }
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    if (meta.key === FUELING_KEY) {
      // 看板与航油页面读同一个对账结果，数量、待处理、异常量口径一致。
      const entries = getFuelingRows()
      return {
        name: meta.name,
        created: entries.length,
        pending: entries.filter((row) => row.pending).length,
        abnormal: entries.filter((row) => row.abnormal).length,
      }
    }
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

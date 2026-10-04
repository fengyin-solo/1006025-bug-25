/* 端到端验证（不入 src，不参与前端类型检查/打包）：用 esbuild 打包后在 node 里跑。 */
import { buildMonthlyReport, clearExportCheckpoint, getExportCheckpoint } from '../src/data/fueling/exporter'
import {
  getFuelingDataset,
  getFuelingRows,
  getFuelingMonthSummary,
  resetFuelingDataset,
  updateFuelingJobStatus,
} from '../src/data/fueling/store'
import { listEntries, loadOverview } from '../src/api/local-service'

let passed = 0
function check(name: string, cond: boolean, extra = '') {
  if (!cond) {
    console.error(`✗ ${name} ${extra}`)
    process.exit(1)
  }
  passed += 1
  console.log(`✓ ${name}`)
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ---------- 0. 旧版混存数据迁移：通用存储里的 fueling 占位键首次加载即摘除 ----------
window.localStorage.setItem(
  'airport-ground-ops:entries',
  JSON.stringify({ fueling: [{ id: 999, 作业编号: 'OLD-PLACEHOLDER' }] }),
)

// ---------- 1. 对账：去重 / 规格对齐 / 跨月回填 / 缺失不漏行 / 孤立数据不进统计 ----------
resetFuelingDataset()
check('旧通用入口的航油占位键已清除', window.localStorage.getItem('airport-ground-ops:entries') !== null && !JSON.parse(window.localStorage.getItem('airport-ground-ops:entries') ?? '{}').fueling)
check('迁移留痕', getFuelingDataset().logs.some((l) => l.type === 'cleanup_legacy'))
const rows = getFuelingRows()
const oct = rows.filter((r) => r.归属月份 === '2026-10')
const sep = rows.filter((r) => r.归属月份 === '2026-09')

// 同一条作业（FUEL-202610-004 重复读数）只出现一次
check('同一作业去重后只出现一次', oct.filter((r) => r.作业编号 === 'FUEL-202610-004').length === 1)
const j004 = oct.find((r) => r.作业编号 === 'FUEL-202610-004')!
check('重复读数保留正确加注量 9500', j004.加注量 === 9500 && j004.金额 === 9500 * 6.85)

// 规格对齐：FUEL-202610-003 计量点错记 3号喷气燃料，主档是 JET A-1
const j003 = oct.find((r) => r.作业编号 === 'FUEL-202610-003')!
check('加注量与油品规格两处对齐（主档 JET A-1）', j003.油品规格 === 'JET A-1' && j003.单价 === 6.85 && j003.金额 === 6200 * 6.85)

// 跨月回填：FUEL-202610-002 计量日期 11 月，按航班日期归属 10 月
const j002 = oct.find((r) => r.作业编号 === 'FUEL-202610-002')!
check('跨月计量按航班日期回填到 10 月', !!j002 && j002.加注量 === 12000)
check('11 月没有可归属的用量', rows.filter((r) => r.归属月份 === '2026-11').every((r) => r.status !== '已完成'))

// 已完成但漏读数/漏接地检查的作业不允许漏行
const j006 = oct.find((r) => r.作业编号 === 'FUEL-202610-006')!
check('已完成缺读数的作业仍出现且加注量为 0', j006.加注量 === 0 && j006.warnings.some((w) => w.includes('缺计量读数')))
check('静电接地检查缺失并入显示「未记录」', j006.静电接地检查 === '未记录')
const s002 = sep.find((r) => r.作业编号 === 'FUEL-202609-002')!
check('9 月已完成作业接地检查缺失并进来', s002.静电接地检查 === '未记录')

// 孤立读数/检查不进统计
check('孤立计量读数 R99 不产生行', !rows.some((r) => r.作业编号 === 'FUEL-202610-999'))
check('正常作业接地检查结果并入（复检合格）', j003.静电接地检查 === '复检合格')

// ---------- 2. 月度合计口径 ----------
const octSummary = getFuelingMonthSummary('2026-10')
const expectedVolume = 8600 + 12000 + 6200 + 9500 + 0
const expectedDone = 5 // 001..004 + 006（005 加注中、007 待加注不算）
check('10 月已完成架次', octSummary.count === expectedDone, String(octSummary.count))
check('10 月加注量合计（漏加的已补、跨月的归位、重复的去重）', octSummary.volume === expectedVolume, String(octSummary.volume))

// 对账日志留痕且幂等
const logsAfterFirst = getFuelingDataset().logs.length
getFuelingDataset()
getFuelingDataset()
check('对账幂等：重复读取不产生新修正日志', getFuelingDataset().logs.length === logsAfterFirst, `${logsAfterFirst} vs ${getFuelingDataset().logs.length}`)
check('对账日志覆盖去重/规格/跨月/缺失/孤立', ['dedup_reading','align_spec','correct_month','missing_reading','missing_grounding','orphan_reading','orphan_grounding']
  .every((t) => getFuelingDataset().logs.some((l) => l.type === t)))

// ---------- 3. 跨入口一致：通用列表 / 看板 与统一选择器同源 ----------
const generic = listEntries('fueling')
check('通用列表入口行数 == 统一选择器行数', generic.total === rows.length)
const generic004 = generic.items.find((r) => String(r.作业编号) === 'FUEL-202610-004')!
check('通用入口读到的加注量/规格/接地检查与统一行一致',
  Number(generic004.加注量) === 9500 && String(generic004.油品规格) === 'JET A-1' && String(generic004.静电接地检查) === '合格')
const overview = loadOverview()
const fuelCard = overview.modules.find((m) => m.name === '航油加注')!
check('运营概览航油登记量 == 作业主档条数（9），不被重复读数放大', fuelCard.created === 9, String(fuelCard.created))

// ---------- 4. 导出：与页面合计一致、无重复、接地检查已并入 ----------
const report = buildMonthlyReport('2026-10')
if (!report.ok) throw new Error('正常导出不应失败：' + report.error.message)
const lines = report.content.replace(/^﻿/, '').split('\n')
const header = lines[0]
check('报表表头含油品规格/加注量/静电接地检查', header.includes('油品规格') && header.includes('加注量(升)') && header.includes('静电接地检查'))
const dataLines = lines.slice(1, -1)
const totalLine = lines[lines.length - 1]
check('报表数据行数 == 已完成架次', dataLines.length === expectedDone, `${dataLines.length}`)
const jobNos = dataLines.map((l) => l.split(',')[0])
check('报表里同一作业编号不重复', new Set(jobNos).size === jobNos.length)
check('报表含接地检查列且 006 显示未记录',
  dataLines.find((l) => l.startsWith('FUEL-202610-006'))!.split(',')[10] === '未记录')
const totalVolume = Number(totalLine.split(',')[5])
const totalAmount = Number(totalLine.split(',')[7])
check('报表合计加注量 == 页面月度合计', totalVolume === octSummary.volume, `${totalVolume} vs ${octSummary.volume}`)
check('报表合计金额 == 页面月度合计金额', totalAmount === octSummary.amount, `${totalAmount} vs ${octSummary.amount}`)
check('导出成功后检查点已清，不留半成品', getExportCheckpoint('2026-10') === null)

// 9 月报表也能出且只有已完成的 2 单
const sepReport = buildMonthlyReport('2026-09')
if (!sepReport.ok) throw new Error('9 月导出失败')
check('9 月报表 2 行已完成', sepReport.content.split('\n').length - 2 === 2)

// ---------- 5. 中途失败：报阶段、检查点停留、续跑从断点继续 ----------
clearExportCheckpoint()
let failAt = 3
const failed = buildMonthlyReport('2026-10', {
  onProgress: (p) => {
    if (p.written === failAt) throw new Error('模拟浏览器断流')
  },
})
check('写第 3 行后失败被捕获', !failed.ok)
if (failed.ok) throw new Error('unreachable')
check('失败信息讲清阶段与位置', failed.error.message.includes('逐行生成') && failed.error.message.includes('FUEL-202610-004'))
check('失败可续跑', failed.resumable === true)
check('检查点停在第 3 行', eq(getExportCheckpoint('2026-10'), { written: 3, total: 5 }))

// 续跑：只生成剩余 2 行，最终内容与全量一致，合计行只出现一次
const resumed = buildMonthlyReport('2026-10')
if (!resumed.ok) throw new Error('续跑不应失败：' + resumed.error.message)
check('续跑标记为 true，跳过已生成 3 行', resumed.ok && resumed.resumed && resumed.skipped === 3)
check('续跑产物与全量产物逐字节一致', resumed.content === report.content)
check('续跑后合计行只出现一次', (resumed.content.match(/^合计/gm) ?? []).length === 1)

// ---------- 6. 源数据变动后旧检查点作废，不允许旧值行 ----------
clearExportCheckpoint()
buildMonthlyReport('2026-10', {
  onProgress: (p) => {
    if (p.written === 2) throw new Error('再次模拟中断')
  },
})
// 中断后业务侧把 FUEL-202610-007（待加注、无读数）流转成已完成 → 当月多一行零用量
const changed = updateFuelingJobStatus(9, '加注中')
check('状态流转成功', changed.ok)
updateFuelingJobStatus(9, '待确认')
updateFuelingJobStatus(9, '已完成')
const rebuilt = buildMonthlyReport('2026-10')
if (!rebuilt.ok) throw new Error('源数据变动后重跑不应失败')
check('源数据变动后整单重跑（非续跑）', rebuilt.resumed === false)
const rebuiltRows = rebuilt.content.split('\n').length - 2
check('重跑反映新口径：6 行已完成（含新完成的 007）', rebuiltRows === 6, String(rebuiltRows))
check('文件中出现的是新状态行（已完成），不是旧值', rebuilt.content.split('\n').some((l) => l.startsWith('FUEL-202610-007') && l.includes('已完成')))
const newSummary = getFuelingMonthSummary('2026-10')
const rebuiltTotal = Number(rebuilt.content.split('\n').slice(-1)[0].split(',')[5])
check('新口径下报表合计仍与页面合计一致', rebuiltTotal === newSummary.volume)

console.log(`\n全部 ${passed} 项验证通过`)

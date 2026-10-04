<template>
  <section class="page" data-module="fueling">
    <header class="page-head">
      <div>
        <h2>航油加注管理</h2>
        <p class="page-desc">
          作业主档、计量读数、静电接地检查三处数据统一对账：加注量与油品规格按作业编号对齐，
          月度用量与导出报表走同一个口径，同一作业只出现一次。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记加油作业</button>
        <button class="btn" type="button" :disabled="exporting" @click="exportMonth">
          导出月度用量报表
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="filter-bar">
      <label class="filter-item">
        <span>用量月份</span>
        <select v-model="month" @change="onMonthChange">
          <option v-for="value in months" :key="value" :value="value">{{ value }}</option>
        </select>
      </label>
      <span class="month-total">
        当月已完成 {{ monthSummary.count }} 架次 · 加注量合计
        <strong>{{ monthSummary.volume.toLocaleString() }}</strong> 升 · 金额
        <strong>{{ monthSummary.amount.toLocaleString() }}</strong> 元
      </span>
      <button class="btn ghost" type="button" @click="resetDemo">重置示例数据</button>
    </div>

    <div v-if="exportState.kind !== 'idle'" class="export-panel" :class="exportState.kind">
      <template v-if="exportState.kind === 'running'">
        <span>正在生成 {{ month }} 月度报表：{{ exportState.written }}/{{ exportState.total }} 行</span>
      </template>
      <template v-else-if="exportState.kind === 'done'">
        <span>
          {{ month }} 月度报表已下载（{{ exportState.total }} 行，
          <template v-if="exportState.resumed">断点续跑，跳过已生成 {{ exportState.skipped }} 行；</template>
          <template v-else>全量生成；</template>
          合计与页面一致）
        </span>
      </template>
      <template v-else>
        <span class="error-text">{{ exportState.message }}</span>
        <button class="btn" type="button" @click="retryExport">
          {{ exportState.retryLabel }}
        </button>
      </template>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>数据告警</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-warning': row.warnings.length }">
          <td v-for="column in columns" :key="column">{{ display(row, column) }}</td>
          <td>{{ row.warnings.join('；') || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无航油加注数据</td>
        </tr>
      </tbody>
    </table>

    <section v-if="repairLogs.length" class="repair-panel">
      <h3>存量数据对账修正记录（按航班日期回填，一次性留痕）</h3>
      <ul>
        <li v-for="(log, index) in repairLogs" :key="index">{{ log.detail }}</li>
      </ul>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条加油作业；报表合计与上方页面合计取数完全一致</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { runAction as applyAction } from '@/api/local-service'
import {
  buildMonthlyReport,
  clearExportCheckpoint,
  downloadMonthlyReport,
  getExportCheckpoint,
} from '@/data/fueling/exporter'
import {
  getFuelingMonthSummary,
  getFuelingMonths,
  getFuelingRepairLogs,
  getFuelingRows,
  resetFuelingDataset,
} from '@/data/fueling/store'
import type { FuelingUsageRow, RepairLog } from '@/data/fueling/types'

const columns = [
  '作业编号',
  '航班号',
  '航班日期',
  '油品规格',
  '加注量',
  '金额',
  '加油车号',
  '作业人员',
  '静电接地检查',
]
const allActions = ['开始加注', '提交确认', '确认完成']
const statuses = ['待加注', '加注中', '待确认', '已完成']

const rows = ref<FuelingUsageRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const months = ref<string[]>([])
const month = ref('')
const repairLogs = ref<RepairLog[]>([])
const exporting = ref(false)
// 内容已完整生成、只差浏览器下载时，重试直接重下，不必重跑取数/逐行阶段
let lastBuilt: { month: string; filename: string; content: string } | null = null

type ExportPanelState =
  | { kind: 'idle' }
  | { kind: 'running'; written: number; total: number }
  | { kind: 'done'; total: number; resumed: boolean; skipped: number }
  | { kind: 'failed'; message: string; retryLabel: string }

const exportState = ref<ExportPanelState>({ kind: 'idle' })

const monthSummary = computed(() => getFuelingMonthSummary(month.value))

const stats = computed(() => {
  const all = getFuelingRows()
  const today = '2026-10-04'
  return [
    { label: '今日加油架次', value: all.filter((row) => row.航班日期 === today).length },
    { label: '加注中作业', value: all.filter((row) => row.status === '加注中').length },
    {
      label: `${month.value} 加注量(升)`,
      value: monthSummary.value.volume.toLocaleString(),
    },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

function actionsFor(row: FuelingUsageRow): string[] {
  // 状态流：待加注→加注中→待确认→已完成，只亮下一步动作，不允许跳步造成重复流转
  const index = statuses.indexOf(row.status)
  return index >= 0 && index < allActions.length ? [allActions[index]] : []
}

function display(row: FuelingUsageRow, column: string): string {
  if (column === '加注量') {
    return row.加注量.toLocaleString()
  }
  if (column === '金额') {
    return row.金额.toLocaleString()
  }
  const value = row[column as keyof FuelingUsageRow]
  return value === undefined || value === '' ? '—' : String(value)
}

function reload() {
  errorMessage.value = ''
  // 页面表格直接读统一选择器，和月度合计、月度报表导出是同一份结果
  rows.value = getFuelingRows()
  total.value = rows.value.length
  months.value = getFuelingMonths()
  if (!month.value || !months.value.includes(month.value)) {
    month.value = months.value[0] ?? ''
  }
  repairLogs.value = getFuelingRepairLogs()
  syncCheckpointPanel()
}

function syncCheckpointPanel() {
  const checkpoint = month.value ? getExportCheckpoint(month.value) : null
  exportState.value = checkpoint
    ? {
        kind: 'failed',
        message: `检测到 ${month.value} 报表上次在「逐行生成」阶段中断（已生成 ${checkpoint.written}/${checkpoint.total} 行），续跑将从中断的下一条继续`,
        retryLabel: '从断点继续重试',
      }
    : { kind: 'idle' }
}

function onMonthChange() {
  syncCheckpointPanel()
}

function exportMonth() {
  lastBuilt = null
  runBuild()
}

function retryExport() {
  // 下载阶段失败：内容还在内存里，直接重新下载；其它阶段失败则重新构建（检查点负责续跑）
  if (lastBuilt && lastBuilt.month === month.value) {
    doDownload(lastBuilt.filename, lastBuilt.content)
    return
  }
  runBuild()
}

function runBuild() {
  if (!month.value) {
    errorMessage.value = '没有可导出的月份'
    return
  }
  exporting.value = true
  exportState.value = { kind: 'running', written: 0, total: 0 }
  const outcome = buildMonthlyReport(month.value, {
    onProgress: (point) => {
      exportState.value = { kind: 'running', written: point.written, total: point.total }
    },
  })
  exporting.value = false
  if (!outcome.ok) {
    // 错误信息自带阶段名（取数/逐行生成/产出文件）和中断行
    exportState.value = {
      kind: 'failed',
      message: outcome.error.message,
      retryLabel: outcome.resumable ? '从断点继续重试' : '重新导出',
    }
    errorMessage.value = outcome.error.message
    return
  }
  lastBuilt = { month: month.value, filename: outcome.filename, content: outcome.content }
  doDownload(outcome.filename, outcome.content, outcome)
}

function doDownload(
  filename: string,
  content: string,
  outcome?: { resumed: boolean; skipped: number },
) {
  // 只有内容完整生成后才会触发下载：前面任一阶段失败，浏览器都不会产生空文件
  try {
    downloadMonthlyReport(filename, content)
  } catch (error) {
    exportState.value = {
      kind: 'failed',
      message: `报表已完整生成，但在「产出文件」（浏览器下载）阶段失败：${
        error instanceof Error ? error.message : '未知原因'
      }，内容已保留，可直接再试一次`,
      retryLabel: '再试一次（重新下载）',
    }
    return
  }
  exportState.value = {
    kind: 'done',
    total: monthSummary.value.count,
    resumed: outcome?.resumed ?? false,
    skipped: outcome?.skipped ?? 0,
  }
}

function openCreate() {
  errorMessage.value = '加油作业登记入口尚未接入审批流'
}

function runAction(action: string, row: FuelingUsageRow) {
  errorMessage.value = ''
  const result = applyAction('fueling', row.id, action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  // 状态变更立即重新对账落库：转为已完成后该行与合计同步进入当月口径，导出读到同一值
  reload()
}

function resetDemo() {
  resetFuelingDataset()
  clearExportCheckpoint()
  lastBuilt = null
  month.value = ''
  exportState.value = { kind: 'idle' }
  reload()
}

onMounted(reload)
</script>

<style scoped>
.month-total {
  font-size: 14px;
  color: #334155;
}
.month-total strong {
  color: #0f766e;
}
.export-panel {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 14px;
  border: 1px solid #cbd5e1;
  background: #f8fafc;
}
.export-panel.done {
  border-color: #10b981;
  background: #ecfdf5;
}
.export-panel.failed {
  border-color: #f59e0b;
  background: #fffbeb;
}
.row-warning td {
  background: #fff7ed;
}
.repair-panel {
  margin-top: 16px;
  padding: 12px 16px;
  border: 1px dashed #94a3b8;
  border-radius: 6px;
  font-size: 13px;
}
.repair-panel h3 {
  margin: 0 0 8px;
  font-size: 14px;
}
.repair-panel ul {
  margin: 0;
  padding-left: 18px;
}
</style>

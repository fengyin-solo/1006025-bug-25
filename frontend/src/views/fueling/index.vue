<template>
  <section class="page" data-module="fueling">
    <header class="page-head">
      <div>
        <h2>航油加注管理</h2>
        <p class="page-desc">维护加油作业，围绕作业编号、航班号、油品规格、加注量做登记、筛选与状态流转；月度用量与导出共用同一口径。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记加油作业</button>
        <button class="btn" type="button" :disabled="exporting" @click="exportRows(false)">
          {{ exportState?.resumed ? '继续导出月度用量' : '导出月度用量报表' }}
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="export-panel" :class="{ failed: exportFailure, done: exportSuccess }">
      <label class="month-picker">
        <span>统计月份</span>
        <input v-model="month" type="month" @change="reload" />
      </label>
      <div v-if="exporting" class="export-progress">
        正在生成报表：第 {{ exportProgress.done }}/{{ exportProgress.total }} 条
        <span v-if="exportProgress.stage">（{{ stageLabel(exportProgress.stage) }}）</span>
      </div>
      <div v-else-if="exportFailure" class="export-failure">
        <span>{{ exportFailure }}</span>
        <button class="btn" type="button" @click="exportRows(true)">从断点重试</button>
      </div>
      <div v-else-if="exportSuccess" class="export-success">
        {{ exportSuccess }}
      </div>
      <div v-else-if="pendingExport" class="export-pending" :class="{ stale: pendingExport.kind === 'stale' }">
        <template v-if="pendingExport.kind === 'resumable'">
          上次导出在{{ stageLabel(pendingExport.stage) }}中断（第 {{ pendingExport.nextIndex + 1 }}/{{ pendingExport.total }} 条）：{{ pendingExport.message }}
        </template>
        <template v-else>{{ pendingExport.message }}</template>
        <button class="btn" type="button" @click="exportRows(true)">
          {{ pendingExport.kind === 'resumable' ? '从断点重试' : '按最新数据重新导出' }}
        </button>
      </div>
      <div v-else class="export-hint">
        月度合计口径：仅统计{{ month }}内「已完成」作业，与导出文件逐行一致。
      </div>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
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
          <td :colspan="columns.length + 2" class="empty-state">{{ month }} 暂无航油加注数据</td>
        </tr>
      </tbody>
      <tfoot>
        <tr class="summary-row">
          <td :colspan="volumeColumnIndex">本月已完成合计</td>
          <td>{{ summary.totalVolume }}</td>
          <td>{{ summary.totalAmount }}</td>
          <td :colspan="columns.length - amountColumnIndex"></td>
        </tr>
      </tfoot>
    </table>

    <footer class="page-foot">
      <span>{{ month }} 共 {{ total }} 条加油作业，已完成 {{ summary.completedCount }} 条</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  currentReportMonth,
  exportMonthlyFuelingUsage,
  fuelingStats,
  listFuelingEntries,
  monthlyUsageRows,
  pendingFuelingExport,
  runFuelingAction,
  summarizeUsage,
  type ExportStage,
} from '@/api/fueling-service'
import type { EntryRow } from '@/data/types'

const columns = ['作业编号', '航班号', '航班日期', '油品规格', '加注量', '加注金额', '加油车号', '作业人员', '静电接地检查']
const statuses = ['待加注', '加注中', '待确认', '已完成']
const nextActionByStatus: Record<string, string> = {
  待加注: '开始加注',
  加注中: '提交确认',
  待确认: '确认完成',
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const summary = ref(summarizeUsage(currentReportMonth(), []))
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const month = ref(currentReportMonth())
const filterFields = columns.slice(0, 3)
const exporting = ref(false)
const exportState = ref<{ resumed: boolean } | null>(null)
const exportProgress = ref({ done: 0, total: 0, stage: '' as ExportStage | '' })
const exportFailure = ref('')
const exportSuccess = ref('')
const pendingExport = ref<ReturnType<typeof pendingFuelingExport>>(null)

const volumeColumnIndex = columns.indexOf('加注量')
const amountColumnIndex = columns.indexOf('加注金额')

const stats = computed(() => {
  const values = fuelingStats(month.value)
  return [
    { label: '今日完成加油架次', value: values.todayCompleted },
    { label: '本月加注中作业', value: values.inProgress },
    { label: '本月加注量（升）', value: values.monthVolume },
    { label: '本月加注金额（元）', value: values.monthAmount },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function stageLabel(stage: ExportStage): string {
  return {
    prepare: '准备数据',
    'write-row': '逐行写入',
    'build-file': '生成文件',
    'save-file': '保存文件',
    'persist-record': '登记导出记录',
  }[stage]
}

function availableActions(row: EntryRow): string[] {
  const action = nextActionByStatus[String(row.status)]
  return action ? [action] : []
}

function resetFilters() {
  filters.value = {}
  reload()
}

async function exportRows(resume = false) {
  errorMessage.value = ''
  exportFailure.value = ''
  exportSuccess.value = ''
  exporting.value = true
  exportState.value = { resumed: resume }
  const usage = monthlyUsageRows(month.value)
  const pending = pendingFuelingExport(month.value)
  exportProgress.value = {
    done: resume && pending?.kind === 'resumable' ? pending.nextIndex : 0,
    total: usage.length,
    stage: 'prepare',
  }

  // 用 storage 事件之外的轻量轮询读取断点，失败页也能展示已完成到哪一条。
  const timer = window.setInterval(() => {
    const pending = pendingFuelingExport(month.value)
    if (pending) {
      exportProgress.value = { done: pending.nextIndex, total: pending.total, stage: pending.stage }
    }
  }, 60)

  try {
    const result = await exportMonthlyFuelingUsage(month.value)
    if (result.ok) {
      exportProgress.value = { done: result.receipt.count, total: result.receipt.count, stage: '' }
      const prefix = result.discardedStale
        ? '中断后源数据有修正，已按最新数据重新生成。'
        : result.resumed
          ? '已从断点续导。'
          : ''
      exportSuccess.value = `${prefix}已导出 ${result.filename}：${result.receipt.count} 条，加注量 ${result.receipt.totalVolume} 升，金额 ${result.receipt.totalAmount} 元`
    } else {
      exportProgress.value = { done: result.nextIndex, total: result.total, stage: result.stage }
      exportFailure.value = result.message
    }
  } catch (error) {
    exportFailure.value = error instanceof Error ? error.message : '导出失败，未定位到具体步骤'
  } finally {
    window.clearInterval(timer)
    exporting.value = false
    pendingExport.value = pendingFuelingExport(month.value)
    reload()
  }
}

function openCreate() {
  errorMessage.value = '加油作业登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = runFuelingAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  exportFailure.value = ''
  exportSuccess.value = ''
  try {
    const payload = listFuelingEntries({ month: month.value, filters: filters.value })
    rows.value = payload.items
    total.value = payload.total
    summary.value = payload.summary
    pendingExport.value = pendingFuelingExport(month.value)
    exportState.value = pendingExport.value?.kind === 'resumable' ? { resumed: true } : null
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '航油加注列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.page-actions {
  display: flex;
  gap: 8px;
}
.export-panel {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}
.export-panel.failed {
  border-color: #f0a8a0;
  background: #fef3f2;
}
.export-panel.done {
  border-color: #9ad8b0;
  background: #f1fbf4;
}
.month-picker span {
  display: block;
  font-size: 12px;
  color: var(--muted);
}
.export-failure,
.export-success,
.export-pending {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.export-failure {
  color: #b42318;
}
.export-pending.stale {
  color: #b54708;
}
.export-success {
  color: #1a7f37;
}
.export-hint {
  color: var(--muted);
}
.summary-row td {
  font-weight: 600;
  background: #f8fafc;
}
</style>

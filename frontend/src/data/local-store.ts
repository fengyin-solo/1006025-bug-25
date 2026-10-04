import {
  FUELING_DATA_VERSION,
  reconcileFuelingRows,
  stabilizeFuelingRows,
  type FuelingLegacyRow,
  type FuelingReconcileAudit,
} from './fueling-domain'
import {
  FUELING_GROUNDING_LEDGER_SEED,
  FUELING_SPEC_LEDGER_SEED,
  FUELING_USAGE_LEDGER_SEED,
  SEED_ROWS,
} from './seed'
import type { EntryRow } from './types'

// v2 持久化：所有入口读同一个规范化后的库；旧 v1 数据只在迁移时读取一次。
const STORAGE_KEY = 'airport-ground-ops:entries:v2'
const LEGACY_STORAGE_KEY = 'airport-ground-ops:entries'
const FUELING_AUDIT_KEY = 'airport-ground-ops:fueling-reconcile-audit'
const FUELING_USAGE_LEDGER_KEY = 'airport-ground-ops:fueling-usage-ledger'
const FUELING_SPEC_LEDGER_KEY = 'airport-ground-ops:fueling-spec-ledger'
const FUELING_GROUNDING_LEDGER_KEY = 'airport-ground-ops:fueling-grounding-ledger'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function readJson(key: string): unknown | null {
  if (!hasStorage()) {
    return null
  }
  const raw = window.localStorage.getItem(key)
  if (raw === null) {
    return null
  }
  return JSON.parse(raw)
}

function writeJson(key: string, value: unknown): void {
  if (hasStorage()) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

function isEntryRows(value: unknown): value is Record<string, EntryRow[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.values(value as Record<string, unknown>).every((rows) => Array.isArray(rows))
}

function legacyLedger(key: string, fallback: FuelingLegacyRow[]): FuelingLegacyRow[] {
  const value = readJson(key)
  return Array.isArray(value) ? (value as FuelingLegacyRow[]) : clone(fallback)
}

function canonicalSeed(): Record<string, EntryRow[]> {
  const seed = clone(SEED_ROWS)
  const reconciled = reconcileFuelingRows({
    main: seed.fueling,
    usage: clone(FUELING_USAGE_LEDGER_SEED),
    spec: clone(FUELING_SPEC_LEDGER_SEED),
    grounding: clone(FUELING_GROUNDING_LEDGER_SEED),
  })
  seed.fueling = reconciled.rows
  return seed
}

function migrateLegacy(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  const legacyRaw = hasStorage() ? window.localStorage.getItem(LEGACY_STORAGE_KEY) : null

  let merged: Record<string, EntryRow[]>
  if (legacyRaw !== null) {
    const parsed = JSON.parse(legacyRaw) as Record<string, EntryRow[]>
    merged = { ...fallback, ...parsed }
  } else {
    merged = fallback
  }

  const reconciled = reconcileFuelingRows({
    main: merged.fueling ?? [],
    usage: legacyLedger(FUELING_USAGE_LEDGER_KEY, FUELING_USAGE_LEDGER_SEED),
    spec: legacyLedger(FUELING_SPEC_LEDGER_KEY, FUELING_SPEC_LEDGER_SEED),
    grounding: legacyLedger(FUELING_GROUNDING_LEDGER_KEY, FUELING_GROUNDING_LEDGER_SEED),
  })
  merged.fueling = reconciled.rows
  writeJson(STORAGE_KEY, merged)

  const audit: FuelingReconcileAudit = {
    ...reconciled.audit,
    version: legacyRaw === null ? `${FUELING_DATA_VERSION}:seed` : FUELING_DATA_VERSION,
  }
  writeJson(FUELING_AUDIT_KEY, audit)
  return merged
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = canonicalSeed()
  if (!hasStorage()) {
    return fallback
  }

  const current = window.localStorage.getItem(STORAGE_KEY)
  if (current === null) {
    return migrateLegacy()
  }

  try {
    const parsed = readJson(STORAGE_KEY)
    if (isEntryRows(parsed)) {
      return parsed
    }
    throw new Error('v2 数据格式不是按模块分组的记录数组')
  } catch (error) {
    // 与旧版一致：数据损坏时回到种子数据；保留错误信息，避免静默吞掉根因。
    console.warn(`[local-store] 读取 ${STORAGE_KEY} 失败，已回退到初始数据：`, error)
    writeJson(STORAGE_KEY, fallback)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const normalized = key === 'fueling' ? stabilizeFuelingRows(rows) : rows
  const next = { ...allRows(), [key]: normalized }
  cache = next
  writeJson(STORAGE_KEY, next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = key === 'fueling' ? canonicalSeed().fueling : clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function lastFuelingAudit(): FuelingReconcileAudit | null {
  const value = readJson(FUELING_AUDIT_KEY)
  return value && typeof value === 'object' ? (value as FuelingReconcileAudit) : null
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function legacyStorageKeys(): string[] {
  return [
    LEGACY_STORAGE_KEY,
    FUELING_USAGE_LEDGER_KEY,
    FUELING_SPEC_LEDGER_KEY,
    FUELING_GROUNDING_LEDGER_KEY,
  ]
}

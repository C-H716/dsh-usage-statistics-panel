/**
 * The usage-history durable store. Records accumulate into one storage
 * domain (`usage_history`) with two tables over the same samples:
 *
 * - `days`, keyed `YYYY-MM-DD|provider|model`: the four token buckets plus
 *   per-day counters (requests, turns) and the uncached-input cache-miss side;
 * - `hours`, keyed `YYYY-MM-DDTHH|provider|model`: the same token buckets cut
 *   by hour, which is what makes a correct cost figure possible — DeepSeek
 *   bills input and output at double the rate inside its peak windows
 *   (09:00-12:00 and 14:00-18:00 Beijing time on weekdays), and those windows
 *   begin and end on whole hours.
 *
 * Writes go through `KvTable.update()` (atomic read-modify-write queued per
 * key), so concurrent turns never interleave. The backend persists the domain
 * to `$DSH_HOME/storages/usage_history.json` (storage-json).
 *
 * The layout mirrors the reasonix daily-JSONL design (one row per day ×
 * model) with the aggregation moved into the storage layer: a query reads
 * the table entries intersecting the range instead of decoding per-day files.
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { UsageStorageDomain, UsageKvTable, UsageDomain } from './context-types.ts'
import type { UsageSample } from './query.ts'
import { providerOf } from './query.ts'
import { hourKey } from './shared.ts'
import { z } from 'zod'

/** True when a KvTable.update() failure is the "no record to update" miss
 *  (the storage-domain error for an absent key) — the retry path seeds the
 *  row and re-applies. */
function isMissingRecord(err: unknown): boolean {
  return err instanceof Error && /no record .* to update/.test(err.message)
}

/** One row: a model's usage on one local calendar day. */
export interface UsageDayRow {
  day: string // "YYYY-MM-DD"
  provider: string
  model: string // canonical "provider/model"; "(unknown)" for unlabelled
  inputTokens: number // uncached input (the cache-miss side)
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number // usage events (API calls) that day, this model
  turns: number // completed turns attributed to this model that day
  lastSeen: number // epoch ms of the newest sample
}

export const usageDayRowSchema = z.object({
  day: z.string(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  requests: z.number(),
  turns: z.number(),
  lastSeen: z.number(),
})

/** One row: a model's usage in one local calendar hour.
 *
 *  The hour table exists because cost cannot be derived from a day total:
 *  DeepSeek bills input and output at double the rate during its peak windows
 *  (09:00-12:00 and 14:00-18:00 Beijing time on weekdays), and those windows
 *  start and end on whole hours. One hour key therefore carries the complete
 *  pricing tier of every sample inside it, and summing per-hour charges
 *  reproduces the exact bill.
 *
 *  Turn markers carry no tokens and no cost, so they stay in the day table
 *  only; requests are kept here because an hourly call count is part of the
 *  consumption picture the panel draws. */
export interface UsageHourRow {
  hour: string // "YYYY-MM-DDTHH", local calendar
  provider: string
  model: string // canonical "provider/model"; "(unknown)" for unlabelled
  inputTokens: number // uncached input (the cache-miss side)
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number
  lastSeen: number // epoch ms of the newest sample
}

export const usageHourRowSchema = z.object({
  hour: z.string(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  requests: z.number(),
  lastSeen: z.number(),
})

/** The domain's global singleton: the backfill cursor. Session ids already
 *  replayed into the store live here, so a reboot's backfill only folds
 *  sessions it has never seen (a full replay would double every counter —
 *  the fold's replace semantics only dedupe within one pass).
 *
 *  `liveFirstSeq` records, per session, the EXCLUSIVE END of the range a
 *  backfill may replay: [0, value) is backfill-owned, [value, ∞) is
 *  live-path-owned. It is written at two moments — when the live listener
 *  first observes a session (that first event's seq, or -1 when the boundary
 *  was unknown), and by /reset (the session's wipe-time log length, because
 *  the wipe destroyed everything below it and the rebuild must reconstruct
 *  exactly that span from the log). The next boot's backfill replays exactly
 *  the prefix before the boundary. */
export const usageHistoryDomain = defineDomain({
  name: 'usage_history',
  version: 1,
  global: {
    schema: z.object({
      backfilledSessions: z.array(z.string()),
      liveFirstSeq: z.record(z.string(), z.number()).optional(),
    }),
    initial: { backfilledSessions: [] as string[], liveFirstSeq: {} },
  },
  tables: {
    days: domainTable<string, UsageDayRow>(usageDayRowSchema),
    hours: domainTable<string, UsageHourRow>(usageHourRowSchema),
  },
})

/** key: `day|provider|model`. */
export function dayRowKey(day: string, provider: string, model: string): string {
  return `${day}|${provider}|${model}`
}

/** key: `hour|provider|model`. */
export function hourRowKey(hour: string, provider: string, model: string): string {
  return `${hour}|${provider}|${model}`
}

/** The domain global's value: the backfill cursor (see the
 *  `usageHistoryDomain` doc for the field semantics). */
interface UsageCursor {
  backfilledSessions?: string[]
  liveFirstSeq?: Record<string, number>
}

export class UsageStore {
  private table: UsageKvTable<string, UsageDayRow> | null = null
  /** The per-hour table backing every cost figure (see UsageHourRow). */
  private hourTable: UsageKvTable<string, UsageHourRow> | null = null
  private domainHandle: UsageDomain | null = null
  private ready: Promise<void>
  /** Set when the domain could not be opened (already-open race, corrupted
   *  file, ...). The store then runs DEGRADED: every operation fails
   *  per-call with a clear error and nothing persists, but no rejecting
   *  promise is ever left unobserved — an escaping rejection here used to
   *  be able to take the whole host down. */
  private openError?: unknown
  /** Serializes read-modify-write cycles on the backfill cursor. The domain
   *  only guarantees single-write ordering on its chain — a global.set is a
   *  whole-value overwrite, so two concurrent markSeenSessions calls would
   *  interleave get→set and lose one caller's ids (lost update). Chaining
   *  through this promise makes every get→set pair atomic within the
   *  process, which is the only concurrency that exists here. */
  private markChain: Promise<void> = Promise.resolve()

  constructor(ctx: UsageStorageDomain) {
    // initialize() absorbs EVERY failure (sync throw surfaced through an
    // async boundary included): this.ready must always resolve, so awaiting
    // it can never itself become the unhandled rejection that kills the
    // process. Callers observe degradation per operation via requireTable().
    this.ready = this.initialize(ctx)
      .catch((err) => { this.openError = err })
  }

  private async initialize(ctx: UsageStorageDomain): Promise<void> {
    const domain = await ctx.open(usageHistoryDomain)
    this.domainHandle = domain
    this.table = domain.table('days') as UsageKvTable<string, UsageDayRow>
    this.hourTable = domain.table('hours') as UsageKvTable<string, UsageHourRow>
    // One-time rebuild of pre-cursor rows (≤0.1.1 wrote the old request
    // semantics and no turns at all): rows paired with a completely empty
    // cursor cannot be told apart from a half-written new-world store, and
    // both recover by dropping the rows and letting the backfill replay
    // from scratch. The same path also heals a reset() torn by a crash
    // mid-wipe: reset() writes its empty cursor first, so leftover rows
    // always meet an empty cursor here. Running inside ready() means every
    // later record, mark, or cursor read — including the live listener's
    // first writes — lands after the decision, so no ordering race exists.
    const value = domain.global?.get() as { backfilledSessions?: string[] } | undefined
    const cursorEmpty = (value?.backfilledSessions?.length ?? 0) === 0
    const hasDayRows = this.table.keys().next().done === false
    if ((cursorEmpty && hasDayRows) || this.hourRebuildNeeded()) {
      for (const key of [...this.table.keys()]) await this.table.delete(key)
      for (const key of [...(this.hourTable?.keys() ?? [])]) await this.hourTable?.delete(key)
      // Drop the cursor in the same breath: the hour table is rebuilt from the
      // session logs, and a surviving "already replayed" cursor would make the
      // follow-up backfill skip every session whose usage the wipe just
      // destroyed. An empty cursor makes the next boot replay all of them.
      await this.domainHandle?.global?.set({ backfilledSessions: [], liveFirstSeq: {} })
    }
  }

  /** Whether the hour table must be rebuilt from the session logs.
   *
   *  The hour table was added after the day table shipped, so a store written
   *  by an earlier build holds day rows with no per-hour counterpart — and a
   *  day total cannot be split back into hours, because DeepSeek's peak and
   *  off-peak windows (09:00-12:00 and 14:00-18:00 Beijing time on weekdays)
   *  bill the same tokens at double the rate.
   *
   *  The condition is derived from the data rather than a stored revision: hour
   *  rows exist exactly when some build populated them, so an empty hour table
   *  beside token-bearing day rows means the rebuild never ran. Once the
   *  backfill refills the hour table the condition turns false on its own, so
   *  this cannot re-trigger on every boot, and a rebuild interrupted by a crash
   *  simply runs again. Request-only or turn-only rows carry no tokens and no
   *  cost, so a store holding nothing else needs no rebuild. */
  private hourRebuildNeeded(): boolean {
    if (this.hourTable === null) return false
    if (this.hourTable.keys().next().done === false) return false
    for (const [, row] of this.table?.entries() ?? []) {
      if (row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens > 0) return true
    }
    return false
  }

  /** The open failure when running degraded, else undefined (diagnostics). */
  get degradation(): unknown {
    return this.openError
  }

  /** Session ids already replayed into the store (the backfill cursor).
   *  A medium without a global (pre-cursor rows) yields an empty set, which
   *  would replay everything once — acceptable only for a fresh install, so
   *  callers pairing this with markSeenSessions still converge after one
   *  pass. */
  async seenSessions(): Promise<Set<string>> {
    await this.ready
    const value = this.cursor()
    return new Set(value?.backfilledSessions ?? [])
  }

  /** Per-session seq of the first LIVE-observed event (see the domain's
   *  `liveFirstSeq` doc). -1 = observed with an unknown boundary. */
  async liveSequences(): Promise<Map<string, number>> {
    await this.ready
    const value = this.cursor()
    return new Map(Object.entries(value?.liveFirstSeq ?? {}))
  }

  private cursor(): UsageCursor | undefined {
    return this.domainHandle?.global?.get() as UsageCursor | undefined
  }

  /** The cursor value for a read-modify-write cycle. Degraded stores fail
   *  here too: the cursor-writing methods must honor the same per-call
   *  failure contract as record() — silently succeeding while persisting
   *  nothing would make callers believe a replay boundary was durable. */
  private requireCursor(): UsageCursor {
    if (this.openError !== undefined) {
      const detail = this.openError instanceof Error ? this.openError.message : String(this.openError)
      throw new Error(`usage store degraded (domain unavailable: ${detail})`)
    }
    return this.cursor() ?? {}
  }

  /** Persist session ids as replayed (merges into the cursor). Calls are
   *  serialized through {@link markChain} so concurrent workers never lose
   *  each other's ids in a get→set interleaving. */
  async markSeenSessions(ids: Iterable<string>): Promise<void> {
    const write = this.markChain.then(async () => {
      await this.ready
      const value = this.requireCursor()
      const seen = new Set(value.backfilledSessions ?? [])
      for (const id of ids) seen.add(id)
      await this.domainHandle?.global?.set({
        backfilledSessions: [...seen],
        liveFirstSeq: value.liveFirstSeq ?? {},
      })
    })
    // Keep the chain alive regardless of failure: one rejected write must
    // not poison every later mark (the caller observes the rejection).
    this.markChain = write.then(
      () => undefined,
      () => undefined,
    )
    return write
  }

  /** Record the first LIVE-observed seq per session (merges; the EARLIEST
   *  boundary wins — it is the safe partition point for prefix replays).
   *  Serialized through {@link markChain} like every other global rewrite. */
  async markLiveSequences(entries: Iterable<readonly [string, number]>): Promise<void> {
    const write = this.markChain.then(async () => {
      await this.ready
      const value = this.requireCursor()
      const merged: Record<string, number> = { ...(value.liveFirstSeq ?? {}) }
      let changed = false
      for (const [id, seq] of entries) {
        const prev = merged[id]
        if (prev === undefined || seq < prev) {
          merged[id] = seq
          changed = true
        }
      }
      if (!changed) return
      await this.domainHandle?.global?.set({
        backfilledSessions: value.backfilledSessions ?? [],
        liveFirstSeq: merged,
      })
    })
    this.markChain = write.then(
      () => undefined,
      () => undefined,
    )
    return write
  }

  /** Drop every row and the whole cursor, re-bounding each named session at
   *  its WIPE-TIME WATERMARK (the store-rebuild escape hatch for corrupted
   *  history or attribution-logic upgrades).
   *
   *  The watermark matters because the wipe destroys the live path's already-
   *  recorded samples too: a still-open session's post-attach usage exists in
   *  no log-replay-free zone — it MUST be reconstructed from the persisted
   *  log like everything else. Bounding that session at its old attach
   *  boundary would make the follow-up backfill replay only the pre-attach
   *  prefix and strand the live-recorded span forever; bounding it at the
   *  log length captured at wipe time makes the backfill rebuild exactly the
   *  destroyed range [0, watermark) once, while events from the watermark on
   *  stay exclusive to the still-running live path. Sessions without a
   *  usable watermark carry the -1 sentinel (replay nothing — never risk a
   *  duplicate). */
  async reset(boundaries?: ReadonlyMap<string, number>): Promise<void> {
    const write = this.markChain.then(async () => {
      await this.ready
      const table = this.requireTable()
      const liveFirstSeq: Record<string, number> = {}
      if (boundaries) {
        for (const [id, seq] of boundaries) liveFirstSeq[id] = seq
      }
      // Crash-safe order: the cursor lands BEFORE the row wipe. A crash in
      // between then leaves rows behind an EMPTY cursor, which the
      // open-time rebuild drops before any replay; the reverse order would
      // leave an empty store behind an old "already seen" cursor, so the
      // next boot's backfill would skip every session (silent loss).
      await this.domainHandle?.global?.set({ backfilledSessions: [], liveFirstSeq })
      for (const key of [...table.keys()]) await table.delete(key)
    })
    this.markChain = write.then(
      () => undefined,
      () => undefined,
    )
    return write
  }

  /** Opens the domain (lazily awaited by every operation). */
  async readyPromise(): Promise<void> {
    await this.ready
  }

  private requireTable(): UsageKvTable<string, UsageDayRow> {
    if (this.openError !== undefined) {
      const detail = this.openError instanceof Error ? this.openError.message : String(this.openError)
      throw new Error(`usage store degraded (domain unavailable: ${detail})`)
    }
    if (!this.table) throw new Error('usage store not ready')
    return this.table
  }

  /** Fold one atomic usage sample (a completed call or a turn marker) into
   *  the day's row. Turn markers carry no model attribution (reasonix
   *  records them per source, not per model).
   *
   *  KvTable.update() requires an existing key ("no record to update"
   *  otherwise), so a miss is retried once after seeding the row with put().
   *  The put/update pair is not atomic against a concurrent writer for the
   *  same key, but the collector's fold dedupes by (turn, step) and the live
   *  listener + backfill never write the same key twice concurrently; the
   *  retry covers the first-writer race. */
  async record(sample: UsageSample): Promise<void> {
    await this.ready
    const table = this.requireTable()
    const day = sample.day
    const provider = sample.turn ? 'default' : providerOf(sample.model && sample.model !== '' ? sample.model : '(unknown)')
    const model = sample.turn ? '(turns)' : sample.model && sample.model !== '' ? sample.model : '(unknown)'
    // The hour row is a second, orthogonal cut of the same sample: the day
    // table answers "how much on this date", the hour table answers "at what
    // price", because the peak and off-peak windows are hour-aligned. Turn
    // markers carry neither tokens nor cost and stay in the day table only.
    if (!sample.turn) await this.recordHour(sample, provider, model)
    const key = dayRowKey(day, provider, model)
    const apply = (cur: UsageDayRow | undefined): UsageDayRow => {
      const base = cur ?? emptyRow(day, provider, model)
      if (sample.turn) {
        return { ...base, turns: base.turns + 1, lastSeen: Date.now() }
      }
      if (sample.request) {
        // A provider-call marker (step/start or a started retry): one request,
        // no tokens — reasonix counts failed calls too. Requests are counted
        // ONLY here: a successful call also produces a usage sample, and
        // counting both would double every call.
        return { ...base, requests: base.requests + 1, lastSeen: Date.now() }
      }
      return {
        ...base,
        inputTokens: base.inputTokens + sample.inputTokens,
        outputTokens: base.outputTokens + sample.outputTokens,
        cacheReadTokens: base.cacheReadTokens + sample.cacheReadTokens,
        cacheWriteTokens: base.cacheWriteTokens + sample.cacheWriteTokens,
        lastSeen: Date.now(),
      }
    }
    try {
      await table.update(key, apply)
    } catch (err) {
      if (isMissingRecord(err)) {
        await table.put(key, emptyRow(day, provider, model))
        await table.update(key, apply)
        return
      }
      throw err
    }
  }

  /** Fold one non-turn sample into its hour row.
   *
   *  Mirrors {@link record}'s day write, including the seed-then-update retry
   *  for an absent key, so a first-writer race cannot drop an hour bucket. */
  private async recordHour(sample: UsageSample, provider: string, model: string): Promise<void> {
    const table = this.hourTable
    if (table === null) return
    const hour = hourKey(hourKeySource(sample))
    const key = hourRowKey(hour, provider, model)
    const apply = (cur: UsageHourRow | undefined): UsageHourRow => {
      const base = cur ?? emptyHourRow(hour, provider, model)
      if (sample.request) {
        return { ...base, requests: base.requests + 1, lastSeen: Date.now() }
      }
      return {
        ...base,
        inputTokens: base.inputTokens + sample.inputTokens,
        outputTokens: base.outputTokens + sample.outputTokens,
        cacheReadTokens: base.cacheReadTokens + sample.cacheReadTokens,
        cacheWriteTokens: base.cacheWriteTokens + sample.cacheWriteTokens,
        lastSeen: Date.now(),
      }
    }
    try {
      await table.update(key, apply)
    } catch (err) {
      if (isMissingRecord(err)) {
        await table.put(key, emptyHourRow(hour, provider, model))
        await table.update(key, apply)
        return
      }
      throw err
    }
  }

  /** All hour rows whose hour intersects [from, to] (inclusive hour keys). */
  async rangeHourRows(from: string, to: string): Promise<UsageHourRow[]> {
    await this.ready
    const table = this.hourTable
    if (table === null) return []
    const out: UsageHourRow[] = []
    for (const [, row] of table.entries()) {
      if (row.hour >= from && row.hour <= to) out.push(row)
    }
    return out
  }

  /** All rows whose day intersects [from, to] (inclusive). */
  async rangeRows(from: string, to: string): Promise<UsageDayRow[]> {
    await this.ready
    const table = this.requireTable()
    const out: UsageDayRow[] = []
    for (const [, row] of table.entries()) {
      if (row.day >= from && row.day <= to) out.push(row)
    }
    return out
  }

  /** Total row count (diagnostics / tests). */
  async count(): Promise<number> {
    await this.ready
    const table = this.requireTable()
    let n = 0
    for (const _ of table.entries()) n++
    return n
  }
}

function emptyRow(day: string, provider: string, model: string): UsageDayRow {
  return {
    day,
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requests: 0,
    turns: 0,
    lastSeen: Date.now(),
  }
}

function emptyHourRow(hour: string, provider: string, model: string): UsageHourRow {
  return {
    hour,
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requests: 0,
    lastSeen: Date.now(),
  }
}

/** The timestamp a sample's hour is derived from.
 *
 *  A sample carries its own `hour` when the collector stamped one (it has the
 *  event time in hand); otherwise the day is widened to its first hour. The
 *  fallback keeps older callers working, at the cost of attributing such a
 *  sample to 00:00 — off-peak, so it can only understate a cost, never
 *  overstate it. */
function hourKeySource(sample: UsageSample): number {
  const stamped = sample.hour
  if (stamped !== undefined && stamped !== '') {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(stamped)
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])).getTime()
  }
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sample.day)
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), 0).getTime()
  return Date.now()
}

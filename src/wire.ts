/**
 * Wire contract shared by the host aggregation layer and the browser panel,
 * plus the JSON request/response helpers for the /usage/api route handlers.
 * These types mirror the reasonix stats wire (internal/stats/query.go +
 * desktop/stats_app.go): the aggregate response the panel renders maps 1:1
 * to the panel sections (totals, derived stats, daily trend, per-model
 * split). No Node or DOM types leak into the shared declarations — the HTTP
 * helpers are host-only and import the node faces explicitly.
 */

import type { UsageHttpRequest, UsageHttpResponse } from './context-types.ts'

/** One day's token usage and turn count in a trend series. */
export interface DailyTokenUsage {
  day: string // "YYYY-MM-DD", local calendar
  total: number // provider-inclusive tokens (input+output+cache reads/writes)
  byModel: Record<string, number> // model ref -> tokens
  byProvider: Record<string, number> // provider name -> tokens
  requests: number // usage events (API calls)
  turns: number // completed turns
  cacheHit: number // cached input tokens that day
  cacheMiss: number // uncached input tokens that day
  output: number // output tokens that day
  /** Cost in CNY for this day, summed from its hour rows so peak and
   *  off-peak rates are applied per hour rather than to a blended total. */
  cost: number
}

/** One hour's usage in the hourly consumption series.
 *
 *  Hours are the cost model's native resolution: DeepSeek's peak windows
 *  (09:00-12:00, 14:00-18:00 Beijing time on weekdays) both begin and end on a
 *  whole hour, so one hour key carries a single price tier for every token in
 *  it. */
export interface HourlyTokenUsage {
  hour: string // "YYYY-MM-DDTHH", local calendar
  total: number // provider-inclusive tokens
  input: number // cache-miss (uncached) input tokens
  cacheHit: number // cache-read input tokens
  cacheMiss: number // uncached input plus cache writes
  output: number
  requests: number
  cost: number // CNY, computed at this hour's own tier
  peak: boolean // whether this hour falls in a peak window
}

/** One model's aggregate within the range. */
export interface ModelTokenUsage {
  model: string
  provider: string
  tokens: number
  percent: number // 0..100
  /** Cost in CNY attributed to this model across the range. */
  cost: number
  /** Cost share of the range total, 0..100. Kept separate from `percent`
   *  because cost and token share differ: a model billed mostly from cache
   *  hits carries many tokens but little money. */
  costPercent: number
}

/** One provider's aggregate within the range (each provider may serve several models). */
export interface ProviderTokenUsage {
  provider: string
  tokens: number
  percent: number
  /** Cost in CNY attributed to this provider across the range. */
  cost: number
  /** Cost share of the range total, 0..100. */
  costPercent: number
}

/** The full aggregate the panel renders for one time range. */
export interface UsageStatsRange {
  from: string // inclusive
  to: string // inclusive
  // Totals
  tokens: number // provider-inclusive (input + output + cache reads/writes)
  requests: number // usage events (API calls)
  turns: number // completed turns
  cacheHit: number
  cacheMiss: number
  // Derived
  activeDays: number
  topModel: string
  topProvider: string
  // Cost (CNY), all computed per hour so peak/off-peak rates stay exact
  cost: number
  /** Cost of the cache-miss input tokens across the range. */
  costInput: number
  /** Cost of the cache-hit input tokens across the range. */
  costCacheHit: number
  /** Cost of the output tokens across the range. */
  costOutput: number
  /** Cost incurred inside peak windows, for the peak/off-peak split. */
  costPeak: number
  /** Cost incurred outside peak windows. */
  costOffPeak: number
  // Totals split for the input/output/cache breakdown
  input: number // cache-miss (uncached) input tokens
  output: number // output tokens
  // Series
  daily: DailyTokenUsage[]
  hourly: HourlyTokenUsage[]
  models: ModelTokenUsage[]
  providers: ProviderTokenUsage[]
}

/** The usage statistics panel aggregate request. */
export interface UsageStatsRequest {
  range: string // "today" | "yesterday" | "7" | "14" | "30" | "90" | "custom"
  from?: string // "YYYY-MM-DD", custom only
  to?: string // "YYYY-MM-DD", custom only
}

/** The backfill (historical session scan) progress state. */
export interface BackfillStatus {
  running: boolean
  total: number
  done: number
  scannedSessions: number
  lastSessionId?: string
  error?: string
}

// ── HTTP helpers (host half only) ─────────────────────────────────────────

/** Default cap for a JSON request body. The panel posts tiny objects
 *  ({ range, from?, to? }); the cap only bounds a misbehaving trusted
 *  client, so 64 KiB is generous. */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** One line of an async-iterable request body read as UTF-8 text. */
export async function readJsonBody(req: UsageHttpRequest, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<unknown> {
  let body = ''
  let bytes = 0
  for await (const chunk of req) {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    if (bytes > maxBytes) {
      throw new UsageError(413, `request body exceeds ${maxBytes} bytes`)
    }
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }
  if (body === '') return undefined
  try {
    return JSON.parse(body)
  } catch {
    throw new UsageError(400, 'invalid json body')
  }
}

/** A user-visible error carrying its HTTP status. */
export class UsageError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function writeJson(res: UsageHttpResponse, value: unknown, status = 200): void {
  res.statusCode = status
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

export function writeError(res: UsageHttpResponse, err: unknown): void {
  const status = err instanceof UsageError ? err.status : 500
  // Deliberate 4xx carries its user-facing message; an unexpected 500 must
  // not echo internal error text (paths, driver messages) to the client —
  // the route handler logs the real error server-side.
  const message = err instanceof UsageError ? err.message : 'internal error'
  writeJson(res, { ok: false, error: { code: 'usage_api_error', message } }, status)
}

/**
 * Range aggregation engine — a TS translation of the reasonix stats query
 * (internal/stats/query.go), extended with cost accounting.
 *
 * It folds raw usage records (per call + per turn) into the RangeStats the
 * panel renders: per-day totals broken down by model and provider, per-hour
 * consumption with its own price tier, range totals, derived active days /
 * cache hit-rate / top model, and the per-model / per-provider ranked splits.
 *
 * The cache hit-rate is derived only from the input side (cacheHit +
 * cacheMiss), while the headline token total is PROVIDER-INCLUSIVE —
 * uncached input + output + cache reads + cache writes. That is the number
 * a provider dashboard reports for the same calls (and reasonix's
 * TotalTokens): DSH's TokenUsage splits DeepSeek's prompt_tokens into
 * disjoint input/cacheRead buckets, so the naive input+output sum would
 * hide the (typically dominant) cached share. The two rate denominators
 * never mix with the total.
 *
 * Cost is computed PER HOUR, never from a range total: DeepSeek bills input
 * and output at double the rate inside its peak windows (09:00-12:00 and
 * 14:00-18:00 Beijing time on weekdays), so the same token mix costs a
 * different amount depending on when it was spent. A day's cost is the sum of
 * its hours' costs, and a range's cost is the sum of its days'.
 */

import type {
  ModelTokenUsage,
  ProviderTokenUsage,
  UsageStatsRange,
} from './wire.ts'

// Pure date/model-ref helpers live in the shared (host+client, zero-dep)
// module; imported for local use AND re-exported so the host-side import
// surface is unchanged.
import { dayKey, daysInRange, hourKey, providerOf } from './shared.ts'
import { costOfHour, isPeakHourKey } from './pricing.ts'
export { dayKey, daysInRange, hourKey, providerOf }

/**
 * One atomic usage sample from a completed model call (or one completed
 * turn). A call sample carries the four token buckets and the model ref; a
 * turn marker carries only the day (the panel's "sessions" metric is one
 * completed turn). A request marker (from `request/context`) counts one
 * provider call with no tokens.
 */
export interface UsageSample {
  day: string // local calendar day the call completed
  /** Local calendar hour the call completed, "YYYY-MM-DDTHH". Carried because
   *  the cost of a sample depends on WHICH hour it landed in: DeepSeek's peak
   *  windows (09:00-12:00, 14:00-18:00 Beijing time on weekdays) bill at twice
   *  the off-peak rate, and a day total cannot be split back into them. */
  hour?: string
  model?: string // canonical "provider/model"
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turn?: boolean // true for a completed-turn marker
  request?: boolean // true for a provider-call (request/context) marker
}

export interface RangeFilter {
  from: string // inclusive day key
  to: string // inclusive day key
}

/** Aggregate the samples intersecting [from, to]. Missing days yield zero
 *  entries so the trend chart shows the full timeline. */
export function aggregateSamples(samples: Iterable<UsageSample>, filter: RangeFilter): UsageStatsRange {
  const from = filter.from
  const to = filter.to
  const days = daysInRange(from, to)
  const out: UsageStatsRange = {
    from,
    to,
    tokens: 0,
    requests: 0,
    turns: 0,
    cacheHit: 0,
    cacheMiss: 0,
    activeDays: 0,
    topModel: '',
    topProvider: '',
    cost: 0,
    costInput: 0,
    costCacheHit: 0,
    costOutput: 0,
    costPeak: 0,
    costOffPeak: 0,
    input: 0,
    output: 0,
    daily: [],
    hourly: [],
    models: [],
    providers: [],
  }
  const modelTotals = new Map<string, number>()
  const modelCosts = new Map<string, number>()
  const providerTotals = new Map<string, number>()
  const providerCosts = new Map<string, number>()
  const active = new Set<string>()
  // Per-day accumulation (the reasonix dayTotals): the stacked trend chart
  // reads daily.byModel / daily.byProvider, so every token-bearing sample
  // must land in its day's map — not just in the range totals.
  const dayByModel = new Map<string, Map<string, number>>()
  const dayTotals = new Map<string, number>()
  const dayRequests = new Map<string, number>()
  const dayTurns = new Map<string, number>()
  const dayCacheHit = new Map<string, number>()
  const dayCacheMiss = new Map<string, number>()
  const dayOutput = new Map<string, number>()
  const dayCost = new Map<string, number>()
  // Per-hour accumulation. Only token-bearing samples reach these maps: an
  // hour bucket exists to price tokens, and a request-only hour costs nothing.
  const hourBuckets = new Map<string, {
    total: number
    input: number
    cacheHit: number
    cacheMiss: number
    output: number
    requests: number
    cost: number
  }>()

  for (const sample of samples) {
    if (sample.day < from || sample.day > to) continue
    if (sample.turn) {
      out.turns++
      dayTurns.set(sample.day, (dayTurns.get(sample.day) ?? 0) + 1)
      continue
    }
    if (sample.request) {
      // A provider call (step/start or a started retry): one request whether
      // or not it produced tokens — reasonix counts failed calls too. The
      // request markers are the ONLY request source: a successful call also
      // yields a usage sample, and counting both would double every call.
      out.requests++
      dayRequests.set(sample.day, (dayRequests.get(sample.day) ?? 0) + 1)
      continue
    }
    // Provider-inclusive headline (dashboard parity): every bucket the
    // provider billed for this call — uncached input, output, cache reads
    // and writes. The hit/miss rate denominators below stay input-side only.
    const total = sample.inputTokens + sample.outputTokens + sample.cacheReadTokens + sample.cacheWriteTokens
    out.tokens += total
    out.cacheHit += sample.cacheReadTokens
    // The miss side is everything prompt-side that was NOT a cache read:
    // uncached input plus cache writes. (This matches the official stats
    // line's billedInputTokens split — cacheHit/(cacheHit+cacheMiss) is the
    // same ratio on both surfaces; for DeepSeek cacheWrite is always 0.) */
    out.cacheMiss += sample.inputTokens + sample.cacheWriteTokens
    out.input += sample.inputTokens + sample.cacheWriteTokens
    out.output += sample.outputTokens
    const model = sample.model && sample.model !== '' ? sample.model : '(unknown)'
    const provider = providerOf(model)
    modelTotals.set(model, (modelTotals.get(model) ?? 0) + total)
    providerTotals.set(provider, (providerTotals.get(provider) ?? 0) + total)
    active.add(sample.day)

    // Cost is charged on this sample's own hour. A sample without a stamped
    // hour (an older record) falls back to the first hour of its day, which is
    // off-peak — an understatement rather than an overstatement.
    const hour = sample.hour && sample.hour !== '' ? sample.hour : `${sample.day}T00`
    const charge = costOfHour(model, {
      cacheMiss: sample.inputTokens + sample.cacheWriteTokens,
      cacheHit: sample.cacheReadTokens,
      output: sample.outputTokens,
    }, hour)
    out.cost += charge.total
    out.costInput += charge.cacheMiss
    out.costCacheHit += charge.cacheHit
    out.costOutput += charge.output
    if (isPeakHourKey(hour)) out.costPeak += charge.total
    else out.costOffPeak += charge.total
    modelCosts.set(model, (modelCosts.get(model) ?? 0) + charge.total)
    providerCosts.set(provider, (providerCosts.get(provider) ?? 0) + charge.total)

    let bucket = hourBuckets.get(hour)
    if (!bucket) {
      bucket = { total: 0, input: 0, cacheHit: 0, cacheMiss: 0, output: 0, requests: 0, cost: 0 }
      hourBuckets.set(hour, bucket)
    }
    bucket.total += total
    bucket.input += sample.inputTokens
    bucket.cacheHit += sample.cacheReadTokens
    bucket.cacheMiss += sample.inputTokens + sample.cacheWriteTokens
    bucket.output += sample.outputTokens
    bucket.cost += charge.total

    let byModel = dayByModel.get(sample.day)
    if (!byModel) {
      byModel = new Map()
      dayByModel.set(sample.day, byModel)
    }
    byModel.set(model, (byModel.get(model) ?? 0) + total)
    dayTotals.set(sample.day, (dayTotals.get(sample.day) ?? 0) + total)
    dayCacheHit.set(sample.day, (dayCacheHit.get(sample.day) ?? 0) + sample.cacheReadTokens)
    dayCacheMiss.set(sample.day, (dayCacheMiss.get(sample.day) ?? 0) + sample.inputTokens + sample.cacheWriteTokens)
    dayOutput.set(sample.day, (dayOutput.get(sample.day) ?? 0) + sample.outputTokens)
    dayCost.set(sample.day, (dayCost.get(sample.day) ?? 0) + charge.total)
  }

  out.activeDays = active.size

  // Daily series: emit every day of the range; inactive days carry zero totals.
  for (const day of days) {
    const byModel = dayByModel.get(day)
    const byModelObj: Record<string, number> = {}
    if (byModel) {
      for (const [m, v] of byModel) byModelObj[m] = v
    }
    const byProviderObj: Record<string, number> = {}
    for (const m of Object.keys(byModelObj)) {
      byProviderObj[providerOf(m)] = (byProviderObj[providerOf(m)] ?? 0) + byModelObj[m]!
    }
    out.daily.push({
      day,
      total: dayTotals.get(day) ?? 0,
      byModel: byModelObj,
      byProvider: byProviderObj,
      requests: dayRequests.get(day) ?? 0,
      turns: dayTurns.get(day) ?? 0,
      cacheHit: dayCacheHit.get(day) ?? 0,
      cacheMiss: dayCacheMiss.get(day) ?? 0,
      output: dayOutput.get(day) ?? 0,
      cost: dayCost.get(day) ?? 0,
    })
  }

  // Hourly series: only hours that actually carry usage, in chronological
  // order. Emitting all 24 hours of every day would drown the chart in empty
  // bars for a 90-day range.
  const hourKeys = [...hourBuckets.keys()].sort()
  for (const h of hourKeys) {
    const b = hourBuckets.get(h)!
    out.hourly.push({
      hour: h,
      total: b.total,
      input: b.input,
      cacheHit: b.cacheHit,
      cacheMiss: b.cacheMiss,
      output: b.output,
      requests: b.requests,
      cost: b.cost,
      peak: isPeakHourKey(h),
    })
  }

  out.models = modelsSorted(modelTotals, modelCosts)
  out.providers = providersSorted(providerTotals, providerCosts)
  const top = out.models[0]
  if (top) {
    out.topModel = top.model
    out.topProvider = top.provider
  }
  if (out.tokens > 0) {
    for (const m of out.models) {
      m.percent = (m.tokens / out.tokens) * 100
      m.costPercent = out.cost > 0 ? (m.cost / out.cost) * 100 : 0
    }
    for (const p of out.providers) {
      p.percent = (p.tokens / out.tokens) * 100
      p.costPercent = out.cost > 0 ? (p.cost / out.cost) * 100 : 0
    }
  }
  return out
}

function modelsSorted(totals: Map<string, number>, costs: Map<string, number>): ModelTokenUsage[] {
  const out: ModelTokenUsage[] = []
  for (const [model, tokens] of totals) {
    out.push({
      model,
      provider: providerOf(model),
      tokens,
      percent: 0,
      cost: costs.get(model) ?? 0,
      costPercent: 0,
    })
  }
  out.sort((a, b) => b.tokens - a.tokens)
  return out
}

function providersSorted(totals: Map<string, number>, costs: Map<string, number>): ProviderTokenUsage[] {
  const out: ProviderTokenUsage[] = []
  for (const [provider, tokens] of totals) {
    out.push({
      provider,
      tokens,
      percent: 0,
      cost: costs.get(provider) ?? 0,
      costPercent: 0,
    })
  }
  out.sort((a, b) => b.tokens - a.tokens)
  return out
}
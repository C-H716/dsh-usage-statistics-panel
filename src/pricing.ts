/**
 * DeepSeek pricing model and cost computation.
 *
 * This module is the pure, zero-dependency layer shared by the host and client
 * halves: it imports no Node.js and no DOM types, so the browser bundle inlines
 * it directly (the same constraint src/shared.ts follows).
 *
 * Billing follows the official pricing page
 * (https://api-docs.deepseek.com/zh-cn/quick_start/pricing): the input side is
 * billed in two tiers — cache hit and cache miss — and the output side in a
 * third. All three are quoted in CNY per million tokens. One model costs
 * exactly twice as much during peak hours as off-peak, so a cost figure is only
 * correct when the hour a call happened in is known; a daily aggregate cannot
 * reconstruct it.
 *
 * Every peak/off-peak boundary falls on a whole hour (09:00 / 12:00 / 14:00 /
 * 18:00), so recording usage at hour granularity reproduces the exact tier of
 * every call — no finer resolution is needed.
 */

/** Billing currency. The pricing page quotes CNY, and the panel renders costs in it. */
export const COST_CURRENCY = 'CNY'
/** Currency symbol for compact display. */
export const COST_SYMBOL = '¥'

/** The three unit prices of one billing tier, in CNY per million tokens. */
export interface PriceTier {
  /** Unit price of cache-hit input tokens. */
  cacheHit: number
  /** Unit price of cache-miss input tokens. */
  cacheMiss: number
  /** Unit price of output tokens. */
  output: number
}

/** One model's price list for the peak and off-peak windows. */
export interface ModelPricing {
  /** Off-peak unit prices (exactly half the peak ones). */
  offPeak: PriceTier
  /** Peak unit prices. */
  peak: PriceTier
}

/**
 * Model price table, keyed by normalized tier id.
 *
 * Values are taken from the "model details" table of the official pricing page
 * (as published 2026-09):
 * - deepseek-flash: cache hit 0.02 off-peak / 0.04 peak; cache miss 1 / 2;
 *   output 4 / 8.
 * - deepseek-v4-pro: cache hit 0.15 off-peak / 0.30 peak; cache miss 4.5 / 9.0;
 *   output 13.5 / 27.0.
 *
 * Prices may change upstream; these are the current published values.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  flash: {
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  },
  pro: {
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
}

/** Fallback tier for an unrecognized model: flash pricing, the cheaper of the
 *  two, so an unknown model never inflates the reported spend. */
export const DEFAULT_TIER = 'flash'

/**
 * Peak-hour windows as half-open [from, to) hour ranges in Beijing time.
 * Per the official definition, Monday to Friday (excluding PRC public holidays)
 * 09:00-12:00 and 14:00-18:00 are peak; every other time — including weekends
 * and public holidays in full — is off-peak.
 *
 * PRC public holidays are not modelled: they follow a yearly State Council
 * announcement, so a holiday falling on a weekday is billed here at peak rates.
 * The error is bounded (one weekday per holiday) and always overstates cost.
 */
const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9, 12],
  [14, 18],
]

/** Beijing time is UTC+8 with no daylight saving, so a fixed offset is exact. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Normalize a model reference to a pricing tier id.
 *
 * Stored model refs are "provider/model", and one underlying model may be
 * recorded under several providers (for example `deeperseeker/v4.1flash` and
 * `deepseek-official/deepseek-flash` are the same tier). The decision therefore
 * reads only the model-name part and ignores the provider prefix and separator
 * differences.
 *
 * The pro tier is tested first because it is the more expensive one and a
 * misclassification there costs more; anything matching neither tier falls back
 * to {@link DEFAULT_TIER}.
 *
 * @param modelRef The raw model reference, either "provider/model" or a bare name.
 * @returns A tier id present in {@link MODEL_PRICING}.
 */
export function tierOf(modelRef: string): string {
  // The provider prefix carries no pricing meaning: one model billed through
  // several providers keeps a single price.
  const slash = modelRef.indexOf('/')
  const name = (slash >= 0 ? modelRef.slice(slash + 1) : modelRef).toLowerCase()
  if (name.includes('pro')) return 'pro'
  if (name.includes('flash')) return 'flash'
  return DEFAULT_TIER
}

/** The price list for a model; an unknown tier falls back to the default one. */
export function pricingOf(modelRef: string): ModelPricing {
  return MODEL_PRICING[tierOf(modelRef)] ?? MODEL_PRICING[DEFAULT_TIER]!
}

/**
 * Whether a timestamp falls in a peak window.
 *
 * The timestamp is converted to Beijing time with a fixed offset rather than
 * the runtime's local zone: the windows are defined in Beijing time while the
 * panel may be opened in any zone.
 *
 * @param ts Epoch milliseconds.
 * @returns True when the instant is inside a peak window.
 */
export function isPeakHour(ts: number): boolean {
  const beijing = new Date(ts + BEIJING_OFFSET_MS)
  const day = beijing.getUTCDay() // 0 = Sunday
  if (day === 0 || day === 6) return false
  const hour = beijing.getUTCHours()
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to)
}

/**
 * Parse a local hour-slot key back to epoch milliseconds.
 *
 * @param hourKey A key in `YYYY-MM-DDTHH` form.
 * @returns Epoch milliseconds, or null when the key is malformed.
 */
export function parseHourKey(hourKey: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(hourKey)
  if (!m) return null
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])).getTime()
  return Number.isNaN(ts) ? null : ts
}

/**
 * Whether an hour slot falls in a peak window.
 *
 * Boundaries are whole hours, so a slot never straddles two tiers and judging
 * by its start instant covers every sample inside it.
 *
 * @param hourKey A local hour-slot key (`YYYY-MM-DDTHH`).
 * @returns True when the slot is a peak one; an unparseable key is treated as
 *          off-peak so a malformed key never inflates the reported cost.
 */
export function isPeakHourKey(hourKey: string): boolean {
  const parsed = parseHourKey(hourKey)
  return parsed === null ? false : isPeakHour(parsed)
}

/** The token buckets one charge is computed from. */
export interface CostBuckets {
  /** Uncached (cache-miss) input tokens. */
  cacheMiss: number
  /** Cache-hit input tokens. */
  cacheHit: number
  /** Output tokens. */
  output: number
}

/** One charge: the total plus its three per-tier parts. */
export interface CostBreakdown {
  /** Total cost. */
  total: number
  /** Cost of the cache-miss input tokens. */
  cacheMiss: number
  /** Cost of the cache-hit input tokens. */
  cacheHit: number
  /** Cost of the output tokens. */
  output: number
  /** The tier this charge was computed with. */
  tier: 'peak' | 'offPeak'
}

/** Tokens per unit price: unit prices are quoted per million tokens. */
const PER_MILLION = 1_000_000

/**
 * Compute the cost of one usage sample.
 *
 * @param modelRef Model reference, used to select the price list.
 * @param buckets Token usage.
 * @param peak Whether the sample happened in a peak window.
 * @returns The total and its three per-tier parts.
 */
export function costOf(modelRef: string, buckets: CostBuckets, peak: boolean): CostBreakdown {
  const price = pricingOf(modelRef)
  const tier = peak ? price.peak : price.offPeak
  const cacheMiss = (buckets.cacheMiss / PER_MILLION) * tier.cacheMiss
  const cacheHit = (buckets.cacheHit / PER_MILLION) * tier.cacheHit
  const output = (buckets.output / PER_MILLION) * tier.output
  return {
    total: cacheMiss + cacheHit + output,
    cacheMiss,
    cacheHit,
    output,
    tier: peak ? 'peak' : 'offPeak',
  }
}

/**
 * Compute the cost of one usage sample from its hour slot.
 *
 * This is the aggregation layer's main entry point: the slot already carries
 * the peak/off-peak information, so callers never test the tier themselves.
 *
 * @param modelRef Model reference.
 * @param buckets Token usage.
 * @param hourKey Local hour-slot key.
 * @returns The total and its three per-tier parts.
 */
export function costOfHour(modelRef: string, buckets: CostBuckets, hourKey: string): CostBreakdown {
  return costOf(modelRef, buckets, isPeakHourKey(hourKey))
}

/**
 * Merge several charges.
 *
 * @param parts Charges to merge.
 * @returns The per-tier and total sums. `tier` is a placeholder: a merged
 *          result may span both windows, so a single tier id is meaningless.
 */
export function sumCosts(parts: Iterable<CostBreakdown>): CostBreakdown {
  let total = 0
  let cacheMiss = 0
  let cacheHit = 0
  let output = 0
  for (const p of parts) {
    total += p.total
    cacheMiss += p.cacheMiss
    cacheHit += p.cacheHit
    output += p.output
  }
  return { total, cacheMiss, cacheHit, output, tier: 'offPeak' }
}

/**
 * Format a cost for display.
 *
 * Small totals keep three decimals so a light day does not read as a flat zero,
 * while anything from one unit up is shown with two.
 *
 * @param cost Cost in CNY.
 * @returns The formatted amount without a currency symbol.
 */
export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '0.00'
  if (cost < 0.01) return cost.toFixed(4)
  return cost.toFixed(2)
}

/**
 * Compact cost for axis labels and tight sub-values.
 *
 * @param cost Cost in CNY.
 * @returns A compact string such as "12.3" or "1.2k".
 */
export function formatCostCompact(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '0'
  if (cost >= 1000) return (cost / 1000).toFixed(1) + 'k'
  if (cost >= 10) return cost.toFixed(0)
  if (cost >= 1) return cost.toFixed(1)
  return cost.toFixed(2)
}
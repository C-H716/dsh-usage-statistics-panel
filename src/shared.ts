/**
 * Pure helpers shared by the host aggregation layer and the browser panel.
 * This module MUST stay free of Node.js and DOM types and carry zero
 * imports: both halves import it at runtime (the client bundle-purity gate
 * rejects Node builtins, and a value import of `wire.ts` would drag the
 * host-only HTTP helpers — including `Buffer` — into the browser bundle).
 */

/** Local calendar day key, e.g. "2026-08-02" (no UTC shift). */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** All local-calendar day keys in [from, to], inclusive. Invalid or reversed
 *  bounds yield an empty list. */
export function daysInRange(from: string, to: string): string[] {
  const out: string[] = []
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return out
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    out.push(`${y}-${m}-${day}`)
  }
  return out
}

/** model refs are "provider/model"; a bare model name has no slash and is
 *  attributed to provider "default". */
export function providerOf(modelRef: string): string {
  const i = modelRef.indexOf('/')
  if (i > 0) return modelRef.slice(0, i)
  return 'default'
}

/** The display name of a model ref: the part after the provider slash
 *  ("deepseek-chat" of "deepseek/deepseek-chat"); a bare name is unchanged. */
export function modelNameOf(modelRef: string): string {
  const i = modelRef.indexOf('/')
  if (i > 0) return modelRef.slice(i + 1)
  return modelRef
}

/** Local calendar hour key, e.g. "2026-08-02T14" (no UTC shift).
 *
 *  The hour is the cost model's resolution: DeepSeek's peak and off-peak
 *  windows both begin and end on a whole hour, so one hour key carries the
 *  entire pricing tier of every sample inside it. */
export function hourKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  return `${y}-${m}-${day}T${h}`
}

/** The local calendar day a hour key belongs to ("YYYY-MM-DD"). */
export function dayOfHourKey(hourKeyValue: string): string {
  return hourKeyValue.slice(0, 10)
}

/** All local-calendar hour keys in [from, to], inclusive, both bounds being
 *  "YYYY-MM-DDTHH" keys. Invalid or reversed bounds yield an empty list. */
export function hoursInRange(from: string, to: string): string[] {
  const out: string[] = []
  const start = parseHourKeyLocal(from)
  const end = parseHourKeyLocal(to)
  if (start === null || end === null || end < start) return out
  // Step by epoch hours, then re-key: adding 3600e3 to a local timestamp lands
  // on the next local hour across DST transitions as well, while re-keying
  // keeps the emitted labels in local calendar terms.
  for (let ts = start; ts <= end; ts += 3_600_000) out.push(hourKey(ts))
  return out
}

/** Parse a local hour key to epoch ms; null when malformed. Local-time
 *  counterpart of pricing.ts's parseHourKey, kept dependency-free here. */
function parseHourKeyLocal(hourKeyValue: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(hourKeyValue)
  if (!m) return null
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])).getTime()
  return Number.isNaN(ts) ? null : ts
}

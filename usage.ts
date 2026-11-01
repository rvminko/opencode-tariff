// Usage meters for the tariff dialog (see SPEC-usage-bars.md).
// Data comes from OpenCode itself: GET /api/experimental/usage/limits returns
// UsageLimits.Info built server-side from the Console connection and the Go
// allowance endpoint. Fields are optional: `go` is absent without a Go
// subscription, `data` is null when the location has no Console sign-in.

export interface Meter {
  readonly percent: number
  readonly limited: boolean
  readonly resetsAt: number
}

export interface GoMeters {
  readonly rolling: Meter
  readonly weekly: Meter
  readonly monthly: Meter
}

export interface Budget {
  readonly id: string
  readonly limit: number
  readonly spent: number
  readonly per: "set" | "model"
  readonly coverage: "all" | "models"
  readonly resetsAt: number
}

export interface UsageInfo {
  readonly workspace?: { readonly id: string; readonly name?: string; readonly usageURL: string }
  readonly go?: GoMeters
  readonly budgets?: readonly Budget[]
}

export const METERS: ReadonlyArray<{ readonly key: keyof GoMeters; readonly label: string }> = [
  { key: "rolling", label: "5ч" },
  { key: "weekly", label: "нед" },
  { key: "monthly", label: "мес" },
]

export const clampPercent = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0)

/** Ten-cell bar: filled part is usage, the rest is an outline. */
export function bar(percent: number, cells = 10): string {
  const filled = Math.min(cells, Math.round((clampPercent(percent) / 100) * cells))
  return "█".repeat(filled) + "░".repeat(cells - filled)
}

/** The meter closest to running out, which is what a compact line should show. */
export function worstMeter(go: GoMeters | undefined): { key: keyof GoMeters; label: string; meter: Meter } | undefined {
  if (!go) return undefined
  let best: { key: keyof GoMeters; label: string; meter: Meter } | undefined
  for (const m of METERS) {
    const meter = go[m.key]
    if (!best || meter.percent > best.meter.percent) best = { key: m.key, label: m.label, meter }
  }
  return best
}

/** "18:40" for a reset later today, "3 ноя" otherwise; local time, no countdown math. */
export function resetText(at: number, now = Date.now()): string {
  const d = new Date(at)
  const sameDay = d.toDateString() === new Date(now).toDateString()
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  if (sameDay) return `${hh}:${mm}`
  return `${d.getDate()} ${d.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "")} ${hh}:${mm}`
}

/** "5ч 68% · нед 12% · мес 3%" — the compact form used in the dialog title and footer. */
export function compactLine(info: UsageInfo | undefined): string {
  const go = info?.go
  if (!go) return ""
  return METERS.map((m) => `${m.label} ${Math.round(clampPercent(go[m.key].percent))}%`).join(" · ")
}

/** Full rows for the sidebar block; empty when there is nothing to show. */
export function rows(info: UsageInfo | undefined, now = Date.now()): Array<{
  label: string
  bar: string
  percent: number
  limited: boolean
  reset: string
}> {
  const go = info?.go
  if (!go) return []
  return METERS.map((m) => {
    const meter = go[m.key]
    return {
      label: m.label,
      bar: bar(meter.percent),
      percent: Math.round(clampPercent(meter.percent)),
      limited: meter.limited,
      reset: resetText(meter.resetsAt, now),
    }
  })
}

/** The budget closest to its limit, as a single line; empty when there is none. */
export function budgetLine(info: UsageInfo | undefined, now = Date.now()): string {
  const list = info?.budgets ?? []
  if (list.length === 0) return ""
  const binding = list
    .map((b) => ({ b, left: b.limit - b.spent }))
    .sort((x, y) => x.left - y.left)[0]
  return `лимит $${binding.b.spent.toFixed(0)} из $${binding.b.limit.toFixed(0)} · сброс ${resetText(binding.b.resetsAt, now)}`
}

// — Ollama Cloud ————————————————————————————————————————————————————————————
// GET https://ollama.com/api/balance (Bearer OLLAMA_API_KEY): remaining included
// credits for the plan period plus unexpired purchased credits. Legacy plans return
// `session`/`weekly` limits with `remaining_percent` instead.

export interface OllamaLegacyLimit {
  readonly remaining_percent: number
  readonly resets_at: string
}

export interface OllamaIncluded {
  readonly balance_usd?: number
  readonly allowance_usd?: number
  readonly period?: { readonly from: string; readonly until: string }
  readonly session?: OllamaLegacyLimit
  readonly weekly?: OllamaLegacyLimit
}

export interface OllamaBalance {
  readonly included?: OllamaIncluded
  readonly purchased?: { readonly balance_usd?: number }
}

export interface OllamaMeter {
  readonly label: string
  readonly bar: string
  readonly percent: number
  readonly reset: string
  readonly detail: string
}

const usedPercent = (remaining: number, allowance: number): number =>
  allowance > 0 ? Math.round(((allowance - remaining) / allowance) * 100) : 0

/** Meter rows for the Ollama Cloud plan: one for current plans, two for legacy session/weekly. */
export function ollamaRows(balance: OllamaBalance | undefined, now = Date.now()): OllamaMeter[] {
  const included = balance?.included
  if (!included) return []
  const purchased = balance?.purchased?.balance_usd ?? 0
  const extra = purchased > 0 ? ` · покупные $${purchased.toFixed(2)}` : ""
  if (typeof included.session?.remaining_percent === "number" || typeof included.weekly?.remaining_percent === "number") {
    const rows: OllamaMeter[] = []
    for (const [label, limit] of [["5ч", included.session], ["нед", included.weekly]] as const) {
      if (!limit) continue
      const percent = Math.round(clampPercent(100 - limit.remaining_percent))
      const at = Date.parse(limit.resets_at)
      rows.push({
        label: `ol ${label}`,
        bar: bar(percent),
        percent,
        reset: Number.isNaN(at) ? "—" : resetText(at, now),
        detail: `осталось ${Math.round(limit.remaining_percent)}%${extra}`,
      })
    }
    return rows
  }
  const remaining = included.balance_usd
  const allowance = included.allowance_usd
  if (typeof remaining !== "number" || typeof allowance !== "number") return []
  const percent = usedPercent(remaining, allowance)
  const until = included.period ? Date.parse(included.period.until) : Number.NaN
  return [
    {
      label: "ol",
      bar: bar(percent),
      percent,
      reset: Number.isNaN(until) ? "—" : resetText(until, now),
      detail: `$${remaining.toFixed(2)} из $${allowance.toFixed(0)}${extra}`,
    },
  ]
}

/** "ol 68%" for the footer/title; empty without a balance. */
export function ollamaCompact(balance: OllamaBalance | undefined): string {
  const rowsNow = ollamaRows(balance)
  if (rowsNow.length === 0) return ""
  return rowsNow.map((m) => `${m.label} ${m.percent}%`).join(" · ")
}

// — Per-row limit usage ——————————————————————————————————————————————————————
// How much of the monthly allowance one million blended tokens of a model
// consume: Ollama rows divide by the plan allowance from /api/balance, Go rows
// by the published per-model monthly limit. Z.AI has no dollar allowance.

export function rowCostPercent(blend: number, limitUsd: number | undefined): number | undefined {
  return typeof limitUsd === "number" && limitUsd > 0 ? (blend / limitUsd) * 100 : undefined
}

/** Ten-cell bar scaled to the heaviest row in the visible list. */
export function costBar(percent: number | undefined, max: number, cells = 10): string {
  if (percent === undefined || !(max > 0)) return "░".repeat(cells)
  const fill = Math.max(0, Math.min(cells, Math.round((percent / max) * cells)))
  return "█".repeat(fill) + "░".repeat(cells - fill)
}

/** "0.2%" — one decimal below ten percent, whole numbers above. */
export function costText(percent: number | undefined): string {
  if (percent === undefined) return "—"
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`
}

/**
 * The dialog title line: a compact 5-cell bar for the tightest meter of each
 * source (Go worst + Ollama first), remaining meters as percentages. Ten-cell
 * bars live in the list rows; a 10-cell title bar wraps on 110-column terminals.
 */
export function titleMeters(info: UsageInfo | undefined, balance: OllamaBalance | undefined): string {
  const segs: string[] = []
  const go = info?.go
  if (go) {
    const worst = worstMeter(go)
    if (worst) {
      segs.push(`${worst.label} ${bar(worst.meter.percent, 5)} ${Math.round(clampPercent(worst.meter.percent))}%`)
      for (const m of METERS) {
        if (m.key === worst.key) continue
        segs.push(`${m.label} ${Math.round(clampPercent(go[m.key].percent))}%`)
      }
    }
  }
  const ol = ollamaRows(balance)
  for (let i = 0; i < ol.length; i++) {
    segs.push(i === 0 ? `${ol[i].label} ${bar(ol[i].percent, 5)} ${ol[i].percent}%` : `${ol[i].label} ${ol[i].percent}%`)
  }
  return segs.join(" · ")
}
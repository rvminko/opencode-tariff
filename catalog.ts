// Shared tariff catalog: per-model token prices from official pages (read 2026-11-01):
// - https://ollama.com/pricing — per-token USD; off-peak outside Mon-Fri 12:00-18:00 UTC + weekends,
//   off-peak rows published only for deepseek-v4.1-flash / deepseek-v4-pro.
// - https://opencode.ai/v2/docs/console/go — per-model USD; DeepSeek models peak Mon-Fri
//   01:00-04:00 and 06:00-10:00 UTC, all other hours off-peak.
// - https://docs.z.ai/devpack/overview — GLM Coding Plan (credits): peak Mon-Fri 14:00-18:00 UTC+8,
//   off-peak burns 50% credits; entries below are credit multipliers (input/cached/output).
// All prices are per 1M tokens. `i` = fresh input, `c` = cached input read, `o` = output.

export type ProviderID = "go" | "ollama" | "zai"
export interface Price { i: number; c: number; o: number; off?: Price }
export interface Row {
  model: string
  provider: ProviderID
  // Effective price at the given moment, USD per 1M tokens (`est` = converted from credits via usdPerCredit).
  blend: number
  est: boolean
  // True while the provider is inside its off-peak window — even for models
  // whose per-token price does not change (no published off-peak rows).
  offPeak: boolean
  // True only when the row's price is ACTUALLY the off-peak one, i.e. the
  // provider is off-peak AND has a published off-peak price for this model.
  discounted: boolean
  // Raw effective multipliers/USD per 1M tokens.
  input: number
  cached: number
  output: number
}
export interface Settings {
  auto: boolean
  title: "full" | "short" | "off"
  pin: string
  usdPerCredit: number
  type: "cheap" | "full"
}

export const DEFAULTS: Settings = { auto: false, title: "full", pin: "", usdPerCredit: 0.0004, type: "cheap" }

export const NAMES: Record<ProviderID, string> = { go: "Go", ollama: "Ollama", zai: "Z.ai" }

// Actual OpenCode provider ids the catalog providers map onto when switching the model.
// Note: `ollama` here is the CLOUD subscription, not the local `ollama` server provider.
export const OPENCODE_PROVIDER: Record<ProviderID, string> = {
  ollama: "ollama-cloud",
  go: "opencode-go",
  zai: "zai",
}

// Reverse map: an OpenCode provider id -> catalog provider key, or undefined when
// the provider is not one of the three tariff subscriptions.
export const ofProvider = (id: string): ProviderID | undefined => {
  if (id.startsWith("ollama-cloud")) return "ollama"
  if (id.startsWith("opencode-go")) return "go"
  if (id.startsWith("zai")) return "zai"
  return undefined
}

// A tariff provider is available when any OpenCode provider id matches its
// base id exactly or by prefix (covers ids like "zai-coding-plan").
export const isProviderAvailable = (opencodeID: string, names: readonly string[]): boolean =>
  names.some((n) => typeof n === "string" && (n === opencodeID || n.startsWith(opencodeID)))

const R = (i: number, c: number, o: number, off?: Price): Price => ({
  i,
  c,
  o,
  ...(off ? { off } : {}),
})

// Canonical model family -> provider price entries. Ids match Ollama/OpenCode Go catalog ids;
// Z.AI serves glm-5.3 / glm-5.3-flash and auto-routes older GLM ids to glm-5.3.
const TABLE: Record<string, Partial<Record<ProviderID, Price>>> = {
  "glm-5.3-flash": { ollama: R(0.15, 0.03, 0.5), go: R(0.15, 0.03, 0.5), zai: R(2.3, 0.56, 8) },
  "glm-5.3": { ollama: R(1.4, 0.26, 4.4), go: R(1.4, 0.26, 4.4), zai: R(6.9, 1.7, 24) },
  "glm-5.2": { ollama: R(1.4, 0.26, 4.4), go: R(1.4, 0.26, 4.4), zai: R(6.9, 1.7, 24) },
  "deepseek-v4.1-flash": { ollama: R(0.3, 0.006, 1.2, R(0.15, 0.003, 0.6)), go: R(0.3, 0.006, 1.2, R(0.15, 0.003, 0.6)) },
  "deepseek-v4-pro": { ollama: R(1.32, 0.044, 3.96, R(0.66, 0.022, 1.98)), go: R(1.32, 0.044, 3.96, R(0.66, 0.022, 1.98)) },
  "kimi-k3": { ollama: R(3, 0.3, 15), go: R(3, 0.3, 15) },
  "kimi-k2.7-code": { ollama: R(0.95, 0.19, 4), go: R(0.95, 0.19, 4) },
  "minimax-m3": { ollama: R(0.6, 0.12, 2.4), go: R(0.3, 0.06, 1.2) },
  "minimax-m3.1-flash": { ollama: R(0.15, 0.015, 0.6), go: R(0.15, 0.015, 0.6) },
  "mimo-v2.6-flash": { ollama: R(0.14, 0.0028, 0.28), go: R(0.14, 0.0028, 0.28) },
  "mimo-v2.6-pro": { ollama: R(0.435, 0.0036, 0.87), go: R(0.435, 0.0036, 0.87) },
  "longcat-2.0": { go: R(0.3, 0.006, 1.2) },
  "qwen3.8-flash": { go: R(0.15, 0.016, 0.47) },
  "qwen3.7-plus": { go: R(0.4, 0.04, 1.6) },
  "kimi-k3.1-pro": { go: R(2, 0.2, 10) },
}

const weekday = (d: Date) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5

// OpenCode Go monthly allowances per model, USD (https://opencode.ai/v2/docs/console/go,
// read 2026-11-01). Used only to show how much of the model's monthly limit one
// million blended tokens would consume; OpenCode enforces these server-side.
export const GO_MONTHLY_LIMIT: Record<string, number> = {
  "glm-5.3": 15,
  "glm-5.3-flash": 60,
  "glm-5.2": 60,
  "deepseek-v4.1-flash": 100,
  "deepseek-v4-pro": 15,
  "kimi-k3": 15,
  "kimi-k3.1-pro": 15,
  "kimi-k2.7-code": 60,
  "minimax-m3": 60,
  "minimax-m3.1-flash": 20,
  "mimo-v2.6-flash": 60,
  "mimo-v2.6-pro": 15,
  "longcat-2.0": 60,
  "qwen3.8-flash": 30,
  "qwen3.7-plus": 60,
}

export function isPeak(provider: ProviderID, now: Date): boolean {
  const h = now.getUTCHours()
  if (provider === "ollama") return weekday(now) && h >= 12 && h < 18
  if (provider === "go") return weekday(now) && ((h >= 1 && h < 4) || (h >= 6 && h < 10))
  const sgt = new Date(now.getTime() + 8 * 3600_000)
  return sgt.getUTCDay() >= 1 && sgt.getUTCDay() <= 5 && sgt.getUTCHours() >= 14 && sgt.getUTCHours() < 18
}

// Fixed mix for a blended price per 1M tokens: 25% fresh input, 65% cache read, 10% output.
export const blended = (p: Price) => p.i * 0.25 + p.c * 0.65 + p.o * 0.1

const effective = (provider: ProviderID, price: Price, now: Date): Price =>
  price.off && !isPeak(provider, now) ? price.off : price

// Normalize a provider model id onto a canonical family (ollama sometimes appends ":tag").
export const familyOf = (modelID: string): string => {
  const base = modelID.toLowerCase().split(":")[0]
  if (TABLE[base]) return base
  return Object.keys(TABLE).find((k) => base.startsWith(k)) ?? ""
}

// Catalog rows usable now; provider keys availability is filtered by the caller.
export function rowsFor(now: Date, usdPerCredit: number): Row[] {
  const out: Row[] = []
  for (const model of Object.keys(TABLE)) {
    for (const p of ["go", "ollama", "zai"] as ProviderID[]) {
      const price = TABLE[model]![p]
      if (!price) continue
      const at = effective(p, price, now)
      const mix = blended(at)
      const offPeak = !isPeak(p, now)
      if (p === "zai") {
        // Credit multipliers per docs convert to credits per 1M tokens: multiplier * 100.
        const credits = mix * 100
        out.push({ model, provider: p, blend: credits * usdPerCredit, est: true, offPeak, discounted: false, input: at.i * 100, cached: at.c * 100, output: at.o * 100 })
      } else {
        out.push({ model, provider: p, blend: mix, est: false, offPeak, discounted: offPeak && price.off !== undefined, input: at.i, cached: at.c, output: at.o })
      }
    }
  }
  return out.sort((a, b) => a.blend - b.blend)
}

export const providersFor = (family: string): [ProviderID, Price][] =>
  family in TABLE ? (Object.entries(TABLE[family]) as [ProviderID, Price][]) : []
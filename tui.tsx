// TUI part of the tariff plugin: /tariff command opens the native DialogSelect
// (the same widget as /models) listing every catalog model across Ollama Cloud /
// OpenCode Go / Z.AI with the effective blended price at this moment.
// - Options are NOT disabled even without auth (the select hard-filters disabled
//   options out of every search path); missing-auth rows get a "нет auth" footer
//   and an "×" marker, and choosing them shows a warning toast instead of switching.
// - Relative price ("относительная стоимость") compares every row with the
//   CURRENTLY selected model and sits in the row description.
// - Footer actions: a — auto-switch, t — list type (cheap/full), p — pin provider.

import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createSignal } from "solid-js"
import { Tariff } from "./rpc"
import { DEFAULTS, GO_MONTHLY_LIMIT, NAMES, OPENCODE_PROVIDER, familyOf, ofProvider, type ProviderID, type Row, type Settings } from "./catalog"
import { budgetLine, bar, costBar, costText, ollamaRows, rowCostPercent, rows as usageRows, titleMeters, worstMeter, type OllamaBalance, type UsageInfo } from "./usage"

const CHEAP_MAX = 0.25

// Per-row cost bar: how much of the monthly allowance one million blended tokens
// of this model consumes, scaled to the heaviest row in the visible list.
const limitForRow = (
  row: Row,
  ollamaAllowance: number | undefined,
): number | undefined => {
  if (row.provider === "go") return GO_MONTHLY_LIMIT[row.model]
  if (row.provider === "ollama") return ollamaAllowance
  return undefined
}

// Theme tokens may arrive as ready colors or as {buffer:{0..3}} records; normalize to hex.
const hex = (c: unknown): string | undefined => {
  if (!c || typeof c !== "object") return undefined
  const o = c as { buffer?: Record<string, number> | number[]; 0?: number; 1?: number; 2?: number }
  const b = o.buffer ?? ([o[0], o[1], o[2]] as number[])
  const at = (i: number): number | undefined => (Array.isArray(b) ? b[i] : (b as Record<string, number>)?.[String(i)])
  const [r, g, bl] = [at(0), at(1), at(2)]
  if (typeof r !== "number" || typeof g !== "number" || typeof bl !== "number") return undefined
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")
  return `#${h(r)}${h(g)}${h(bl)}`
}

const money = (v: number, est: boolean) => `${est ? "~" : ""}$${v.toFixed(3)}`
const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length))
const pctOf = (value: number, mine: number): string => {
  const d = Math.round(((value - mine) / mine) * 100)
  return d === 0 ? "0%" : `${d > 0 ? "+" : "−"}${Math.abs(d)}%`
}
const cycle = <T extends string>(v: T, all: T[], dir = 1): T => all[(all.indexOf(v) + dir + all.length) % all.length]

// Current session fallback: the most recently updated root session.
const lastSessionOf = (context: ReturnType<typeof usePlugin>): string | undefined => {
  const sessions = ((context.data.session.list() ?? []) as unknown[]).filter(
    (s): s is { id?: string; parentID?: string; time?: { updated?: number } } => typeof s === "object" && s !== null,
  )
  const roots = sessions.filter((s) => !s.parentID && s.id)
  roots.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
  return roots[0]?.id
}

export default Plugin.define({
  id: "tariff.cli",
  setup(context) {
    const rpc = context.client.rpc(Tariff)
    const [usage, setUsage] = createSignal<UsageInfo | undefined>(undefined)

    // Debug injection (TARIFF_FAKE_USAGE=json or @/path/to.json): renders usage bars
    // without a Console sign-in, for e2e and manual checks.
    const fakeUsage = (): UsageInfo | undefined => {
      const raw = process.env.TARIFF_FAKE_USAGE
      if (!raw) return undefined
      try {
        const { readFileSync } = require("node:fs") as typeof import("node:fs")
        const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw
        return JSON.parse(text) as UsageInfo
      } catch {
        return undefined
      }
    }

    // OpenCode builds the usage limits server-side (Console connection + Go allowance).
    // `usage.limits` exists on the generated client; `experimental.usage.limits` mirrors it.
    type LimitsClient = {
      usage?: { limits?: (input?: unknown) => Promise<unknown> }
      experimental?: { usage?: { limits?: (input?: unknown) => Promise<unknown> } }
    }
    const fetchUsage = async (): Promise<void> => {
      try {
        const fake = fakeUsage()
        if (fake) {
          setUsage(fake)
          return
        }
        const cl = context.client as unknown as LimitsClient
        const fn = cl.usage?.limits ?? cl.experimental?.usage?.limits
        if (!fn) return
        const res = (await fn()) as { data?: UsageInfo | null } | undefined
        setUsage(res?.data ?? undefined)
      } catch (e) {
        console.error("[tariff] usage fetch failed:", e instanceof Error ? e.message : e)
      }
    }
    void fetchUsage()
    const usageTimer = setInterval(() => void fetchUsage(), 60_000)
    context.data.listen((event) => {
      const type = (event as { details?: { type?: string } })?.details?.type ?? ""
      if (type.startsWith("session.usage")) void fetchUsage()
      // A new sign-in swaps the provider list: refresh so the footer and the
      // "нет auth" markers update without reopening the dialog.
      if (type.startsWith("provider.") || type.startsWith("credential.") || type.startsWith("integration.")) void refresh()
    })

    // Ollama Cloud keeps its own balance API: GET https://ollama.com/api/balance
    // (Bearer OLLAMA_API_KEY) returns remaining included credits for the plan period.
    const [ollama, setOllama] = createSignal<OllamaBalance | undefined>(undefined)
    const ollamaKey = (): string | undefined => {
      const env = process.env.OLLAMA_API_KEY
      if (env) return env
      try {
        const { readFileSync } = require("node:fs") as typeof import("node:fs")
        const path = `${process.env.HOME}/.local/share/opencode/auth.json`
        const auth = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
        const entry = (auth["ollama-cloud"] ?? auth["ollama"]) as { key?: string; apiKey?: string; access_token?: string } | undefined
        return entry?.key ?? entry?.apiKey ?? entry?.access_token
      } catch {
        return undefined
      }
    }
    const fakeBalance = (): OllamaBalance | undefined => {
      const raw = process.env.TARIFF_FAKE_BALANCE
      if (!raw) return undefined
      try {
        const { readFileSync } = require("node:fs") as typeof import("node:fs")
        return JSON.parse(raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw) as OllamaBalance
      } catch {
        return undefined
      }
    }
    const fetchOllama = async (): Promise<void> => {
      const fake = fakeBalance()
      if (fake) {
        setOllama(fake)
        return
      }
      const key = ollamaKey()
      if (!key) return
      try {
        const res = await fetch("https://ollama.com/api/balance", {
          headers: { authorization: `Bearer ${key}` },
        })
        if (!res.ok) return
        setOllama((await res.json()) as OllamaBalance)
      } catch (e) {
        console.error("[tariff] ollama balance failed:", e instanceof Error ? e.message : e)
      }
    }
    void fetchOllama()
    const ollamaTimer = setInterval(() => void fetchOllama(), 60_000)

    const themeBase = (): string => {
      const th = context.theme as unknown
      const base = (th as { text?: { base?: unknown } })?.text?.base
      return hex(base) ?? "#eeeeee"
    }
    const themeMuted = (): string => {
      const th = context.theme as unknown
      const muted = (th as { text?: { muted?: unknown } })?.text?.muted
      return hex(muted) ?? "#808080"
    }
    const themeError = (): string => {
      const th = context.theme as unknown
      const err = (th as { text?: { feedback?: { error?: { base?: unknown } } } })?.text?.feedback?.error?.base
      return hex(err) ?? "#e06c75"
    }

    // Sidebar block: Go meters (5h/week/month) + Ollama Cloud balance, or the nearest budget line.
    context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const goRows = usageRows(usage())
        const olRows = ollamaRows(ollama())
        const budget = budgetLine(usage())
        if (goRows.length === 0 && olRows.length === 0) {
          return <text fg={themeMuted()}>{budget ? ` ${budget}` : " "}</text>
        }
        return (
          <box flexDirection="column">
            <text fg={themeBase()}>Usage</text>
            <For each={goRows}>
              {(m) => (
                <text fg={m.limited ? themeError() : themeMuted()}>
                  {`${pad(m.label, 4)}${m.bar} ${m.percent}% · ${m.reset}`}
                </text>
              )}
            </For>
            <For each={olRows}>
              {(m) => <text fg={themeMuted()}>{`${pad(m.label, 4)}${m.bar} ${m.percent}% · ${m.reset}`}</text>}
            </For>
            <Show when={budget}>
              <text fg={themeMuted()}>{budget}</text>
            </Show>
          </box>
        )
      },
    })
    if (process.env.TARIFF_DEBUG) {
      try {
        const { appendFileSync } = require("node:fs") as typeof import("node:fs")
        const cl = context.client as unknown as Record<string, unknown>
        const shape: Record<string, unknown> = {}
        for (const k of Object.keys(cl)) {
          const v = cl[k]
          shape[k] = v && typeof v === "object" ? Object.keys(v as Record<string, unknown>) : typeof v
        }
        appendFileSync("/tmp/tariff-client.json", JSON.stringify(shape, null, 1))
      } catch (e) {
        void e
      }
    }
    const [rows, setRows] = createSignal<Row[]>([])
    const [providers, setProviders] = createSignal<Set<ProviderID>>(new Set())
    const [settings, setSettings] = createSignal<Settings>(DEFAULTS)
    const [version, setVersion] = createSignal(0)

    const refresh = async (): Promise<void> => {
      try {
        const [r, s] = await Promise.all([
          rpc.rows({}) as Promise<{ values?: Row[]; providers?: string[] }>,
          rpc.settings({}) as Promise<{ values?: Settings }>,
        ])
        setRows(r.values ?? [])
        setProviders(new Set((r.providers ?? []).map((id) => ofProvider(id)).filter((p): p is ProviderID => p !== undefined)))
        if (s.values) setSettings(s.values)
        setVersion((v) => v + 1)
      } catch (e) {
        console.error("[tariff] rpc failed:", e instanceof Error ? e.message : e)
      }
    }

    const currentModelOf = (): { modelID: string; providerID: string } | undefined => {
      const m = context.ui.model.current() as unknown
      if (!m || typeof m !== "object") return undefined
      const o = m as { id?: string; modelID?: string; providerID?: string }
      return { modelID: o.modelID ?? o.id ?? "", providerID: o.providerID ?? "" }
    }

    const bestFor = (current: { modelID: string; providerID: string } | undefined) => {
      const provider = ofProvider(current?.providerID ?? "")
      const family = familyOf(current?.modelID ?? "")
      const set = providers()
      const mine = rows().find((r) => r.model === family && r.provider === provider)
      // Only configured providers may be suggested: without a Go/Z.AI sign-in a
      // "cheaper" row must not appear in the footer or the dialog headline.
      const best = rows()
        .filter((r) => r.model === family && r.provider !== mine?.provider && set.has(r.provider))
        .sort((a, b) => a.blend - b.blend)[0]
      return { mine, best, family }
    }

    const headline = (): string => {
      void version()
      const s = settings()
      if (s.title === "off") return ""
      const { best, family } = bestFor(currentModelOf())
      const worst = worstMeter(usage()?.go)
      const ol = ollamaRows(ollama())[0]
      const usageNote = worst
        ? `${worst.label} ${bar(worst.meter.percent, 5)} ${Math.round(worst.meter.percent)}%`
        : ol
          ? `${ol.label} ${ol.bar.slice(0, 5)} ${ol.percent}%`
          : ""
      // Models outside the price catalog still show the subscription meters,
      // just without a provider recommendation.
      if (!family) return usageNote
      const head = `TARIFF${best ? ` ${NAMES[best.provider]}/${best.model}` : ""}`
      if (s.title === "short") return head
      return `${head} · auto ${s.auto ? "вкл" : "выкл"}${usageNote ? " · " + usageNote : ""}`
    }

    context.ui.slot({ append: "home.footer.status", render: () => <text> {headline()} </text> })
    context.ui.slot({ append: "prompt.footer.status", render: () => <text> {headline()} </text> })

    context.data.on("session.model.selected", () => void setVersion((v) => v + 1))
    rpc.events.on("changed", () => void refresh())
    void refresh()

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "tariff.dialog",
          title: "Tariff: model prices",
          group: "Tariff",
          palette: true,
          slash: { name: "tariff", aliases: ["prices"] },
          run: () => void open(),
        },
      ],
      bindings: ["tariff.dialog"],
    }))

    async function save(patch: Partial<Settings>): Promise<void> {
      const r = (await rpc.save(patch)) as { values?: Settings }
      if (r.values) setSettings(r.values)
      await refresh()
    }

    async function useVariant(row: Row, sessionID?: string): Promise<void> {
      const q: { sessionID?: string; providerID: string; modelID: string } = {
        providerID: OPENCODE_PROVIDER[row.provider],
        modelID: row.model,
      }
      if (sessionID) q.sessionID = sessionID
      await rpc.use(q)
      context.ui.toast.show({
        title: "Tariff",
        message: `${NAMES[row.provider]}/${row.model} ${money(row.blend, row.est)}/1M${sessionID ? " · сессия" : " · глобально"}`,
        variant: "success",
      })
      await refresh()
    }

    async function open(): Promise<void> {
      await refresh()
      void fetchUsage()
      void fetchOllama()
      context.ui.dialog.set({ size: "xlarge", centered: true })
      const set = providers()
      const s = settings()
      const cur = currentModelOf()
      const curProvider = ofProvider(cur?.providerID ?? "")
      const curFamily = familyOf(cur?.modelID ?? "")
      const refRow = rows().find((r) => r.model === curFamily && r.provider === curProvider)
      const refBlend = refRow && refRow.blend > 0 ? refRow.blend : undefined
      const meters = titleMeters(usage(), ollama())

      const pool = rows().filter((r) => (s.type === "cheap" ? r.blend < CHEAP_MAX : true))
      const ollamaAllowance = ollama()?.included?.allowance_usd
      const pctOfRow = (row: Row): number | undefined => rowCostPercent(row.blend, limitForRow(row, ollamaAllowance))
      const maxPct = Math.max(0, ...pool.map((r) => pctOfRow(r) ?? 0))
      const options = pool.map((row) => {
        const value = `${row.provider}/${row.model}`
        const mineCur = curProvider === row.provider && row.model === curFamily
        const delta = refBlend !== undefined ? pctOf(row.blend, refBlend) : "—"
        const marker = mineCur ? " " : set.has(row.provider) ? " " : "×"
        const pct = pctOfRow(row)
        return {
          title: `${marker} ${pad(row.model, 19)} ${pad(money(row.blend, row.est), 9)}/1M`,
          value,
          category: set.has(row.provider) ? NAMES[row.provider] : `${NAMES[row.provider]} (нет auth)`,
          description: `отн. ${delta}${row.offPeak ? " · off-peak" : ""}`.trim(),
          searchText: `${row.model} ${NAMES[row.provider]} ${delta}`,
          footer: `${costBar(pct, maxPct)} ${costText(pct)}`,
          detail:
            typeof row.est === "boolean" && row.est
              ? `кредиты/1M: input ${row.input.toFixed(0)} · cached ${row.cached.toFixed(0)} · output ${row.output.toFixed(0)} · курс ${settings().usdPerCredit} $/кредит${set.has(row.provider) ? "" : " · нет auth"}`
              : `${delta === "—" ? "" : `относительная стоимость: ${delta} · `}input $${row.input} · cached $${row.cached} · output $${row.output} за 1M${set.has(row.provider) ? "" : " · нет auth"}`,
        }
      })

      const byValue = new Map(options.map((o) => [o.value, o]))
      const value = await context.ui.dialog.select({
        title: ["Тариф", s.type === "cheap" ? "cheap" : "все", meters].filter(Boolean).join(" · "),
        options,
        current: curProvider !== undefined && curFamily ? `${curProvider}/${curFamily}` : undefined,
        actions: [
          {
            command: "tariff.auto",
            title: `авто: ${s.auto ? "вкл" : "выкл"}`,
            bind: "a",
            selection: "none" as const,
            onTrigger: async () => {
              const next = !settings().auto
              await save({ auto: next })
              context.ui.toast.show({ title: "Tariff", message: `автопереключение: ${next ? "вкл" : "выкл"}`, variant: "success" })
            },
          },
          {
            command: "tariff.type",
            title: "тип",
            bind: "t",
            selection: "none" as const,
            onTrigger: async () => {
              const next = cycle(settings().type, ["cheap", "full"] as Settings["type"][])
              await save({ type: next })
              context.ui.dialog.clear()
              void open()
            },
          },
          {
            command: "tariff.pin",
            title: (option) => {
              const row = typeof option?.value === "string" ? byValue.get(option.value) : undefined
              const p = row?.provider
              if (!p) return "закрепить провайдера"
              return set.has(p) && s.pin === p ? "убрать пин" : `закрепить ${NAMES[p]}`
            },
            bind: "p",
            selection: "required",
            onTrigger: async (option: { value: unknown }) => {
              const row = typeof option?.value === "string" ? byValue.get(option.value) : undefined
              if (!row) return
              const next = settings().pin === row.provider ? "" : row.provider
              await save({ pin: next })
              context.ui.toast.show({
                title: "Tariff",
                message: next ? `закреплён ${NAMES[next as ProviderID]} — авторотатор его не трогает` : "пин снят",
                variant: "success",
              })
            },
          },
        ],
      })
      if (!value) {
        await refresh()
        return
      }
      const chosen = byValue.get(value)
      if (!chosen) return
      if (!providers().has(chosen.provider)) {
        context.ui.toast.show({
          title: "Tariff",
          message: `нет авторизации у ${NAMES[chosen.provider]} — opencode auth login`,
          variant: "warning",
        })
        await refresh()
        return
      }
      await useVariant(chosen, lastSessionOf(context))
    }

    return () => {
      clearInterval(usageTimer)
      clearInterval(ollamaTimer)
    }
  },
})
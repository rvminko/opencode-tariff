// Server part of the tariff plugin: settings storage, RPC implementation, and the
// auto-switch engine that moves the session to the cheapest available provider
// variant of its current model family right before each prompt dispatch.

import { Plugin } from "@opencode/plugin"
import { Tariff } from "./rpc"
import { DEFAULTS, OPENCODE_PROVIDER, blended, familyOf, isProviderAvailable, ofProvider, rowsFor, type ProviderID, type Settings } from "./catalog"

// Availability checks use isProviderAvailable() on the active provider list from the server.

export default Plugin.define({
  id: "tariff",
  async setup(ctx) {
    const settings = async (): Promise<Settings> => ({
      ...DEFAULTS,
      ...((await ctx.storage.get<Settings>("settings")) ?? {}),
    })

    const registration = await ctx.rpc.register(Tariff, {
      rows: async () => {
        const ids = await ctx.provider.list()
        const records = ((ids as { data?: unknown })?.data ?? ids) as unknown[]
        const names = records.map((r) => {
          const o = r as { id?: string; providerID?: string; provider?: { id?: string } }
          return o?.id ?? o?.providerID ?? o?.provider?.id ?? ""
        })
        const providers = (["go", "ollama", "zai"] as ProviderID[])
          .filter((p) => isProviderAvailable(OPENCODE_PROVIDER[p], names))
          .map((p) => OPENCODE_PROVIDER[p])
        return { values: rowsFor(new Date(), (await settings()).usdPerCredit), providers }
      },
      settings: async () => ({ values: await settings() }),
      save: async (input) => {
        const current = await settings()
        const patch = (input ?? {}) as Partial<Settings>
        const next: Settings = {
          ...current,
          ...(patch.auto === undefined ? {} : { auto: !!patch.auto }),
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.pin === undefined ? {} : { pin: String(patch.pin ?? "") }),
          ...(patch.usdPerCredit === undefined ? {} : { usdPerCredit: Number(patch.usdPerCredit) }),
          ...(patch.type === undefined ? {} : { type: patch.type === "full" ? "full" as const : "cheap" as const }),
        }
        await ctx.storage.set("settings", next)
        await registration.events.emit("changed", {})
        return { values: next }
      },
      use: async (input) => {
        const q = (input ?? {}) as { sessionID?: string; providerID: string; modelID: string }
        if (!q.providerID || !q.modelID) return { ok: false }
        if (q.sessionID) {
          await ctx.session.switchModel({
            sessionID: q.sessionID,
            model: { providerID: q.providerID, id: q.modelID },
          })
          return { ok: true, scope: "session" }
        }
        await ctx.model.transform((editor) => {
          editor.default.set(q.providerID, q.modelID)
        })
        return { ok: true, scope: "global" }
      },
    })

    try {
      await ctx.session.hook("prompt", (event) => {
        void autoSwitch(event.sessionID as string).catch((e) =>
          console.error("[tariff] auto-switch failed:", e instanceof Error ? e.message : e),
        )
      })
    } catch (e) {
      console.error("[tariff] prompt hook registration failed:", e instanceof Error ? e.message : e)
    }

    async function autoSwitch(sessionID: string): Promise<void> {
      const s = await settings()
      if (!s.auto) return
      const info = (await ctx.session.get({ sessionID })) as { model?: { providerID: string; id: string } } | undefined
      const fallback = (await ctx.model.default()) as unknown
      const fb = fallback && typeof fallback === "object"
        ? fallback as { id?: string; modelID?: string; providerID?: string }
        : undefined
      const current = info?.model ?? (fb
        ? { providerID: fb.providerID ?? "", id: fb.modelID ?? fb.id ?? "" }
        : undefined)
      if (!current?.id || !current.providerID) return
      const provider = ofProvider(current.providerID)
      const family = familyOf(current.id)
      if (!family) return
      if (s.pin && current.providerID === OPENCODE_PROVIDER[s.pin as ProviderID]) return
      const ids = await ctx.provider.list()
      const records = ((ids as { data?: unknown })?.data ?? ids) as readonly unknown[]
      const nameOf = (r: unknown): string => {
        const o = r as { id?: string; providerID?: string; provider?: { id?: string } }
        return o?.id ?? o?.providerID ?? o?.provider?.id ?? ""
      }
      const available = new Set<ProviderID>()
      for (const p of ["go", "ollama", "zai"] as ProviderID[]) {
        if (isProviderAvailable(OPENCODE_PROVIDER[p], records.map(nameOf))) available.add(p)
      }
      const row = rowsFor(new Date(), s.usdPerCredit)
        .filter((r) => r.model === family && available.has(r.provider))
        .sort((a, b) => a.blend - b.blend)[0]
      if (!row || row.provider === provider) return
      await ctx.session.switchModel({
        sessionID,
        model: { providerID: OPENCODE_PROVIDER[row.provider], id: family },
      })
      console.error(
        `[tariff] auto: ${current.providerID}/${current.id} -> ${OPENCODE_PROVIDER[row.provider]}/${family} ($${row.blend.toFixed(3)}/1M${row.offPeak ? ", off-peak" : ""})`,
      )
    }
  },
})
# SPEC: Usage bars in the tariff dialog

Status: implemented (2026-11-01) · plugin opencode.tariff (v2, opencode v2.2.5)

## Implementation notes (deviations from the draft)

- `ui.dialog.select` accepts only `title / placeholder / options / current / search / actions` —
  there is no `description` slot for a custom block inside the dialog. Placement is therefore:
  - compact meters appended to the **dialog title** (`Тариф · cheap · 5ч 68% · нед 12% · мес 3%`);
  - worst meter appended to the **footer** headline (`TARIFF … · auto вкл · 5ч 68%`);
  - full bars in a **`sidebar.content` slot** block (`Usage` + `5ч [███████░░░] 68% · 21:15`),
    the same slot the built-in `opencode.sidebar.limit` plugin uses.
- Client access verified live: `context.client.usage.limits()` exists (mirror at
  `context.client.experimental.usage.limits`); `location` is optional. Implemented in
  `usage.ts` + `tui.tsx` (`fetchUsage`), polled every 60s, on dialog open, and on any
  `session.usage*` event.
- Budgets render as a single line (`лимит $4 из $5 · сброс …`) only when no Go meters exist.
- e2e: `test/e2e.mjs` scenarios 5 (meter helpers) and 6 (no sign-in → no usage text anywhere).

## Goal

Show how much of the subscription allowance remains, next to the price list in the `/tariff`
dialog, and keep it live while the dialog is open. Scope: OpenCode Go allowance (5h/weekly/monthly
meters); monthly budget meters come free from the same shape but render only when present.

## Non-goals

- Any auto-routing change (the user decided to keep routing as is).
- Local accounting of usage: OpenCode services already track usage server-side; we only read it.
- Non-Go subscriptions (Ollama credits / Z.AI points): no public usage endpoint known — out of
  scope until an official API exists (follow-up ticket if we find one).

## Data source (verified against sst/anomalyco opencode sources)

`GET /api/experimental/usage/limits` → `{ location, data: Info | null }`, where `Info`:

- `workspace`: `{ id, name?, usageURL }` — usage page in OpenCode Console.
- `go?: { rolling, weekly, monthly }` — each `Meter = { percent: 0..100, limited: bool, resetsAt: ms }`.
  Absent when the workspace does not subscribe to Go (the console-side fetch returns 403).
- `budgets: Budget[]` — monthly spend limits set by the Console workspace:
  `{ id, limit, spent, scope: each|combined, per: set|model, coverage: all|models, models[], vendors[], picked, shared, resetsAt }`.

Server-side plumbing (how OpenCode builds it, useful when debugging emptiness):

1. Console connection `integrations.connection.active("opencode")`; no connection → `null`.
2. Go meters: `GET {origin}/zen/go/v1/usage` with bearer token and `x-opencode-org-id` header;
   403 → no allowance (field omitted).
3. Budgets: `GET {server}/api/policies/current-budgets`; 403 → `[]`.
4. Both calls together time out at 15s → `ServiceUnavailable`; the HTTP route surfaces an error.

## UI specification

Row `Usage` between the header and the model list, one line per meter present:

- Bar: filled part = `percent`, remainder dim; monochrome, themed (accent ramp), no emoji.
- Label: `5 hour` / `week` / `month` + right-aligned reset time `… resets HH:MM (today)` —
  relative format reuses the plugin's locale helpers.
- When `limited` is true: bar turns error-colored and the row gets a suffix `refused until reset`.
- Zero usage (percent 0): the row still renders (shows "0%" state explicitly).
- No `go` field: Usage block is hidden entirely (do not render an empty frame).
- While the dialog is open: refetch every 60s and on the `session.usage.recorded` event.
  A fetch may fail silently; keep the previous bars (no flicker).

Placement option (phase 2, keep out of this task): a compact one-line strip in the footer next to
`TARIFF …` (`68%` of the tightest meter).

## Edge cases

- `resetsAt` in the past while `percent` is partial → show reset time anyway; no countdown math.
- Clock skew: countdown uses local time only, no server sync.
- Multiple budgets on one model: do not stack bars; the budget closest to its limit wins (mirror
  `left = min(limit - spent)` logic from the TUI util).
- Go meter for `opencode-go` endpoint itself (not console) is out of scope.

## Implementation plan

1. **T1 · client shape check (0.5h)** — in the running app confirm the generated client exposes
   `usage.limits`; fall back to a raw HTTP GET against the server base if not. Record the method
   name and the exact envelope in a code comment referencing this spec.
2. **T2 · server side (1h)** — in `console.ts`/`index.ts` of the plugin: a module-level reactive
   state `{ info, fetchedAt }`, refreshed by: dialog open, 60s interval, `session.usage.recorded`
   event. Publish through the existing RPC: new method `usage` returning `Info | null`.
3. **T3 · TUI bars (1h)** — rendering as specified; reuse `formatReset`-style relative time;
   colors only from `theme` tokens (good/bad/muted).
4. **T4 · wiring (0.5h)** — insert into the dialog: header → Usage → Models → Управление;
   hidden when absent.
5. **T5 · e2e (1h)** — scenario: open dialog → parse "5 hour/week/month" lines + percentages;
   states: not-signed-in (no block), limited (red). Live subscription data is only available on a
   machine with Go enabled: the scenario degrades to "block hidden" assert without it.

## Addendum: Ollama Cloud meters (added after review)

OpenCode's `usage.limits` covers Console/Go only, so Ollama Cloud was invisible. Ollama exposes
its own balance API: `GET https://ollama.com/api/balance` (`Bearer OLLAMA_API_KEY`, 10 req/min):

- current plan: `included { balance_usd, allowance_usd, period{from,until} }`, `purchased { balance_usd }`;
  meter percent = `(allowance - balance) / allowance`, detail shows `$balance из $allowance` and
  purchased credits;
- legacy plans: `included.session/weekly { remaining_percent, resets_at }` → percent = `100 - remaining`.

The TUI part resolves the key from `OLLAMA_API_KEY` or (read-only) the `ollama-cloud` entry in
`~/.local/share/opencode/auth.json`, polls together with the Go meters, and renders the same rows
(`ol 5ч`, `ol нед`, `ol`) in the sidebar, dialog title and the footer bar. Debug injection for tests:
`TARIFF_FAKE_BALANCE=json|@path`.

## Open questions

- Does `opencode.ai/console/go` expose per-workspace limits without OAuth (API key path)? Verify
  in T1.
- Rate limits of the endpoint (polling once per minute): confirm there is no stricter budget than
  the usage-accounting route (10/min) — otherwise raise the interval.
- Z.AI subscription points: no public usage endpoint known yet; mirror this spec per provider if one
  appears.
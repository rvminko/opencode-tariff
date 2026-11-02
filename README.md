# opencode-tariff

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![e2e](https://github.com/rvminko/opencode-tariff/actions/workflows/e2e.yml/badge.svg)](https://github.com/rvminko/opencode-tariff/actions/workflows/e2e.yml)
![OpenCode v2](https://img.shields.io/badge/opencode-v2-blue)

Cost-aware model picker and subscription usage meters for [OpenCode](https://opencode.ai) v2.

The plugin compares token prices across **Ollama Cloud**, **OpenCode Go** and **Z.AI GLM Coding Plan**
at the current time of day, shows the comparison inside the TUI, and can move a session to the
cheapest provider of the same model family right before each prompt.

## Features

- `/tariff` dialog (native `DialogSelect`, same widget as `/models`): every catalog model on every
  provider it exists on, sorted by blended price, with
  - a **relative price** per row (`отн. −35%` against the currently selected model),
  - a **limit-usage bar** per row: how many percent of that model's monthly allowance one million
    blended tokens consume (Ollama: your real plan allowance; Go: the published per-model limit),
  - `●` marker on the current model, `×` and a muted category on providers without auth,
  - footer actions: `a` auto-switch on/off, `t` list type (`cheap` / all), `p` pin provider.
- Auto-switch: right before each prompt the session moves to the cheapest configured provider of the
  **same model family** (never changes the model itself). Pinned providers are skipped.
- Usage meters in the dialog title, the footer and a `sidebar.content` block:
  - OpenCode Go 5h / weekly / monthly allowance (from OpenCode's own `usage.limits`),
  - Ollama Cloud remaining plan credits (`GET https://ollama.com/api/balance`),
  - Console budgets, when the workspace sets any (single line).
- Peak/off-peak aware: DeepSeek models are cheaper off-peak on both Ollama and Go (their windows
  differ, so the plugin picks whichever is currently off-peak); Z.AI burns half the credits off-peak.

## Requirements

- OpenCode v2 (developed and e2e-tested against 2.2.5). The v1 plugin API is not supported.
- No extra runtime: the plugin is plain TypeScript executed by OpenCode itself.
- Credentials only for what you use: `opencode auth login` → OpenCode (Console/Go) and/or Z.AI;
  Ollama Cloud uses `OLLAMA_API_KEY` or the `ollama-cloud` entry in
  `~/.local/share/opencode/auth.json` (read-only).

## Install

Copy the repository into OpenCode's global plugin directory (it is discovered automatically, no
config edits needed):

```bash
git clone https://github.com/rvminko/opencode-tariff.git ~/.config/opencode/plugins/tariff
opencode plugin list   # should list "tariff"
```

Restart the TUI and run `/tariff`.

Alternative: keep the sources anywhere and add them to `opencode.jsonc`:

```jsonc
{
  "plugins": [{ "package": "/absolute/path/to/opencode-tariff" }],
}
```

### Configure

Settings live in the plugin's durable storage and are changed from the dialog footer
(`a` / `t` / `p`). Defaults: auto-switch off, headline `full`, list type `cheap`, no pin,
Z.AI credit rate `usdPerCredit = 0.0004` (≈ Lite plan; adjust to your plan via the RPC `save`
method until a UI field exists).

## How prices are computed

Catalog: `catalog.ts`, read from the official pages on **2026-11-01**:

| Source | URL | Notes |
|---|---|---|
| Ollama Cloud | https://ollama.com/pricing | per-token USD; off-peak outside Mon–Fri 12:00–18:00 UTC and all weekend (off-peak rows published for DeepSeek models: 50% off) |
| OpenCode Go | https://opencode.ai/v2/docs/console/go | per-model USD; DeepSeek peak Mon–Fri 01:00–04:00 and 06:00–10:00 UTC, otherwise off-peak |
| Z.AI GLM Coding Plan | https://docs.z.ai/devpack/overview | credit multipliers; peak Mon–Fri 14:00–18:00 UTC+8 (06:00–10:00 UTC), off-peak 50% |

The comparison metric is a blended price per 1M tokens with a fixed agentic mix
(`input×0.25 + cache_read×0.65 + output×0.10`). Z.AI credits are converted with `usdPerCredit`.

`GO_MONTHLY_LIMIT` (in `catalog.ts`) is the per-model monthly allowance published for OpenCode Go,
used only to render the row bars; OpenCode enforces the limits server-side.

Prices are a snapshot — update the tables when providers change them.

## Usage meters

- OpenCode Go & Console budgets: `GET /api/experimental/usage/limits` via the generated client
  (`client.usage.limits()`); the OpenCode server builds it from your Console connection.
  Polled every 60 s, on dialog open and on `session.usage*` events.
- Ollama Cloud: `GET https://ollama.com/api/balance`, percent = `(allowance − balance) / allowance`
  for current plans, `100 − remaining_percent` for legacy session/weekly limits.
- Z.AI: no public quota API — meters are intentionally absent.

## Limitations

- Prices and Go limits are a snapshot (see dates above).
- Per-model *spent* is not exposed by any provider API; row bars show cost-of-usage, not history.
- Auto-switch does not retry a refused request (quota exhaustion) — the next prompt re-evaluates.
- Z.AI meter is not implemented until an official usage endpoint exists.

## Development

```bash
node test/e2e.mjs          # all scenarios
node test/e2e.mjs 2        # one scenario
```

The e2e harness drives a real TUI in a disposable Docker container
(`tariff-e2e`, opencode linux binary + tmux) with `capture-pane -e` snapshots: keyboard, mouse,
toggle re-open, catalog/meter unit tests, and usage rendering with injected data.
It mounts `~/.config/opencode` into the container; CI sets `TARIFF_CONFIG_DIR` to a
throwaway directory with a minimal `opencode.json` so tests never touch local credentials.

Debug hooks (environment variables, used by the tests):

- `TARIFF_DEBUG=1` — dump the generated client shape to `/tmp/tariff-client.json`;
- `TARIFF_FAKE_USAGE=json|@file` — inject `UsageLimits.Info`;
- `TARIFF_FAKE_BALANCE=json|@file` — inject an Ollama balance response.

## Repository layout

```
index.ts    server part: settings, RPC (rows/settings/save/use), auto-switch engine
tui.tsx     TUI part: /tariff dialog, footer headline, sidebar usage block
rpc.ts      RPC contract (JSON schemas)
catalog.ts  price catalog, schedules, per-provider availability helpers
usage.ts    meters: Go/Console + Ollama balance + per-row limit math
test/e2e.mjs        Docker-driven end-to-end tests
```

## License

MIT — see [LICENSE](LICENSE).

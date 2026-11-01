// E2E for the tariff TUI plugin: each scenario = ONE docker exec bash script that
// boots the TUI in tmux, drives keys, and writes capture-pane -e snapshots to files.
// node only parses the snapshots (cursor highlight line, pane text) — no cross-exec state.
// Usage: node test/e2e.mjs [scenarioNumber]. Requires Docker (container: tariff-e2e).

import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const CONTAINER = "tariff-e2e"
const SESSION = "T"
const W = "/tmp/work"
// Repository root (this file lives in <repo>/test/).
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const REPO_MOUNT = "/root/.config/opencode/plugins/tariff"
// OpenTUI highlight in capture-pane: 256-palette 216 (full-color builds: 48;2;250;178;131).
const CURSOR_BG = [/48;5;216m/, /48;2;250;178;131m/]

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${extra ? "  <- " + JSON.stringify(extra).slice(0, 300) : ""}`)
  }
}

function execScript(script, timeoutMs = 240000) {
  const r = spawnSync("docker", ["exec", CONTAINER, "bash", "-c", script], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024 })
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status ?? -1 }
}


// Cursor lines: list rows ("<model> … $X.XX") carrying the highlight.
function cursorListLines(buf) {
  return buf
    .map((l, i) => (l.includes("/1M") && CURSOR_BG.some((p) => p.test(l))) ? i : -1)
    .filter((i) => i >= 0)
}



// ── container ────────────────────────────────────────────────────────────────

function inspect(fmt) {
  const r = spawnSync("docker", ["inspect", "-f", fmt, CONTAINER], { encoding: "utf8" })
  return r.status === 0 ? (r.stdout ?? "").trim() : ""
}

function ensureContainer() {
  const running = inspect("{{.State.Running}}") === "true"
  const mounted = inspect("{{json .Mounts}}").includes(REPO_MOUNT)
  if (running && mounted) return
  spawnSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" })
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const run = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-v",
      `${join(homedir(), ".config/opencode")}:/root/.config/opencode:ro`,
      "-v",
      `${REPO}:${REPO_MOUNT}:ro`,
      "node:22-bookworm-slim",
      "sleep",
      "infinity",
    ],
    { encoding: "utf8" },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  console.log("container created (first run installs opencode + tmux, may take a minute)")
  const setup = execScript(
    `apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq tmux curl >/dev/null 2>&1 && ` +
      `curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v2.2.5/opencode-linux-${arch}.tar.gz" -o /tmp/oc.tgz && ` +
      `cd /tmp && tar xzf oc.tgz && mv -f /tmp/opencode /usr/local/bin/opencode && chmod +x /usr/local/bin/opencode && ` +
      `mkdir -p /tmp/work && echo SETUP-OK`,
    420000,
  )
  if (!setup.out.includes("SETUP-OK")) throw new Error(`setup failed: ${setup.err.slice(0, 300)}`)
}

// ── scenario bodies (inside one exec each) ───────────────────────────────────

const OPEN_SCRIPT = `
cd /tmp/work || exit 9
tmux kill-server 2>/dev/null
tmux new-session -d -s T -x 110 -y 32 "TERM=xterm-256color opencode"
sleep 9
tmux send-keys -t T -l '/tariff'
tmux send-keys -t T Enter
sleep 2.6
tmux capture-pane -e -p > ${W}/a.txt
`

function runOpen() {
  const r = execScript(OPEN_SCRIPT)
  if (r.code !== 0) console.log(`  [open:code=${r.code}] ${r.err.slice(0, 200)}`)
}

function readSnapshot(file) {
  return execScript(`cat ${W}/${file}`, 30000).out
}

// S1: arrows move the highlight by N rows.
function s1_arrows(n = 3) {
  runOpen()
  const capBefore = readSnapshot("a.txt")
  let bufA = parseLines(capBefore)
  const firstA = findLineIndex(bufA, "/1M")
  check("S1: list rendered after open", firstA >= 0, bufA.slice(0, 8))
  check("S1: rows carry limit-usage bars and percent", bufA.some((l) => /[█░]{10} \d+(\.\d+)?%/.test(l)), bufA.filter((l) => /[█░]/.test(l)).slice(0, 2))
  const cursorA = cursorListLines(bufA)
  check("S1: cursor on first row after open", cursorA.includes(firstA), { firstA, cursorA })

  execScript(`
tmux send-keys -t T Down && sleep 0.7
tmux send-keys -t T Down && sleep 0.7
tmux send-keys -t T Down && sleep 1.2
tmux capture-pane -e -p > ${W}/b.txt
`)
  const bufB = parseLines(readSnapshot("b.txt"))
  const cursorB = cursorListLines(bufB)
  check("S1: cursor moved by 3", cursorB.length >= 1 && cursorB[0] - Math.max(firstA, 0) === 3, { firstA, cursorB })
  execScript("tmux send-keys -t T Escape; true", 15000)
}

function parseLines(cap) {
  // capture-pane -e output already has one terminal line per array element.
  const withColor = cap
    .replace(/\x1b\]?[^G\x1b]*/g, (m) => (/\d+;\d+H|\[K|\[1m|\[48|\[38/.test(m) ? m : ""))
  return withColor.split("\n")
}

function findLineIndex(buf, needle) {
  return buf.findIndex((l) => l.includes(needle))
}

// S2: mouse click moves the highlight (native select wires mouse to move/select).
function s2_mouse() {
  runOpen()
  const firstIdx = findLineIndex(parseLines(readSnapshot("a.txt")), "/1M")
  const screenRow = firstIdx + 1 + 2 // capture line (1-based) = tmux pane row
  execScript(
    `tmux send-keys -l -t T "$(printf '\\033[<0;30;${screenRow}M')" && sleep 0.2
     tmux send-keys -l -t T "$(printf '\\033[<0;30;${screenRow}m')" && sleep 1.2
     tmux capture-pane -e -p > ${W}/m.txt`,
  )
  const bufM = parseLines(readSnapshot("m.txt"))
  // Native select submits on click (onMouseUp → submit); no-auth rows resolve too.
  const submitted = !bufM.some((l) => l.includes("Search"))
  check("S2: click submitted the picked row (composer back)", submitted, { opened: bufM.some((l) => l.includes("Тариф")) })
  execScript("tmux send-keys -t T Escape; true", 15000)
}

// S3: keyboard toggles re-open the dialog (a → auto; t → type cheap/all).
function s3_toggles() {
  runOpen()
  execScript(`
tmux send-keys -t T a && sleep 1.1
tmux send-keys -t T t && sleep 2
tmux capture-pane -e -p > ${W}/t.txt
`)
  const bufT = parseLines(readSnapshot("t.txt"))
  check("S3: dialog re-opened after type toggle", findLineIndex(bufT, "Тариф") >= 0, bufT.slice(0, 6))
  execScript("tmux send-keys -t T Escape; true", 15000)
}

// S4: unit — catalog math and relative-price semantics.
async function s4_unit() {
  const cat = await import("../catalog.ts")
  const rows = cat.rowsFor(new Date("2026-11-01T12:00:00Z"), 0.0004)
  check("S4: rowsFor returns 29 rows", rows.length === 29, rows.length)
  check("S4: no NaN blends", rows.every((r) => Number.isFinite(r.blend)))
  const glmFlashOllama = rows.find((r) => r.model === "glm-5.3-flash" && r.provider === "ollama")
  const glmFlashZai = rows.find((r) => r.model === "glm-5.3-flash" && r.provider === "zai")
  const mimoGo = rows.find((r) => r.model === "mimo-v2.6-flash" && r.provider === "go")
  check("S4: glm-flash ollama ≈ 0.107", Math.abs(glmFlashOllama.blend - 0.107) < 0.01)
  check("S4: glm-flash zai ≈ 0.0696", Math.abs(glmFlashZai.blend - 0.0696) < 0.01)
  check("S4: zai relative to current ≈ −35%", inRange(rel(glmFlashZai, glmFlashOllama), [-40, -30]))
  check("S4: mimo-go relative ≈ −40%", inRange(rel(mimoGo, glmFlashOllama), [-45, -35]))
  check("S4: sunday all off-peak", rows.every((r) => r.offPeak))
  const mondayPeak = cat.rowsFor(new Date("2026-11-02T13:00:00Z"), 0.0004)
  const dsPeak = mondayPeak.find((r) => r.model === "deepseek-v4.1-flash" && r.provider === "ollama")
  check("S4: monday 13:00 UTC deepseek peak", dsPeak.offPeak === false)
  check("S4: isProviderAvailable exact/prefix", cat.isProviderAvailable("ollama-cloud", ["opencode", "ollama-cloud", "mtplx"]) && !cat.isProviderAvailable("opencode-go", ["opencode", "ollama-cloud"]))
}

// S5: unit — usage meter helpers.
async function s5_usage_unit() {
  const u = await import("../usage.ts")
  const now = Date.parse("2026-11-01T20:30:00")
  const go = {
    rolling: { percent: 68, limited: false, resetsAt: Date.parse("2026-11-01T21:15:00") },
    weekly: { percent: 12, limited: false, resetsAt: Date.parse("2026-11-05T10:00:00") },
    monthly: { percent: 3, limited: true, resetsAt: Date.parse("2026-12-01T00:00:00") },
  }
  check("S5: bar 0% empty", u.bar(0) === "░".repeat(10), u.bar(0))
  check("S5: bar 100% full", u.bar(100) === "█".repeat(10), u.bar(100))
  check("S5: bar 68% ≈ seven cells", u.bar(68) === "█".repeat(7) + "░".repeat(3), u.bar(68))
  check("S5: bar clamps", u.bar(140) === "█".repeat(10) && u.bar(-5) === "░".repeat(10))
  check("S5: worst meter is highest percent", u.worstMeter(go)?.label === "5ч", u.worstMeter(go)?.label)
  check("S5: no go → no compact", u.compactLine({}) === "")
  check("S5: compact line", u.compactLine({ go }) === "5ч 68% · нед 12% · мес 3%", u.compactLine({ go }))
  check("S5: reset today shows HH:MM", u.resetText(Date.parse("2026-11-01T21:15:00"), now) === "21:15", u.resetText(Date.parse("2026-11-01T21:15:00"), now))
  check("S5: reset other day shows date", u.resetText(Date.parse("2026-11-05T10:00:00"), now).startsWith("5 ноя"), u.resetText(Date.parse("2026-11-05T10:00:00"), now))
  check("S5: budget line picks closest to limit", u.budgetLine({ budgets: [{ id: "a", limit: 100, spent: 10, per: "set", coverage: "all", resetsAt: now }, { id: "b", limit: 5, spent: 4, per: "set", coverage: "all", resetsAt: now }] }).startsWith("лимит $4 из $5"), u.budgetLine({ budgets: [{ id: "a", limit: 100, spent: 10, per: "set", coverage: "all", resetsAt: now }, { id: "b", limit: 5, spent: 4, per: "set", coverage: "all", resetsAt: now }] }))
  check("S5: empty without data", u.rows(undefined).length === 0 && u.budgetLine(undefined) === "")
  // Ollama Cloud balance (GET /api/balance): used% = (allowance - balance) / allowance.
  const bal = { included: { balance_usd: 21.5, allowance_usd: 60, period: { from: "2026-10-28T00:00:00Z", until: "2026-11-28T00:00:00Z" } }, purchased: { balance_usd: 5 } }
  const ol = u.ollamaRows(bal, now)
  check("S5: ollama used percent", ol.length === 1 && ol[0].percent === 64, ol)
  check("S5: ollama detail money", ol[0]?.detail.includes("$21.50 из $60") && ol[0]?.detail.includes("покупные $5.00"), ol[0]?.detail)
  check("S5: ollama compact", u.ollamaCompact(bal) === "ol 64%", u.ollamaCompact(bal))
  const legacy = { included: { session: { remaining_percent: 75, resets_at: "2026-11-01T23:00:00Z" }, weekly: { remaining_percent: 40, resets_at: "2026-11-05T00:00:00Z" } }, purchased: { balance_usd: 0 } }
  check("S5: ollama legacy session/weekly", u.ollamaRows(legacy, now).map((m) => `${m.label} ${m.percent}`).join(", ") === "ol 5ч 25, ol нед 60", u.ollamaRows(legacy, now))
  check("S5: ollama empty without balance", u.ollamaRows({}).length === 0 && u.ollamaCompact(undefined) === "")
  // Per-row limit usage: percent of the monthly allowance per 1M blended tokens.
  check("S5: row cost percent cheap", u.costText(u.rowCostPercent(0.065, 60)) === "0.1%", u.costText(u.rowCostPercent(0.065, 60)))
  check("S5: row cost percent expensive", u.costText(u.rowCostPercent(2.445, 60)) === "4.1%", u.costText(u.rowCostPercent(2.445, 60)))
  check("S5: row cost above ten percent rounds", u.costText(u.rowCostPercent(9, 60)) === "15%", u.costText(u.rowCostPercent(9, 60)))
  check("S5: row cost unknown limit", u.rowCostPercent(0.1, undefined) === undefined && u.costText(undefined) === "—")
  check("S5: cost bar scales to max", u.costBar(4.075, 4.075) === "█".repeat(10) && u.costBar(0.108, 4.075) === "░".repeat(10), [u.costBar(4.075, 4.075), u.costBar(0.108, 4.075)])
  check("S5: cost bar unknown", u.costBar(undefined, 5) === "░".repeat(10))
}

// S6 (live): with no Console sign-in the dialog title and footer carry no meter text.
function s6_usage_live_absent() {
  runOpen()
  const buf = parseLines(readSnapshot("a.txt"))
  const title = buf.find((l) => l.includes("Тариф")) ?? ""
  const footer = buf.find((l) => /TARIFF/.test(l)) ?? ""
  check("S6: dialog opened", title.length > 0, title)
  check("S6: no usage in title without sign-in", !/5ч|нед|мес/.test(title), title)
  check("S6: no usage in footer without sign-in", !/· 5ч|· нед|· мес/.test(footer), footer)
  execScript("tmux send-keys -t T Escape; true", 15000)
}

const rel = (a, b) => Math.round(((a.blend - b.blend) / b.blend) * 100)
const inRange = (v, [lo, hi]) => v >= lo && v <= hi

// S7 (live, fake data): with injected usage the dialog title/footer and sidebar
// block must render the meters and bars.
function s7_usage_present() {
  const fake = JSON.stringify({
    go: {
      rolling: { percent: 68, limited: false, resetsAt: Date.now() + 3600_000 },
      weekly: { percent: 12, limited: false, resetsAt: Date.now() + 5 * 86_400_000 },
      monthly: { percent: 3, limited: true, resetsAt: Date.now() + 30 * 86_400_000 },
    },
  })
  execScript(`mkdir -p ${W} && printf '%s' '${fake}' > ${W}/fake-usage.json`)
  execScript(`
cd /tmp/work || exit 9
tmux kill-server 2>/dev/null
tmux new-session -d -s T -x 110 -y 32 "TERM=xterm-256color TARIFF_FAKE_USAGE=@${W}/fake-usage.json opencode"
sleep 9
tmux send-keys -t T -l '/tariff'
tmux send-keys -t T Enter
sleep 2.8
tmux capture-pane -e -p > ${W}/u.txt
`)
  const text = readSnapshot("u.txt")
  const buf = parseLines(text).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " "))
  const title = buf.find((l) => l.includes("Тариф")) ?? ""
  const footer = buf.find((l) => /68%/.test(l) && /[█░]{5}/.test(l)) ?? ""
  check("S7: dialog title shows meters", /5ч [█░]{5} 68% · нед 12% · мес 3%/.test(title), title)
  check("S7: footer shows worst meter", /5ч [█░]{5} 68%/.test(footer), footer)
  execScript("tmux send-keys -t T Escape; sleep 0.5; tmux kill-server 2>/dev/null; true", 20000)
}

// S8 (live, fake data): Ollama Cloud balance renders in the footer and dialog title.
function s8_ollama_present() {
  const fake = JSON.stringify({
    included: { balance_usd: 19.2, allowance_usd: 60, period: { from: "2026-10-28T00:00:00Z", until: "2026-11-28T00:00:00Z" } },
    purchased: { balance_usd: 5 },
  })
  execScript(`mkdir -p ${W} && printf '%s' '${fake}' > ${W}/fake-balance.json`)
  execScript(`
cd /tmp/work || exit 9
tmux kill-server 2>/dev/null
tmux new-session -d -s T -x 110 -y 32 "TERM=xterm-256color TARIFF_FAKE_BALANCE=@${W}/fake-balance.json opencode"
sleep 9
tmux send-keys -t T -l '/tariff'
tmux send-keys -t T Enter
sleep 2.8
tmux capture-pane -e -p > ${W}/o.txt
`)
  const buf = parseLines(readSnapshot("o.txt")).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " "))
  const title = buf.find((l) => l.includes("Тариф")) ?? ""
  const footer = buf.find((l) => /68%/.test(l) && /[█░]{5}/.test(l)) ?? ""
  check("S8: dialog title shows ollama meter", /ol [█░]{5} 68%/.test(title), title)
  check("S8: footer shows ollama bar", /ol [█░]{5} 68%/.test(footer), footer)
  execScript("tmux send-keys -t T Escape; sleep 0.5; tmux kill-server 2>/dev/null; true", 20000)
}

const scenarios = [s1_arrows, s2_mouse, s3_toggles, s4_unit, s5_usage_unit, s6_usage_live_absent, s7_usage_present, s8_ollama_present]
const only = process.argv[2] ? Number(process.argv[2]) - 1 : undefined
ensureContainer()
for (let i = 0; i < scenarios.length; i++) {
  if (only !== undefined && only !== i) continue
  console.log(`\n== scenario ${i + 1}: ${scenarios[i].name}`)
  try {
    await scenarios[i]()
  } catch (e) {
    fail++
    console.log(`FAIL  scenario crashed: ${e?.message}`)
  }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
// statusband: a colorful status sidebar for Claude Code.
//
// - Fullscreen terminal / Desktop app: a pane docked beside the transcript (sectioned sidebar).
// - Classic renderer, or the pane not on screen: a compact multi-line summary under the prompt,
//   drawn at the PromptHint site, with the engine's own hint line kept above it.
//
// No network calls. Data comes from mods API events, local `git`, and this plugin's own $.store
// (a daily cost ledger, per-model tokens and time by day, and plan-limit samples for the run-out forecast).
// Layout ideas (docked/inline modes, agent rows, last-turn receipt) were inspired by
// scasella/claude-flightdeck (MIT); no code was copied.

import { num, fmtTokens, fmtDur, fmtUsd, fmtClock, dayKey, toMs, bar, shorten, prettyModel, limitShape, addSample, quotaFor, fit, scriptDesc, runLine, pickScript, scriptName, ownScripts, staleScripts, ownerOf, addModelUse, sumModelUse, sparkline, turnsLeft, cacheHit, addToolUse, toCsv } from './lib.js'

// ---------------------------------------------------------------- settings ---

const PANE = 'statusband'
const SCRIPTS_PANE = 'statusband-scripts' // its own tab beside the status pane
const AGENTS_PANE = 'statusband-agents' // likewise
const COSTS_PANE = 'statusband-costs' // cost, models, repos, tools
const PANE_COLUMNS = 46
const PANE_ROWS = 9
const GIT_EVERY_MS = 15_000
const TICK_MS = 30_000
const PANE_STALE_MS = 45_000
const PANE_RETRY_MS = 60_000
const CTX_WARN = 75
const CTX_CRIT = 90
const QUOTA_WARN = 50
const QUOTA_CRIT = 80
const PACE_WARN = 0.9
const PACE_CRIT = 1.1
const TOAST_LEVELS = [80, 95]
const LEDGER_DAYS = 35
const MODEL_DAYS = 7 // /statusband models adds up this many days
const SESSIONS_SHOWN = 15 // and lists this many sessions, newest first
const TREND_DAYS = 14 // the Costs tab's daily cost sparkline
const REPORT_DAYS = 30 // /statusband report's default span
const CACHE_WARN = 80 // cache share of the input below this is amber, below CACHE_CRIT red
const CACHE_CRIT = 50
const SHOWN_ROWS = 5 // repos and tools on the Costs tab
const AGENTS_KEPT = 20 // finished ones the Agents tab keeps, newest first
const SCRIPTS_DIR = '.scripts' // in the working directory; ignores itself in git
const SCRIPTS_SHOWN = 5
const SCRIPTS_KEEP_MS = 7 * 86_400_000 // other sessions' scripts older than this go at session start
const SCRIPTS_GRACE_MS = 15 * 60_000 // /statusband clean spares other sessions' scripts this fresh
// A repo's own config must not run anything on our git status: no fsmonitor hook.
const GIT_SAFE = ['-c', 'core.fsmonitor=false']
const SCRIPT_WRITERS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

// Asks the model to hand the person scripts as files the band can run or copy.
const SCRIPTS_PROMPT = [
  '# Scripts for the user',
  `When you give the user a script or a multi-line command to run or copy themselves, write it to \`${SCRIPTS_DIR}/<short-name>.sh\` in the working directory (or .py, .zsh, .js), with a one-line \`#\` comment under the shebang saying what it does, and name that path in your reply instead of pasting the whole script.`,
  `The user's status sidebar lists these files with run and copy buttons; \`/statusband run <name>\` and \`/statusband copy <name>\` do the same. Commands you run yourself are not affected.`,
].join('\n')

// Claude Code theme keys: they follow the light/dark theme. Teal is the subagents' own cyan.
const C = {
  green: 'success',
  amber: 'warning',
  red: 'error',
  blue: 'suggestion',
  purple: 'merged',
  magenta: 'permission',
  orange: 'claude',
  teal: 'cyan_FOR_SUBAGENTS_ONLY',
  gray: 'inactive',
  light: 'subtle',
  text: 'text',
}
const EFFORT_COLOR = { low: C.gray, medium: C.blue, high: C.orange, xhigh: C.red, max: C.red }

// ------------------------------------------------------------------- state ---

let git = null // { repo, branch, dirty, ahead, behind }
let ctx = null // { pct, tokens, window }
let costUsd = null
let startedAt = null
let limits = [] // raw [{ kind, pct, resetsAt }]
let quotas = [] // computed rows
let costToday = null
let model = null
let effort = null
let isRunning = false
let profile = null // CLAUDE_PROFILE, set by a launcher (e.g. a sandbox wrapper)
let turnStart = null // { at, cost }
let lastTurn = null // { durationMs, costDelta, agents }
const agents = new Map() // id -> { id, name, status, spawnedAt, endedAt, ctxTokens, outTokens, steps }
const alerted = new Set()
let paneSeenAt = 0
let paneClosedByUser = false
let paneOpen = null
let paneRequested = false
let paneFailedAt = 0 // when $.ui.open last threw; tried again after PANE_RETRY_MS
let panePlacement = null
let lastStepKeys = []
let scripts = [] // this session's, newest first: [{ name, desc, mtimeMs }]
let scriptsOthers = [] // other sessions' files in the folder: [{ name, mtimeMs, written }]
let sessionId = null
let sessionSeenAt = Date.now() // fallback start when usage has no startedAt
let scriptsDir = null // <session cwd>/.scripts, absolute
let scriptsPaneOpen = false
let scriptsClosedByUser = false
let agentsPaneOpen = false
let agentsClosedByUser = false
let modelsSession = {} // per model, this session: { in, cached, out, ms, steps }
let modelsMine = {} // likewise, this session's share of today
let modelsToday = {} // every session's today, added up
let modelsDay = null // the day modelsMine counts
let sessionNamed = false // this session's name is in the store, for /statusband models
let costsPaneOpen = false
let costsClosedByUser = false
let costTrend = [] // daily cost, oldest first, TREND_DAYS long
let repoUse = [] // last MODEL_DAYS by repo: [{ repo, cost, ms, out }]
let toolUse = {} // this session: { [tool]: { n, err, ms } }
let turnToolMs = 0 // tool time in the running main turn
let ctxHist = [] // context tokens after each main turn, since the last drop

// ----------------------------------------------------------------- helpers ---

const level = (v, warn, crit) => (v >= crit ? C.red : v >= warn ? C.amber : C.green)

// ---------------------------------------------------------------- collect ---

async function refreshGit($) {
  try {
    const cwd = await $.session.cwd()
    const st = await $.process.run(['git', ...GIT_SAFE, '--no-optional-locks', '-C', cwd, 'status', '--porcelain=v2', '--branch'])
    if (st.exitCode !== 0) {
      git = { repo: cwd.split('/').filter(Boolean).pop() ?? cwd, branch: null }
      return
    }
    const top = await $.process.run(['git', ...GIT_SAFE, '-C', cwd, 'rev-parse', '--show-toplevel'])
    const g = { repo: top.stdout.trim().split('/').pop(), branch: null, dirty: 0, ahead: 0, behind: 0 }
    for (const line of st.stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) g.branch = line.slice(14).trim()
      else if (line.startsWith('# branch.ab ')) {
        const [a, b] = line.slice(12).trim().split(' ')
        g.ahead = Math.abs(Number(a)) || 0
        g.behind = Math.abs(Number(b)) || 0
      } else if (line && !line.startsWith('#')) g.dirty++
    }
    git = g
  } catch {
    // git missing or timed out: keep the last value
  }
}

const ownersKey = () => 'scripts:' + scriptsDir

async function scriptsFolder($) {
  scriptsDir = (await $.session.cwd()).replace(/\/+$/, '') + '/' + SCRIPTS_DIR
  return scriptsDir
}

// A file Claude wrote into .scripts/ belongs to this session.
async function claimScript($, path) {
  if (!sessionId) return
  const name = scriptName(await scriptsFolder($), path)
  if (!name) return
  const owners = (await $.store.get(ownersKey())) ?? {}
  if (owners[name]?.wrote !== true || ownerOf(owners[name]) !== sessionId) await $.store.set(ownersKey(), { ...owners, [name]: { session: sessionId, wrote: true } })
}

async function refreshScripts($) {
  try {
    const dir = await scriptsFolder($)
    if (!(await $.fs.exists(dir))) {
      scripts = []
      scriptsOthers = []
      return
    }
    // A linked folder leads somewhere else: it is left alone, nothing listed, written or deleted.
    if ((await $.fs.stat(dir)).isLink) {
      scripts = []
      scriptsOthers = []
      return
    }
    const files = (await $.fs.list(dir))
      .filter((f) => f.kind === 'file' && !f.name.startsWith('.'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    const owners = (await $.store.get(ownersKey())) ?? {}
    const { mine, others, orphans, claims } = ownScripts(files, owners, sessionId, startedAt ?? sessionSeenAt)
    // A folder with files no session claims is the person's own: no .gitignore goes into it.
    if (!orphans.length && !(await $.fs.exists(dir + '/.gitignore'))) await $.fs.write(dir + '/.gitignore', '*\n')
    // Claims of files gone from the folder are dropped.
    const kept = Object.fromEntries(Object.entries({ ...owners, ...claims }).filter(([n]) => files.some((f) => f.name === n)))
    if (JSON.stringify(kept) !== JSON.stringify(owners)) await $.store.set(ownersKey(), kept)
    scriptsOthers = others.map((f) => ({ name: f.name, mtimeMs: f.mtimeMs, written: f.written }))
    scripts = await Promise.all(
      mine.slice(0, SCRIPTS_SHOWN).map(async (f) => ({ name: f.name, mtimeMs: f.mtimeMs, desc: scriptDesc(await $.fs.read(dir + '/' + f.name).catch(() => '')) })),
    )
  } catch {
    // unreadable folder: keep the last list
  }
}

// Deletes other sessions' scripts: by hand all but the freshest, at session start the old ones.
async function cleanScripts($, maxAgeMs) {
  await refreshScripts($)
  const names = staleScripts(scriptsOthers, Date.now(), SCRIPTS_GRACE_MS, maxAgeMs)
  if (!names.length) return 0
  const r = await $.process.run(['rm', '-f', '--', ...names.map((n) => scriptsDir + '/' + n)])
  await refreshScripts($)
  return r.exitCode === 0 ? names.length : 0
}

// Run: the `!` line goes into the prompt box, so Enter runs it and its output lands in the transcript.
async function runScript($, sc) {
  const r = await $.prompt.fill({ text: runLine(scriptsDir, sc.name) })
  $.ui.toast(r?.isFilled === false ? '📜 could not fill the prompt box' : '📜 ' + sc.name + ' is in the prompt: Enter runs it', { timeoutMs: 5000 })
}

async function copyScript($, sc, surface) {
  const text = await $.fs.read(scriptsDir + '/' + sc.name)
  const r = await $.ui.copy(surface ? { text, surface } : { text })
  $.ui.toast(r?.isCopied ? '📋 ' + sc.name + ' copied' : '📋 copy failed: ' + (r?.reason ?? 'unknown'), { timeoutMs: 5000 })
}

async function sampleLimit($, label, pct, now) {
  const key = 'q:' + label
  const s = addSample((await $.store.get(key)) ?? [], pct, now)
  await $.store.set(key, s)
  return s
}

async function computeQuotas($, now) {
  const out = []
  for (const l of limits) {
    if (l.pct == null) continue
    const samples = await sampleLimit($, limitShape(l.kind).label, l.pct, now)
    out.push(quotaFor(l, samples, now))
  }
  out.sort((a, b) => (a.windowMs ?? Infinity) - (b.windowMs ?? Infinity) || a.label.localeCompare(b.label))
  quotas = out
}

async function recordCost($, now) {
  if (costUsd == null) return
  let sid = null
  try {
    sid = await $.session.id()
  } catch {}
  if (!sid) return
  const lastKey = 'last:' + sid
  const prev = (await $.store.get(lastKey)) ?? { cost: 0 }
  const delta = costUsd >= prev.cost ? costUsd - prev.cost : costUsd // lower means a fresh counter
  await $.store.set(lastKey, { cost: costUsd, ts: now })
  const dk = 'day:' + dayKey(now)
  const cur = Number((await $.store.get(dk)) ?? 0)
  if (delta > 0) await $.store.set(dk, cur + delta)
  costToday = cur + Math.max(0, delta)
  if (delta > 0) {
    const ck = 'costs:' + dayKey(now)
    const by = (await $.store.get(ck)) ?? {}
    await $.store.set(ck, { ...by, [sid]: (by[sid] ?? 0) + delta })
    await nameSession($, sid)
  }
}

// The session's repo and start, kept once, so the ledgers can name it.
async function nameSession($, sid) {
  if (sessionNamed || !sid) return
  sessionNamed = true
  await $.store.set('session:' + sid, { repo: git?.repo ?? null, startedAt: startedAt ?? sessionSeenAt })
}

// A model call's tokens and time, kept by session within the day, so sessions do not
// overwrite each other's counts. A resumed session picks up its share where it left it.
async function recordModelUse($, m, usage, ms) {
  if (!m || !usage) return
  modelsSession = addModelUse(modelsSession, m, usage, ms)
  const day = dayKey(Date.now())
  const key = 'models:' + day
  const all = (await $.store.get(key)) ?? {}
  if (modelsDay !== day) {
    modelsDay = day
    modelsMine = (sessionId && all[sessionId]) || {}
  }
  modelsMine = addModelUse(modelsMine, m, usage, ms)
  if (!sessionId) {
    modelsToday = sumModelUse([...Object.values(all), modelsMine])
    return
  }
  const next = { ...all, [sessionId]: modelsMine }
  await $.store.set(key, next)
  await nameSession($, sessionId)
  modelsToday = sumModelUse(Object.values(next))
}

async function modelsOver($, days, now) {
  const tables = []
  for (let i = 0; i < days; i++) tables.push(...Object.values((await $.store.get('models:' + dayKey(now - i * 86400_000))) ?? {}))
  return sumModelUse(tables)
}

// Per day and session, oldest day first: [{ day, id, repo, startedAt, use, cost }].
async function ledgerDays($, days, now) {
  const rows = []
  const metas = {}
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86400_000)
    const models = (await $.store.get('models:' + day)) ?? {}
    const costs = (await $.store.get('costs:' + day)) ?? {}
    for (const sid of new Set([...Object.keys(models), ...Object.keys(costs)])) {
      metas[sid] ??= (await $.store.get('session:' + sid)) ?? {}
      rows.push({ day, id: sid, repo: metas[sid].repo ?? null, startedAt: metas[sid].startedAt ?? null, use: models[sid] ?? {}, cost: costs[sid] ?? 0 })
    }
  }
  return rows
}

// The last days by session, the newest session first: [{ id, repo, startedAt, use, cost }].
async function sessionsOver($, days, now) {
  const by = {}
  for (const r of await ledgerDays($, days, now)) {
    const x = (by[r.id] ??= { id: r.id, repo: r.repo, startedAt: r.startedAt, tables: [], cost: 0 })
    x.tables.push(r.use)
    x.cost += r.cost
  }
  return Object.values(by)
    .map(({ tables, ...x }) => ({ ...x, use: sumModelUse(tables) }))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

// The Costs tab's slower figures: the daily trend and the repos, read from the store.
async function refreshLedger($) {
  const now = Date.now()
  const trend = []
  for (let i = TREND_DAYS - 1; i >= 0; i--) trend.push(Number((await $.store.get('day:' + dayKey(now - i * 86400_000))) ?? 0))
  costTrend = trend
  const by = {}
  for (const x of await sessionsOver($, MODEL_DAYS, now)) {
    const r = (by[x.repo ?? '?'] ??= { repo: x.repo ?? '?', cost: 0, ms: 0, out: 0 })
    r.cost += x.cost
    for (const u of Object.values(x.use)) {
      r.ms += u.ms
      r.out += u.out
    }
  }
  repoUse = Object.values(by).sort((a, b) => b.cost - a.cost || b.ms - a.ms)
}

// /statusband report: one CSV row per day and session.
async function writeReport($, days) {
  const now = Date.now()
  const rows = await ledgerDays($, days, now)
  const csv = toCsv([
    ['day', 'repo', 'session', 'session_start', 'cost_usd', 'model_minutes', 'calls', 'tokens_in', 'tokens_cached', 'tokens_out', 'models'],
    ...rows.map((r) => {
      const u = Object.values(r.use)
      const sum = (k) => u.reduce((n, x) => n + x[k], 0)
      return [r.day, r.repo ?? '', r.id, r.startedAt ? fmtDay(r.startedAt) : '', r.cost.toFixed(2), (sum('ms') / 60_000).toFixed(1), sum('steps'), sum('in'), sum('cached'), sum('out'), Object.keys(r.use).map((m) => prettyModel(m) ?? m).join('; ')]
    }),
  ])
  const path = String((await $.env.get('TMPDIR').catch(() => null)) || '/tmp').replace(/\/+$/, '') + '/statusband-report-' + dayKey(now) + '.csv'
  await $.fs.write(path, csv)
  const by = {}
  for (const r of rows) {
    const x = (by[r.repo ?? '?'] ??= { cost: 0, ms: 0 })
    x.cost += r.cost
    x.ms += Object.values(r.use).reduce((n, u) => n + u.ms, 0)
  }
  const lines = Object.entries(by)
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([repo, x]) => '  ' + repo + ': ' + fmtUsd(x.cost) + ' · ' + fmtDur(x.ms))
  return { path, rows: rows.length, text: lines.join('\n') }
}

async function pruneStore($, now) {
  try {
    for (const k of await $.store.keys()) {
      if (k.startsWith('day:') && now - Date.parse(k.slice(4)) > LEDGER_DAYS * 86400_000) await $.store.delete(k)
      if (k.startsWith('models:') && now - Date.parse(k.slice(7)) > LEDGER_DAYS * 86400_000) await $.store.delete(k)
      if (k.startsWith('costs:') && now - Date.parse(k.slice(6)) > LEDGER_DAYS * 86400_000) await $.store.delete(k)
      if (k.startsWith('session:')) {
        const v = await $.store.get(k)
        if (!v || now - (v.startedAt ?? 0) > LEDGER_DAYS * 86400_000) await $.store.delete(k)
      }
      if (k.startsWith('last:')) {
        const v = await $.store.get(k)
        if (!v || now - (v.ts ?? 0) > 7 * 86400_000) await $.store.delete(k)
      }
    }
  } catch {}
}

function alertOnce($, key, text) {
  if (alerted.has(key)) return
  alerted.add(key)
  $.ui.toast(text, { timeoutMs: 8000 })
}

// Context alerts re-arm once usage drops below the level (after /compact or /clear);
// quota alerts are keyed by their window, so each new window can alert again.
function checkAlerts($) {
  for (const lv of TOAST_LEVELS) {
    if (ctx?.pct == null) continue
    if (ctx.pct >= lv) alertOnce($, 'ctx' + lv, `🧠 Context at ${Math.round(ctx.pct)}%`)
    else alerted.delete('ctx' + lv)
  }
  for (const q of quotas) {
    const win = q.label + '@' + (q.resetsAt ?? '') + ':'
    for (const lv of TOAST_LEVELS) if (q.pct >= lv) alertOnce($, win + lv, `${q.icon} ${q.label} limit at ${Math.round(q.pct)}%`)
    if (q.status === 'out') alertOnce($, win + 'out', `🛑 ${q.label} limit runs out in ~${fmtDur(q.eta)}`)
  }
}

// Accepts $.session.usage() or a session.measure event: both carry context, cost, rateLimits.
async function applyUsage($, u) {
  if (!u) return
  const now = Date.now()
  if (u.context) ctx = { pct: num(u.context.percent), tokens: num(u.context.tokens), window: num(u.context.window) }
  if (ctx && ctx.pct == null && ctx.tokens != null && ctx.window) ctx.pct = (ctx.tokens / ctx.window) * 100
  if (u.cost !== undefined) costUsd = num(u.cost?.usd, u.cost)
  if (u.startedAt) startedAt = toMs(u.startedAt)
  if (Array.isArray(u.rateLimits)) limits = u.rateLimits.map((r) => ({ kind: r.kind, pct: num(r.percentUsed), resetsAt: toMs(r.resetsAt) }))
  try {
    await recordCost($, now)
    await computeQuotas($, now)
  } catch {}
  checkAlerts($)
}

// Before the first turn: the session's model, and the effort the settings give it.
async function readProfile($) {
  try {
    const v = await $.env.get('CLAUDE_PROFILE')
    profile = typeof v === 'string' && v.trim() ? v.trim() : null
  } catch {}
}

async function primeModel($) {
  try {
    if (!model) model = await $.session.model()
  } catch {}
  if (effort) return
  try {
    const s = await $.settings.read()
    const per = s?.modelSettings?.[model]?.effortLevel
    effort = per ?? s?.effortLevel ?? null
  } catch {}
}

async function pullUsage($) {
  try {
    await applyUsage($, await $.session.usage())
  } catch {}
}

const runningAgents = () => [...agents.values()].filter((a) => a.status === 'running')

function pruneAgents() {
  const ended = [...agents.values()].filter((a) => a.status !== 'running').sort((a, b) => b.endedAt - a.endedAt)
  for (const a of ended.slice(AGENTS_KEPT)) agents.delete(a.id)
}

const agentGlyph = (a) => (a.status === 'running' ? ['●', C.teal] : a.status === 'done' ? ['✓', C.green] : a.status === 'failed' ? ['✗', C.red] : ['■', C.gray])

// ------------------------------------------------------------------ render ---

const seg = (t, color, opts = {}) => ({ t, color, ...opts })
const sep = () => seg(' │ ', C.light)
const blank = () => [seg(' ', C.text)]
// A pressable segment; `fit` measures it like text, `draw` makes it a Button.
const btn = (t, key, onPress) => ({ t, key, onPress, color: C.text })

const scriptButtons = ($, sc) => [
  btn('▶ run', 'run:' + sc.name, () => void runScript($, sc).catch(() => {})),
  seg('  ', C.text),
  btn('⧉ copy', 'copy:' + sc.name, (press) => void copyScript($, sc, press?.surface).catch(() => {})),
]

function stateSegs(now) {
  const s = []
  if (profile) s.push(seg('👤 ' + profile, C.orange, { bold: true }), seg(' │ ', C.light))
  s.push(isRunning ? seg('⚡ working', C.green, { bold: true }) : seg('💤 idle', C.gray))
  if (startedAt) s.push(seg('  ⏱ ' + fmtDur(now - startedAt), C.gray, { pri: 3 }))
  return s
}

function modelSegs() {
  const s = [seg('🤖 ' + (prettyModel(model) ?? 'model ?'), C.purple, { bold: true })]
  if (effort) s.push(seg(' · ', C.light), seg('💪 ' + effort, EFFORT_COLOR[effort] ?? C.orange, { bold: true }))
  return s
}

function gitSegs() {
  if (!git) return null
  const s = []
  if (git.branch) {
    s.push(seg('🌿 ' + git.branch, C.magenta))
    if (git.dirty) s.push(seg('  📝 ' + git.dirty, C.amber))
    if (git.ahead) s.push(seg('  ↑' + git.ahead, C.green, { pri: 1 }))
    if (git.behind) s.push(seg('  ↓' + git.behind, C.red, { pri: 1 }))
    if (!git.dirty && !git.ahead && !git.behind) s.push(seg('  ✅ clean', C.green, { pri: 1 }))
  } else s.push(seg('no git', C.gray))
  return s
}

// Pace as where the limit lands at the reset if use keeps this rate: pace 0.2× reads "~20% by reset".
const paceSegs = (q, opts = {}) => {
  const col = level(q.pace, PACE_WARN, PACE_CRIT)
  return [seg('📈 ~' + Math.round(q.pace * 100) + '%', col, { bold: true, ...opts }), seg(' by reset', col, opts)]
}

const quotaStatusSeg = (q, opts = {}) =>
  q.status === 'out'
    ? seg('🛑 out in ~' + fmtDur(q.eta), C.red, { bold: true, ...opts })
    : q.status === 'tight'
      ? seg('⚠️ tight', C.amber, { bold: true, ...opts })
      : q.status === 'ok'
        ? seg('✅ lasts until reset', C.green, { pri: 1, ...opts })
        : null

// Compact: inline pane above the prompt, or the band when the pane is not shown.
function compactLines($, now) {
  const L = []
  const l1 = [...stateSegs(now), sep(), ...modelSegs()]
  const run = runningAgents()
  if (run.length) {
    const tok = run.reduce((n, a) => n + (a.ctxTokens ?? 0), 0)
    l1.push(sep(), seg('👥 ' + run.length + (run.length === 1 ? ' agent' : ' agents'), C.teal, { pri: 2 }))
    if (tok) l1.push(seg(' · ' + fmtTokens(tok) + ' ctx', C.teal, { pri: 1 }))
  }
  L.push(l1)

  const g = gitSegs()
  if (g) L.push([seg('📦 ', C.blue), seg(git.repo ?? '?', C.blue, { bold: true }), sep(), ...g])

  if (ctx && ctx.pct == null) {
    L.push([seg('🧠 ctx  ', C.gray), seg('░'.repeat(10), C.light), seg('    –', C.gray), seg('  –/' + fmtTokens(ctx.window), C.gray, { pri: 1 })])
  }
  if (ctx?.pct != null) {
    const col = level(ctx.pct, CTX_WARN, CTX_CRIT)
    const [f, e] = bar(ctx.pct, 10)
    L.push([
      seg('🧠 ctx  ', C.gray),
      seg(f, col),
      seg(e, C.light),
      seg('  ' + String(Math.round(ctx.pct)).padStart(3) + '%', col, { bold: true }),
      seg('  ' + fmtTokens(ctx.tokens) + '/' + fmtTokens(ctx.window), C.gray, { pri: 1 }),
    ])
  }

  for (const q of quotas) {
    const col = q.status === 'out' ? C.red : level(q.pct, QUOTA_WARN, QUOTA_CRIT)
    const [f, e] = bar(q.pct, 10)
    const row = [
      seg(q.icon + ' ' + q.label.padEnd(5), C.gray),
      seg(f, col),
      seg(e, C.light),
      seg('  ' + String(Math.round(q.pct)).padStart(3) + '%', col, { bold: true }),
    ]
    if (q.resetsAt) row.push(seg('  🔄 ' + fmtClock(q.resetsAt, now), C.gray), seg(' (in ' + fmtDur(q.resetsAt - now) + ')', C.light, { pri: 2 }))
    if (q.pace != null) row.push(seg('  ', C.text, { pri: 3 }), ...paceSegs(q, { pri: 3 }))
    const st = quotaStatusSeg(q)
    if (st) row.push(seg('  ', C.text, { pri: st.pri }), st)
    L.push(row)
  }

  if (costUsd != null) {
    const l = [seg('💰 ', C.green), seg(fmtUsd(costUsd), C.green, { bold: true }), seg(' session', C.gray)]
    if (costToday != null) l.push(seg(' · ', C.light, { pri: 2 }), seg('📆 ' + fmtUsd(costToday), C.green, { bold: true, pri: 2 }), seg(' today', C.gray, { pri: 2 }))
    if (startedAt && now - startedAt > 5 * 60_000) l.push(sep(), seg('🔥 ' + fmtUsd(costUsd / ((now - startedAt) / 3600_000)) + '/h', C.orange, { bold: true, pri: 1 }))
    L.push(l)
  }

  const sc = scripts[0]
  if (sc && (!startedAt || sc.mtimeMs >= startedAt)) {
    L.push([seg('📜 ', C.blue), seg(sc.name, C.blue, { bold: true }), seg('  ', C.text), ...scriptButtons($, sc), seg('  ' + (sc.desc ?? ''), C.gray, { pri: 1 })])
  }
  return L
}

// Docked: a sectioned sidebar.
function sidebarLines($, now, W) {
  const L = []
  const barW = Math.max(8, Math.min(20, W - 8))
  const head = (t, color) => [seg(t, color, { bold: true })]

  L.push(stateSegs(now))
  L.push(modelSegs())
  if (lastTurn) {
    const r = [seg('🧾 last turn ' + fmtDur(lastTurn.durationMs), C.gray)]
    if (lastTurn.costDelta != null) r.push(seg(' · +' + fmtUsd(lastTurn.costDelta), C.green, { pri: 1 }))
    if (lastTurn.agents) r.push(seg(' · ' + lastTurn.agents + ' ag', C.teal, { pri: 2 }))
    if (lastTurn.toolMs >= 1000) r.push(seg(' · 🔧 ' + fmtDur(lastTurn.toolMs), C.gray, { pri: 3 }))
    L.push(r)
  }

  if (git) {
    L.push(blank(), head('📦 ' + (git.repo ?? '?'), C.blue), gitSegs())
  }

  if (ctx && ctx.pct == null) {
    L.push(blank(), head('🧠 Context', C.text))
    L.push([seg('░'.repeat(barW), C.light), seg('  –', C.gray)])
    L.push([seg('window ' + fmtTokens(ctx.window) + ' · after the first reply', C.gray, { pri: 1 })])
  }
  if (ctx?.pct != null) {
    const col = level(ctx.pct, CTX_WARN, CTX_CRIT)
    const [f, e] = bar(ctx.pct, barW)
    L.push(blank(), head('🧠 Context', C.text))
    L.push([seg(f, col), seg(e, C.light), seg('  ' + Math.round(ctx.pct) + '%', col, { bold: true })])
    L.push([seg(fmtTokens(ctx.tokens) + ' / ' + fmtTokens(ctx.window) + ' tokens', C.gray)])
    const left = turnsLeft(ctxHist, ctx.window)
    if (left != null && left < 50) L.push([seg('⏳ ~' + left + (left === 1 ? ' turn' : ' turns') + ' until full', left < 2 ? C.red : left < 5 ? C.amber : C.gray)])
  }

  for (const q of quotas) {
    const col = q.status === 'out' ? C.red : level(q.pct, QUOTA_WARN, QUOTA_CRIT)
    const [f, e] = bar(q.pct, barW)
    L.push(blank(), head(q.icon + ' ' + q.label + ' limit', C.text))
    L.push([seg(f, col), seg(e, C.light), seg('  ' + Math.round(q.pct) + '%', col, { bold: true })])
    if (q.resetsAt) L.push([seg('🔄 ' + fmtClock(q.resetsAt, now), C.gray), seg(' (in ' + fmtDur(q.resetsAt - now) + ')', C.light, { pri: 1 })])
    if (q.pace != null) L.push(paceSegs(q))
    const st = quotaStatusSeg(q, { pri: 0 })
    if (st) L.push([st])
  }

  // The rows are the Agents tab's; here only who is running.
  const run = runningAgents()
  if (run.length) {
    const tok = run.reduce((n, a) => n + (a.ctxTokens ?? 0), 0)
    L.push(blank(), head('👥 Agents', C.teal))
    L.push([seg(run.length + ' running', C.teal, { bold: true }), seg(tok ? ' · ' + fmtTokens(tok) + ' ctx' : '', C.teal, { pri: 1 }), seg('  → Agents tab', C.gray, { pri: 2 })])
  }

  // The details are the Costs tab's; here only the totals.
  if (costUsd != null) {
    L.push(blank(), head('💰 Cost', C.text))
    L.push([
      seg(fmtUsd(costUsd), C.green, { bold: true }),
      seg(' session', C.gray),
      ...(costToday != null ? [seg(' · ' + fmtUsd(costToday) + ' today', C.gray, { pri: 1 })] : []),
      seg('  → Costs tab', C.gray, { pri: 2 }),
    ])
  }
  return L
}

// The Costs tab: cost and its trend, cache share, models, repos, tools.
function costsLines(now, W) {
  const L = []
  const head = (t) => [seg(t, C.text, { bold: true })]
  if (costUsd == null && !Object.keys(modelsSession).length) return [[seg('No cost yet in this session.', C.gray)]]

  if (costUsd != null) {
    L.push(head('💰 Cost'))
    L.push([seg(fmtUsd(costUsd), C.green, { bold: true }), seg(' session', C.gray), ...(costToday != null ? [seg(' · ', C.light), seg(fmtUsd(costToday), C.green, { bold: true }), seg(' today', C.gray)] : [])])
    if (startedAt && now - startedAt > 5 * 60_000) L.push([seg('🔥 ' + fmtUsd(costUsd / ((now - startedAt) / 3600_000)) + '/h', C.orange, { bold: true })])
    // Shown from the first day on; the days with no use count as gaps, not into the average.
    const days = costTrend.filter((v) => v > 0)
    if (days.length) {
      const span = (days.length < TREND_DAYS ? days.length + ' of ' : '') + TREND_DAYS + 'd'
      L.push([seg(sparkline(costTrend), C.green), seg('  avg ' + fmtUsd(days.reduce((a, b) => a + b, 0) / days.length) + '/day', C.gray), seg(' · ' + span, C.light, { pri: 1 })])
    }
  }

  const hit = cacheHit(modelsSession)
  if (hit != null) {
    const col = hit >= CACHE_WARN ? C.green : hit >= CACHE_CRIT ? C.amber : C.red
    L.push([seg('♻️ cache ', C.gray), seg(Math.round(hit) + '%', col, { bold: true }), seg(' of the input · session', C.gray, { pri: 1 })])
  }

  const mine = Object.entries(modelsSession)
  if (mine.length) {
    L.push(blank(), head('🤖 Models · session'))
    for (const [m, r] of mine) L.push(...modelUseLines(m, r))
  }
  const today = Object.entries(modelsToday)
  if (today.length) {
    L.push(blank(), head('📆 Models · today'))
    for (const [m, r] of today) L.push(modelUseRow(m, r))
  }

  if (repoUse.length) {
    L.push(blank(), head('📁 Repos · ' + MODEL_DAYS + ' days'))
    for (const r of repoUse.slice(0, SHOWN_ROWS)) {
      L.push([seg(shorten(r.repo, 16), C.blue, { bold: true }), seg(' · ' + fmtUsd(r.cost), C.green), seg(' · ' + fmtDur(r.ms), C.gray, { pri: 1 }), seg(' · ' + fmtTokens(r.out) + ' out', C.light, { pri: 2 })])
    }
    if (repoUse.length > SHOWN_ROWS) L.push([seg('+' + (repoUse.length - SHOWN_ROWS) + ' more', C.light)])
  }

  const tools = Object.entries(toolUse).sort((a, b) => b[1].ms - a[1].ms)
  if (tools.length) {
    L.push(blank(), head('🔧 Tools · session'))
    for (const [t, r] of tools.slice(0, SHOWN_ROWS)) {
      L.push([seg(shorten(t, 14), C.text), seg(' ' + r.n + '×', C.gray), seg(' · ' + fmtDur(r.ms), C.gray), ...(r.err ? [seg(' · ' + r.err + ' err', C.red, { pri: 1 })] : [])])
    }
  }

  L.push(blank(), [seg('/statusband report → CSV', C.light, { pri: 1 })])
  return L
}

// One model's use on two rows: who and how long, then the tokens.
const modelUseLines = (m, r) => [
  [seg(prettyModel(m) ?? m, C.purple, { bold: true }), seg(' · ' + fmtDur(r.ms), C.gray), seg(' · ' + r.steps + (r.steps === 1 ? ' call' : ' calls'), C.light, { pri: 1 })],
  [seg('  ' + fmtTokens(r.in) + ' in', C.gray), seg(' · ' + fmtTokens(r.out) + ' out', C.gray), seg(' · ' + fmtTokens(r.cached) + ' cached', C.light, { pri: 1 })],
]

const fmtDay = (ts) => {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// The day's totals on one row each.
const modelUseRow = (m, r) => [
  seg(prettyModel(m) ?? m, C.purple, { bold: true }),
  seg(' · ' + fmtTokens(r.out) + ' out', C.gray),
  seg(' · ' + fmtDur(r.ms), C.gray, { pri: 1 }),
  seg(' · ' + fmtTokens(r.in) + ' in', C.light, { pri: 2 }),
]

// /statusband models: a plain-text table.
const modelUseText = (title, t, indent = '  ') => {
  const rows = Object.entries(t)
  if (!rows.length) return title + ': nothing yet.'
  return [title + ':', ...rows.map(([m, r]) => indent + (prettyModel(m) ?? m) + ': ' + fmtTokens(r.in) + ' in · ' + fmtTokens(r.out) + ' out · ' + fmtTokens(r.cached) + ' cached · ' + fmtDur(r.ms) + ' · ' + r.steps + (r.steps === 1 ? ' call' : ' calls'))].join('\n')
}

// The Scripts tab.
function scriptsLines($, W) {
  const L = scripts.length ? [] : [[seg('No scripts from this session yet.', C.gray)]]
  for (const sc of scripts) {
    if (L.length) L.push(blank())
    L.push([seg('📜 ' + shorten(sc.name, W - 3), C.blue, { bold: true })])
    if (sc.desc) L.push([seg('  ' + sc.desc, C.gray)])
    L.push([seg('  ', C.text), ...scriptButtons($, sc)])
  }
  if (scriptsOthers.length) {
    L.push(blank())
    L.push([
      seg(scriptsOthers.length + ' from other sessions  ', C.gray),
      btn('🧹 clean', 'clean', () => void cleanByHand($).catch(() => {})),
    ])
  }
  return L
}

// The Agents tab: the running ones on two rows each, the finished on one, newest first. Both
// groups stay in sight: when rows run short the running ones take one row too, and the oldest
// finished give way to an "older" count before they would fall below the pane's fold.
function agentsLines(now, W, rows) {
  if (!agents.size) return [[seg('No agents in this session yet.', C.gray)]]
  const newest = (a, b) => b.spawnedAt - a.spawnedAt
  const run = [...agents.values()].filter((a) => a.status === 'running').sort(newest)
  const ended = [...agents.values()].filter((a) => a.status !== 'running').sort((a, b) => b.endedAt - a.endedAt)
  const title = (a) => a.desc || a.name
  const toks = (a, lead) => {
    const t = []
    if (a.ctxTokens) t.push(seg(lead + fmtTokens(a.ctxTokens) + ' ctx', C.gray, { pri: 2 }))
    if (a.outTokens) t.push(seg((t.length ? ' · ' : lead) + fmtTokens(a.outTokens) + ' out', C.gray, { pri: 1 }))
    return t
  }
  const L = []
  if (run.length) {
    L.push([seg('● ' + run.length + ' running', C.teal, { bold: true })])
    // Two rows each unless that would push the finished ones out of the pane.
    const tight = rows && 1 + run.length * 2 + (ended.length ? 2 + Math.min(ended.length, 3) : 0) > rows
    for (const a of run) {
      if (tight) {
        L.push([seg(' ● ', C.teal, { bold: true }), seg(shorten(title(a), 18), C.text, { bold: true }), ...toks(a, ' · '), seg(' · ' + fmtDur(now - a.spawnedAt), C.teal, { pri: 3 })])
        continue
      }
      L.push([seg(' ● ', C.teal, { bold: true }), seg(shorten(title(a), W - 3), C.text, { bold: true })])
      const t = toks(a, '   ')
      if (a.steps) t.push(seg(' · ' + a.steps + (a.steps === 1 ? ' step' : ' steps'), C.gray, { pri: 3 }))
      L.push([...(t.length ? t : [seg('   ', C.gray)]), seg((t.length ? ' · ' : '') + fmtDur(now - a.spawnedAt), C.teal)])
    }
  }
  if (ended.length) {
    if (L.length) L.push(blank())
    const room = rows ? Math.max(1, rows - L.length - 1) : ended.length
    const shown = ended.length > room ? ended.slice(0, Math.max(0, room - 1)) : ended
    L.push([seg('✓ ' + ended.length + ' finished', C.gray, { bold: true })])
    for (const a of shown) {
      const [g, gc] = agentGlyph(a)
      L.push([seg(' ' + g + ' ', gc, { bold: true }), seg(shorten(title(a), 18), C.text), ...toks(a, ' · '), seg(' · ' + fmtDur(a.endedAt - a.spawnedAt), C.gray, { pri: 3 })])
    }
    if (shown.length < ended.length) L.push([seg('   +' + (ended.length - shown.length) + ' older', C.light)])
  }
  return L
}

async function cleanByHand($) {
  const n = await cleanScripts($)
  const left = scriptsOthers.length
  $.ui.toast('🧹 ' + (n ? 'removed ' + n + ' script' + (n === 1 ? '' : 's') : 'nothing removed') + (left ? ' · ' + left + ' changed in the last 15 min kept' : ''), { timeoutMs: 5000 })
  $.ui.invalidate('ui.render')
  return n
}

function draw($, e, L, cols) {
  const { Box, Text, Button } = $.ui.resolve(e)
  return Box({
    flexDirection: 'column',
    children: L.map((line, i) =>
      Box({
        key: 'r' + i,
        flexDirection: 'row',
        children: fit(line, cols).map((s, j) =>
          s.onPress
            ? Button({ key: s.key, label: s.t, plain: true, onPress: s.onPress })
            : Text({ key: 'r' + i + 's' + j, color: s.color, bold: !!s.bold, wrap: 'truncate-end', children: [s.t] }),
        ),
      }),
    ),
  })
}

// Opened first, so the status pane opened after it is the tab on show.
async function openScriptsPane($) {
  if (scriptsPaneOpen || scriptsClosedByUser || !scripts.length) return
  try {
    const r = await $.ui.open({ id: SCRIPTS_PANE, title: 'Scripts', columns: PANE_COLUMNS, rows: PANE_ROWS })
    scriptsPaneOpen = r?.isPlaced !== false
  } catch {}
}

async function openAgentsPane($) {
  if (agentsPaneOpen || agentsClosedByUser || !agents.size) return
  try {
    const r = await $.ui.open({ id: AGENTS_PANE, title: 'Agents', columns: PANE_COLUMNS, rows: PANE_ROWS })
    agentsPaneOpen = r?.isPlaced !== false
  } catch {}
}

async function openCostsPane($) {
  if (costsPaneOpen || costsClosedByUser) return
  try {
    const r = await $.ui.open({ id: COSTS_PANE, title: 'Costs', columns: PANE_COLUMNS, rows: PANE_ROWS })
    costsPaneOpen = r?.isPlaced !== false
  } catch {}
}

async function openPane($) {
  await openScriptsPane($)
  await openAgentsPane($)
  await openCostsPane($)
  try {
    paneOpen = await $.ui.open({ id: PANE, title: 'Status', columns: PANE_COLUMNS, rows: PANE_ROWS })
  } catch (err) {
    paneOpen = { isPlaced: false, reason: err?.message ?? String(err) }
    paneFailedAt = Date.now()
  }
  return paneOpen
}

// ---------------------------------------------------------------- register ---

export function register(on) {
  on('session.start', async ($, e, next) => {
    await refreshGit($)
    await pullUsage($)
    await primeModel($)
    await readProfile($)
    await pruneStore($, Date.now())
    try {
      sessionId = await $.session.id()
    } catch {}
    await cleanScripts($, SCRIPTS_KEEP_MS).catch(() => {})
    $.clock.every(GIT_EVERY_MS, async () => {
      await refreshGit($)
      await refreshScripts($)
      if (Date.now() - paneSeenAt < PANE_STALE_MS) await openScriptsPane($)
      $.ui.invalidate('ui.render')
    })
    await refreshLedger($).catch(() => {})
    $.clock.every(TICK_MS, async () => {
      await pullUsage($)
      await refreshLedger($).catch(() => {})
      pruneAgents()
      $.ui.invalidate('ui.render')
    })
    try {
      await $.command.register({ name: 'statusband', description: 'Status sidebar: open or close it, run or copy a script from .scripts/, clean out other sessions\' scripts, list tokens and time by model, or write a cost report (CSV)', argumentHint: '[open|close|run|copy|clean|models|report] [script|days]', immediate: true })
      await $.command.register({ name: 'statusband-debug', description: 'statusband: dump the raw data it reads', immediate: true })
    } catch {}
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      agents.clear()
      lastTurn = null
      turnStart = null
      modelsSession = {}
      modelsDay = null // a new session id gets its own share of the day
      sessionNamed = false
      toolUse = {}
      ctxHist = []
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) return next(e) // a subagent's turn is not the session's
    isRunning = true
    let cost = costUsd
    try {
      cost = num((await $.session.usage())?.cost?.usd) ?? cost
    } catch {}
    turnStart = { at: Date.now(), cost }
    turnToolMs = 0
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const t0 = Date.now()
    if (!e.agentId) {
      lastStepKeys = Object.keys(e)
      if (e.model) model = e.model
      if (e.effort) effort = String(e.effort)
    }
    const result = yield* next(e)
    try {
      await recordModelUse($, e.model ?? (e.agentId ? null : model), result?.usage, Date.now() - t0)
    } catch {} // an observer: the step's result stands
    if (!e.agentId) return result
    const a = agents.get(e.agentId)
    if (a && result?.usage) {
      const u = result.usage
      a.ctxTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      a.outTokens = (a.outTokens ?? 0) + (u.output_tokens ?? 0)
      a.steps = (a.steps ?? 0) + 1
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started?.deny === undefined && started?.agentId) {
      agents.set(started.agentId, {
        id: started.agentId,
        name: String(e.name ?? e.subagentType ?? 'agent').split(':').pop(),
        desc: e.description ? String(e.description) : null,
        status: 'running',
        spawnedAt: Date.now(),
        endedAt: null,
        ctxTokens: 0,
        outTokens: 0,
        steps: 0,
      })
      // The dock is up: the agent gets its tab now rather than at the next open.
      if (Date.now() - paneSeenAt < PANE_STALE_MS) void openAgentsPane($)
      $.ui.invalidate('ui.render')
    }
    return started
  }).catch(($, e, next) => next(e)) // an observer: a throw here must not stop the spawn

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const now = Date.now()
    if (e.agentId) {
      const a = agents.get(e.agentId)
      if (a) {
        a.status = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
        a.endedAt = now
        // A background agent that ends while Claude waits on you would otherwise go unseen.
        if (!isRunning) void Promise.resolve($.ui.notify((a.status === 'done' ? 'Agent finished: ' : 'Agent ' + a.status + ': ') + (a.desc || a.name), { title: git?.repo ?? 'Claude Code' })).catch(() => {})
      }
    } else {
      isRunning = false
      await pullUsage($)
      await refreshGit($)
      await refreshScripts($)
      await refreshLedger($).catch(() => {})
      if (ctx?.tokens != null) ctxHist = ctxHist.length && ctx.tokens < ctxHist[ctxHist.length - 1] ? [ctx.tokens] : [...ctxHist, ctx.tokens].slice(-12)
      const delta = turnStart?.cost != null && costUsd != null ? costUsd - turnStart.cost : null
      lastTurn = {
        durationMs: num(e.durationMs) ?? (turnStart ? now - turnStart.at : null),
        costDelta: delta != null && delta >= 0.005 ? delta : null,
        agents: [...agents.values()].filter((a) => turnStart && a.spawnedAt >= turnStart.at).length,
        toolMs: turnToolMs,
      }
    }
    $.ui.invalidate('ui.render')
    return done
  })

  on('tool.call', async ($, e, next) => {
    const t0 = Date.now()
    const done = await next(e)
    if (done?.deny === undefined && e.tool) {
      const ms = Date.now() - t0
      toolUse = addToolUse(toolUse, String(e.tool), ms, !!done?.isError)
      if (!e.agentId) turnToolMs += ms
    }
    if (SCRIPT_WRITERS.includes(e.tool) && done?.deny === undefined && !done?.isError) {
      try {
        await claimScript($, e.file_path ?? e.notebook_path)
        await refreshScripts($)
        $.ui.invalidate('ui.render')
      } catch {} // an observer: the tool's result stands
    }
    return done
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!r?.sections || e.traits?.includes?.('bare')) return r
    return { ...r, sections: [...r.sections, { id: 'statusband:scripts', text: SCRIPTS_PROMPT, scope: 'session' }] }
  }).catch(($, e, next) => next(e)) // a throw here leaves the prompt as the engine composed it

  on('session.measure', async ($, e, next) => {
    await applyUsage($, e)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      paneSeenAt = 0
      if (e.origin?.kind === 'person') paneClosedByUser = true
      $.ui.invalidate('ui.render')
    }
    if (e.id === SCRIPTS_PANE) {
      scriptsPaneOpen = false
      if (e.origin?.kind === 'person') scriptsClosedByUser = true
    }
    if (e.id === AGENTS_PANE) {
      agentsPaneOpen = false
      if (e.origin?.kind === 'person') agentsClosedByUser = true
    }
    if (e.id === COSTS_PANE) {
      costsPaneOpen = false
      if (e.origin?.kind === 'person') costsClosedByUser = true
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // an observer: a throw here must not stop the close

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = Date.now()
    paneSeenAt = now
    panePlacement = e.props?.placement ?? null
    const W = Math.max(24, (e.props?.bodyColumns ?? PANE_COLUMNS) - 1)
    const L = e.props?.placement === 'dock' ? sidebarLines($, now, W) : compactLines($, now)
    return draw($, e, L, W)
  })

  on('ui.render', { component: 'Pane', requestId: SCRIPTS_PANE }, async ($, e) => {
    paneSeenAt = Date.now() // the dock is on screen with Scripts as the tab on show
    const W = Math.max(24, (e.props?.bodyColumns ?? PANE_COLUMNS) - 1)
    return draw($, e, scriptsLines($, W), W)
  })

  on('ui.render', { component: 'Pane', requestId: AGENTS_PANE }, async ($, e) => {
    const now = Date.now()
    paneSeenAt = now // the dock is on screen with Agents as the tab on show
    const W = Math.max(24, (e.props?.bodyColumns ?? PANE_COLUMNS) - 1)
    return draw($, e, agentsLines(now, W, e.props?.scroll?.bodyRows), W)
  })

  on('ui.render', { component: 'Pane', requestId: COSTS_PANE }, async ($, e) => {
    const now = Date.now()
    paneSeenAt = now // the dock is on screen with Costs as the tab on show
    const W = Math.max(24, (e.props?.bodyColumns ?? PANE_COLUMNS) - 1)
    return draw($, e, costsLines(now, W), W)
  })

  // Under the prompt: the compact view while neither dock tab is on screen. The pane is opened only
  // where the surface docks panes (fullscreen terminal, Desktop app); the classic renderer would
  // seat it above the prompt, so there the compact view under the prompt is all there is.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const now = Date.now()
    // A narrow terminal is no failure: the pane waits and seats itself once the terminal widens.
    // Only an open that threw is tried again.
    const retry = paneFailedAt > 0 && now - paneFailedAt > PANE_RETRY_MS
    if (e.viewport?.isFullscreen === true && (!paneRequested || retry) && !paneClosedByUser) {
      paneRequested = true
      paneFailedAt = 0
      void openPane($)
    }
    const hint = await next(e)
    if (now - paneSeenAt < PANE_STALE_MS) return hint
    const cols = Math.max(24, (e.viewport?.columns ?? 100) - 2)
    const mine = draw($, e, compactLines($, now), cols)
    const { Box } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: hint ? [hint, mine] : [mine] })
  })

  on('command.run', { command: 'statusband' }, async ($, e) => {
    const [verb = 'open', ...rest] = (e.args ?? '').trim().split(/\s+/).filter(Boolean)
    if (verb === 'clean') {
      const n = await cleanScripts($)
      const left = scriptsOthers.length
      return { text: (n ? 'Removed ' + n + ' script' + (n === 1 ? '' : 's') + ' of other sessions from ' + SCRIPTS_DIR + '/.' : 'No scripts of other sessions to remove.') + (left ? ' Kept ' + left + ' changed in the last 15 minutes.' : '') }
    }
    if (verb === 'report') {
      const days = Math.min(LEDGER_DAYS, Math.max(1, parseInt(rest[0], 10) || REPORT_DAYS))
      const r = await writeReport($, days)
      return { text: (r.rows ? 'Last ' + days + ' days by repo:\n' + r.text + '\n\n' : 'Nothing recorded in the last ' + days + ' days.\n') + 'CSV (one row per day and session): ' + r.path }
    }
    if (verb === 'models') {
      const now = Date.now()
      const sessions = await sessionsOver($, MODEL_DAYS, now)
      const shown = sessions.slice(0, SESSIONS_SHOWN)
      const bySession = shown.map((x) =>
        modelUseText('  ' + (x.id === sessionId ? '▶ ' : '') + (x.repo ?? '?') + ' · ' + (x.startedAt ? fmtDay(x.startedAt) : '?') + ' · ' + x.id.slice(0, 8), x.use, '    '),
      )
      if (sessions.length > shown.length) bySession.push('  +' + (sessions.length - shown.length) + ' older')
      return {
        text: [
          modelUseText('This session', modelsSession),
          modelUseText('Today', await modelsOver($, 1, now)),
          modelUseText('Last ' + MODEL_DAYS + ' days', await modelsOver($, MODEL_DAYS, now)),
          'By session, last ' + MODEL_DAYS + ' days:\n' + (bySession.join('\n') || '  nothing yet.'),
        ].join('\n\n'),
      }
    }
    if (verb === 'run' || verb === 'copy') {
      await refreshScripts($)
      // An older session's script is reachable by its name, not as the newest.
      const want = rest.join(' ')
      const sc = pickScript(scripts, want) ?? (want ? pickScript(scriptsOthers, want) : null)
      if (!sc) return { text: scripts.length || scriptsOthers.length ? 'No script by that name in ' + SCRIPTS_DIR + '/.' : 'No scripts in ' + SCRIPTS_DIR + '/ yet.' }
      if (verb === 'copy') {
        await copyScript($, sc)
        return { text: 'Copied ' + SCRIPTS_DIR + '/' + sc.name + '.' }
      }
      // After the command's own line has left the prompt box.
      $.clock.after(100, () => void runScript($, sc).catch(() => {}))
      return { text: 'Enter runs it: ' + runLine(scriptsDir, sc.name) }
    }
    paneRequested = true
    if (verb !== 'close' && e.presentation?.isFullscreen === false) {
      return { text: 'Classic renderer: the status is under the prompt. Run /tui fullscreen for the sidebar.' }
    }
    if (verb === 'close') {
      paneClosedByUser = true
      scriptsClosedByUser = true
      agentsClosedByUser = true
      costsClosedByUser = true
      await $.ui.close({ id: SCRIPTS_PANE }).catch(() => {})
      await $.ui.close({ id: AGENTS_PANE }).catch(() => {})
      await $.ui.close({ id: COSTS_PANE }).catch(() => {})
      await $.ui.close({ id: PANE })
      return { text: 'statusband closed. The compact view stays under the prompt.' }
    }
    paneClosedByUser = false
    scriptsClosedByUser = false
    agentsClosedByUser = false
    costsClosedByUser = false
    await refreshScripts($)
    const r = await openPane($)
    return { text: r?.isPlaced ? 'statusband opened.' : 'statusband is not shown yet: ' + (r?.reason ?? 'unknown') }
  })

  on('command.run', { command: 'statusband-debug' }, async ($) => {
    const dump = {}
    const grab = async (k, f) => {
      try {
        dump[k] = await f()
      } catch (err) {
        dump[k] = 'ERROR: ' + (err?.message ?? String(err))
      }
    }
    await grab('usage', () => $.session.usage())
    await grab('model', () => $.session.model())
    await grab('version', () => $.session.version())
    await grab('panes', () => $.ui.panes())
    dump.turnStepKeys = lastStepKeys
    dump.paneOpen = paneOpen
    dump.panePlacement = panePlacement
    dump.derived = { scripts, profile, git, ctx, costUsd, costToday, costTrend, repoUse, toolUse, ctxHist, modelsSession, modelsToday, limits, quotas, model, effort, isRunning, lastTurn, agents: [...agents.values()] }
    const json = JSON.stringify(dump, null, 2)
    let saved = ''
    try {
      // The temp folder, not the working directory, where a commit could pick it up.
      const path = String((await $.env.get('TMPDIR').catch(() => null)) || '/tmp').replace(/\/+$/, '') + '/statusband-debug.json'
      await $.fs.write(path, json)
      saved = 'Saved to ' + path + '\n'
    } catch {}
    return { text: saved + '```json\n' + json.slice(0, 9000) + '\n```' }
  })
}

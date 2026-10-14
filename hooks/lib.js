// statusband: pure helpers (formatting, widths, plan-limit math), kept apart so tests can reach them.

const SAMPLE_GAP_MS = 2 * 60_000
const RECENT_WINDOW_MS = 30 * 60_000

export const num = (...vals) => {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}

export const fmtTokens = (n) => {
  if (n == null) return '?'
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'K'
  return String(Math.round(n))
}

export const fmtDur = (ms) => {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '?'
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d > 0) return d + 'd' + (h ? h + 'h' : '')
  if (h > 0) return h + 'h' + String(mm).padStart(2, '0') + 'm'
  return mm + 'm' + (m < 10 ? String(s % 60).padStart(2, '0') + 's' : '')
}

export const fmtUsd = (n) => (n == null ? '$-' : '$' + n.toFixed(2))

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const fmtClock = (ts, now) => {
  const d = new Date(ts)
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  return ts - now > 20 * 3600_000 ? DAYS[d.getDay()] + ' ' + hm : hm
}

export const dayKey = (ts) => {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

export const toMs = (v) => {
  if (v == null) return null
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

export const bar = (pct, width) => {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return ['█'.repeat(filled), '░'.repeat(width - filled)]
}

export const shorten = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s)

export const prettyModel = (id) => {
  if (!id || typeof id !== 'string') return null
  const big = /\[1m\]|-1m\b/i.test(id) ? ' 1M' : ''
  const x = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?!\d)/i.exec(id)
  if (x) return x[1][0].toUpperCase() + x[1].slice(1).toLowerCase() + ' ' + x[2] + (x[3] ? '.' + x[3] : '') + big
  return shorten(id, 22)
}

// Width of a string in terminal cells: emoji take two, whether emoji by default or made so by VS16.
export const cells = (s) => {
  const chars = [...s]
  let w = 0
  chars.forEach((ch, i) => {
    if (ch === '\uFE0F') return
    w += /\p{Emoji_Presentation}/u.test(ch) || chars[i + 1] === '\uFE0F' ? 2 : 1
  })
  return w
}

export const limitShape = (kind) => {
  const k = String(kind ?? '').toLowerCase()
  const label = k.replace(/five[_ -]?hours?/, '5h').replace(/seven[_ -]?days?/, '7d').replace(/[_-]+/g, ' ').trim()
  if (/^5h/.test(label)) return { label, windowMs: 5 * 3600_000, recent: true, icon: '⏳' }
  if (/^7d/.test(label)) return { label, windowMs: 7 * 86400_000, recent: false, icon: '📅' }
  return { label: label || '?', windowMs: null, recent: false, icon: '📊' }
}

// Plan-limit samples: [ts, pct] pairs, one per change or per SAMPLE_GAP_MS, kept for 8 days.
export const addSample = (samples, pct, now) => {
  let s = Array.isArray(samples) ? [...samples] : []
  const last = s[s.length - 1]
  if (!last || now - last[0] >= SAMPLE_GAP_MS || last[1] !== pct) s.push([now, pct])
  return s.filter(([t]) => now - t < 8 * 86400_000).slice(-500)
}

// One limit row: pace against the window, and whether it lasts until the reset.
export const quotaFor = (l, samples, now) => {
  const shape = limitShape(l.kind)
  const q = { ...shape, pct: l.pct, resetsAt: l.resetsAt, pace: null, status: null, eta: null }
  if (!l.resetsAt || !shape.windowMs) return q
  const start = l.resetsAt - shape.windowMs
  const elapsed = now - start
  if (elapsed > shape.windowMs * 0.02) q.pace = l.pct / 100 / (elapsed / shape.windowMs)
  // Percent per ms: recent samples for the 5h window, the window average otherwise.
  let rate = elapsed > 0 ? l.pct / elapsed : null
  if (shape.recent) {
    const win = samples.filter(([t, p]) => t >= start && now - t <= RECENT_WINDOW_MS && p <= l.pct)
    if (win.length >= 2 && win[win.length - 1][0] - win[0][0] >= 10 * 60_000) {
      rate = (win[win.length - 1][1] - win[0][1]) / (win[win.length - 1][0] - win[0][0])
    }
  }
  if (rate != null && rate > 0) {
    const projected = l.pct + rate * (l.resetsAt - now)
    q.status = projected >= 100 ? 'out' : projected >= 90 ? 'tight' : 'ok'
    q.eta = (100 - l.pct) / rate
  } else q.status = l.pct >= 100 ? 'out' : 'ok'
  return q
}

// Drop the highest-pri segments until the line fits.
export function fit(line, cols) {
  const segs = line.filter((s) => s && s.t)
  const width = () => segs.reduce((w, s) => w + cells(s.t), 0)
  while (width() > cols) {
    const maxPri = Math.max(0, ...segs.map((s) => s.pri ?? 0))
    if (maxPri === 0) break
    segs.splice(segs.findLastIndex((s) => (s.pri ?? 0) === maxPri), 1)
    while (segs.length && (segs[segs.length - 1].t === ' │ ' || segs[segs.length - 1].t === '  ')) segs.pop()
  }
  return segs
}

// Scripts written for the person: the first comment line under the shebang says what one does.
export const scriptDesc = (text) => {
  for (const line of String(text ?? '').split('\n').slice(0, 5)) {
    if (line.startsWith('#!')) continue
    const m = /^\s*(?:#|\/\/)\s*(.+?)\s*$/.exec(line)
    if (m) return m[1]
  }
  return null
}

const RUNNERS = { sh: 'bash', bash: 'bash', zsh: 'zsh', py: 'python3', js: 'node', mjs: 'node' }

// The `!` line that runs a script from the prompt, the path quoted when it needs it.
export const runLine = (dir, name) => {
  const path = dir + '/' + name
  const quoted = /^[\w./-]+$/.test(path) ? path : "'" + path.replace(/'/g, `'\\''`) + "'"
  const ext = /\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase()
  return '! ' + (RUNNERS[ext] ?? 'bash') + ' ' + quoted
}

// A script by name: exact, else the newest whose name starts with it; none given, the newest.
export const pickScript = (list, name) => {
  const want = String(name ?? '').trim()
  if (!want) return list[0] ?? null
  return list.find((s) => s.name === want) ?? list.find((s) => s.name.startsWith(want)) ?? null
}

// The script a path names when it sits directly in dir: its file name, else null.
export const scriptName = (dir, path) => {
  const p = String(path ?? '')
  if (!dir || !p.startsWith(dir + '/')) return null
  const name = p.slice(dir.length + 1)
  return name && !name.includes('/') && !name.startsWith('.') ? name : null
}

// Who a file belongs to. A claim is the session id when the session only saw the file change, or
// { session, wrote: true } when Claude wrote it with a file tool there; only those may be deleted.
export const ownerOf = (claim) => (typeof claim === 'string' ? claim : (claim?.session ?? null))

// Splits the folder's files between this session and the rest. A file no session claims is this
// session's when it changed after the session started (written by a shell, say), else an orphan:
// the person's own, or older than any claim, and never deleted.
export const ownScripts = (files, owners, session, since) => {
  const mine = []
  const others = []
  const orphans = []
  const claims = {}
  for (const f of files) {
    let o = ownerOf(owners[f.name])
    if (!o && since != null && f.mtimeMs >= since) o = claims[f.name] = session
    if (o === session) mine.push(f)
    else if (o) others.push({ ...f, written: owners[f.name]?.wrote === true })
    else orphans.push(f)
  }
  return { mine, others, orphans, claims }
}

// Other sessions' scripts the cleaner may delete: written by Claude, untouched for graceMs (a
// session running beside this one may still use a newer one), and with maxAgeMs only older ones.
export const staleScripts = (others, now, graceMs, maxAgeMs) =>
  others.filter((f) => f.written && now - f.mtimeMs >= (maxAgeMs ?? graceMs)).map((f) => f.name)

// Per-model use: { [model]: { in, cached, out, ms, steps } }. `in` is the input sent fresh
// (cache writes included); `cached` the input read back from the cache.
export const addModelUse = (table, model, u, ms) => {
  const r = table[model] ?? { in: 0, cached: 0, out: 0, ms: 0, steps: 0 }
  return {
    ...table,
    [model]: {
      in: r.in + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      cached: r.cached + (u.cache_read_input_tokens ?? 0),
      out: r.out + (u.output_tokens ?? 0),
      ms: r.ms + Math.max(0, ms ?? 0),
      steps: r.steps + 1,
    },
  }
}

// Adds up tables (one per session, or one per day), the busiest model first.
export const sumModelUse = (tables) => {
  const out = {}
  for (const t of tables) {
    for (const [m, r] of Object.entries(t ?? {})) {
      const o = out[m] ?? { in: 0, cached: 0, out: 0, ms: 0, steps: 0 }
      out[m] = { in: o.in + r.in, cached: o.cached + r.cached, out: o.out + r.out, ms: o.ms + r.ms, steps: o.steps + r.steps }
    }
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].out - a[1].out))
}

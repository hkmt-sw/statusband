import { test, expect, mock } from 'claude-code/testing'

const now = Date.now()
const USAGE = {
  startedAt: now - 42 * 60_000,
  context: { tokens: 152_000, window: 200_000, percent: 76 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 83, resetsAt: new Date(now + 112 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: 42, resetsAt: new Date(now + 2.6 * 86_400_000).toISOString() },
  ],
  cost: { usd: 3.21 },
}

async function setup($: any, on: any, toast?: (...a: any[]) => Promise<any>, before?: (on: any) => void, opts: { removed?: string[][]; owners?: Record<string, unknown>; usage?: () => unknown } = {}) {
  mock.clock(on, { now })
  if (!opts.owners) mock.store(on)
  else {
    // A store that already holds another session's claims.
    const kv = new Map<string, unknown>([['scripts:/work/demo/.scripts', opts.owners]])
    on('store.get', async (_$: any, e: any) => ({ value: kv.get(e.key) }) as any)
    on('store.set', async (_$: any, e: any) => (kv.set(e.key, e.value), { value: undefined }) as any)
  }
  const answer = (value: unknown) => async () => ({ value }) as any
  on('session.usage', async () => ({ value: opts.usage ? opts.usage() : USAGE }) as any)
  on('session.id', answer('s1'))
  on('session.cwd', answer('/work/demo'))
  on('process.run', async (_$: any, e: any) => {
    if (e.argv[0] !== 'rm' || !opts.removed) return { value: { exitCode: 1, stdout: '', stderr: '' } } as any
    opts.removed.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as any
  })
  on('ui.toast', toast ?? answer(undefined))
  on('session.model', answer('claude-opus-5-5'))
  on('env.get', answer('work'))
  on('settings.read', answer({ effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } }))
  before?.(on)
  on('session.start', async (_$: any, e: any) => e)
  on('session.measure', async (_$: any, e: any) => e)
  // Stands for the engine's own hint line beneath the plugin.
  on('ui.render', { component: 'PromptHint' }, async ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)
    return Text({ children: [e.props.hint] })
  })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  await $.session.measure({ ...USAGE, changed: ['context'] })
}

const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' } } as const

test('compact view draws under the prompt on terminal and desktop', async ($, on) => {
  await setup($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'statusband', surface, ...HINT, viewport: { columns: 140, rows: 40, isFullscreen: false } } as any)
    expect(await ui.find({ type: 'Text', text: /esc to interrupt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$3\.21/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /medium/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /work/ })).toBeDefined()
    await ui.unmount()
  }
})

test('docked pane draws the sidebar', async ($, on) => {
  await setup($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'statusband', surface, component: 'Pane', requestId: 'statusband',
      props: { title: 'Status', isFocused: false, bodyColumns: 44, placement: 'dock' },
    } as any)
    expect(await ui.find({ type: 'Text', text: /Context/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /7d limit/ })).toBeDefined()
    // 5h: 83% used with 188 of 300 minutes gone heads for ~132% at the reset.
    expect(await ui.find({ type: 'Text', text: /~132%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pace/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('context toast fires again after usage drops below the level', async ($, on) => {
  const toasts: string[] = []
  await setup($, on, async (_$: any, e: any) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined } as any
  })
  const ctxToasts = () => toasts.filter((t) => t.includes('Context')).length
  const measure = (percent: number) => $.session.measure({ ...USAGE, context: { ...USAGE.context, percent }, changed: ['context'] })
  await measure(85)
  await measure(86)
  expect(ctxToasts()).toBe(1)
  await measure(20) // after /compact
  await measure(85)
  expect(ctxToasts()).toBe(2)
})

// A .scripts folder with two scripts, the newer written during the session. old.py is another
// session's, written by Claude there (OLD_PY_OWNER), unless a test leaves it unclaimed.
const SCRIPTS: Record<string, { text: string; mtimeMs: number }> = {
  'deploy.sh': { text: '#!/bin/bash\n# Deploy the demo to staging\necho deploy\n', mtimeMs: now - 60_000 },
  'old.py': { text: '# Old helper\nprint(1)\n', mtimeMs: now - 3 * 86_400_000 },
}

const OLD_PY_OWNER = { owners: { 'old.py': { session: 'other-session', wrote: true } } }

function scriptFs(log: { fills: string[]; copies: string[]; writes: string[] }, isLink = false) {
  return (on: any) => {
    const answer = (f: (e: any) => unknown) => async (_$: any, e: any) => ({ value: f(e) }) as any
    on('fs.stat', answer(() => ({ kind: 'dir', size: 0, mtimeMs: now, isLink })))
    on('fs.exists', answer((e) => ['/work/demo/.scripts', '/work/demo/.scripts/deploy.sh', '/work/demo/.scripts/old.py'].includes(e.path)))
    on('fs.list', answer(() => [
      ...Object.entries(SCRIPTS).map(([name, f]) => ({ name, kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })),
      { name: '.gitignore', kind: 'file', size: 2, mtimeMs: now, isLink: false },
    ]))
    on('fs.read', answer((e) => SCRIPTS[String(e.path).split('/').pop()!]?.text ?? ''))
    on('fs.write', answer((e) => void log.writes.push(e.path)))
    on('prompt.fill', async (_$: any, e: any) => (log.fills.push(e.text), { isFilled: true }) as any)
    on('ui.copy', answer((e) => (log.copies.push(e.text), { isCopied: true })))
  }
}

test('the Scripts tab lists scripts; run fills the prompt, copy puts the file on the clipboard', async ($, on) => {
  const log = { fills: [] as string[], copies: [] as string[], writes: [] as string[] }
  await setup($, on, undefined, scriptFs(log), OLD_PY_OWNER)
  expect(log.writes).toContain('/work/demo/.scripts/.gitignore')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'statusband', surface, component: 'Pane', requestId: 'statusband-scripts',
      props: { title: 'Scripts', isFocused: false, bodyColumns: 44, placement: 'dock' },
    } as any)
    expect(await ui.find({ type: 'Text', text: /deploy\.sh/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Deploy the demo to staging/ })).toBeDefined()
    await ui.press({ key: 'run:deploy.sh' })
    await ui.press({ key: 'copy:deploy.sh' })
    await ui.unmount()
  }
  expect(log.fills).toEqual(['! bash /work/demo/.scripts/deploy.sh', '! bash /work/demo/.scripts/deploy.sh'])
  expect(log.copies).toEqual([SCRIPTS['deploy.sh'].text, SCRIPTS['deploy.sh'].text])
})

test('the status pane leaves scripts to their tab; /statusband opens both, status last', async ($, on) => {
  const log = { fills: [] as string[], copies: [] as string[], writes: [] as string[] }
  const opened: string[] = []
  await setup($, on, undefined, (on) => {
    scriptFs(log)(on)
    on('ui.open', async (_$: any, e: any) => (opened.push(e.id), { value: { isPlaced: true } }) as any)
  })
  const ui = await $.ui.mount({
    plugin: 'statusband', surface: 'terminal', component: 'Pane', requestId: 'statusband',
    props: { title: 'Status', isFocused: false, bodyColumns: 44, placement: 'dock' },
  } as any)
  expect(await ui.find({ type: 'Text', text: /deploy\.sh/ })).toBeUndefined()
  await ui.unmount()
  await $.command.run({ command: 'statusband', args: '' } as any)
  expect(opened).toEqual(['statusband-scripts', 'statusband-agents', 'statusband-costs', 'statusband'])
})

test('compact view offers the newest script of the session', async ($, on) => {
  const log = { fills: [] as string[], copies: [] as string[], writes: [] as string[] }
  await setup($, on, undefined, scriptFs(log))
  const ui = await $.ui.mount({ plugin: 'statusband', surface: 'terminal', ...HINT, viewport: { columns: 140, rows: 40, isFullscreen: false } } as any)
  expect(await ui.find({ type: 'Text', text: /deploy\.sh/ })).toBeDefined()
  await ui.press({ key: 'copy:deploy.sh' })
  expect(log.copies).toEqual([SCRIPTS['deploy.sh'].text])
  await ui.unmount()
})

test('/statusband copy and run pick a script by name', async ($, on) => {
  const log = { fills: [] as string[], copies: [] as string[], writes: [] as string[] }
  await setup($, on, undefined, scriptFs(log), OLD_PY_OWNER)
  const copied = await $.command.run({ command: 'statusband', args: 'copy old' } as any)
  expect(JSON.stringify(copied)).toContain('old.py')
  expect(log.copies).toEqual([SCRIPTS['old.py'].text])
  const ran = await $.command.run({ command: 'statusband', args: 'run' } as any)
  expect(JSON.stringify(ran)).toContain('! bash /work/demo/.scripts/deploy.sh')
  const missing = await $.command.run({ command: 'statusband', args: 'run nope' } as any)
  expect(JSON.stringify(missing)).toContain('No script by that name')
})

test('the system prompt asks for scripts as files', async ($, on) => {
  await setup($, on, undefined, (on) =>
    on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }) as any),
  )
  const r: any = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  const mine = r.sections.find((x: any) => x.id === 'statusband:scripts')
  expect(mine?.scope).toBe('session')
  expect(mine?.text).toContain('.scripts/')
})

test('no compact view under the prompt while the Scripts tab is on show', async ($, on) => {
  const log = { fills: [] as string[], copies: [] as string[], writes: [] as string[] }
  await setup($, on, undefined, scriptFs(log))
  const pane = await $.ui.mount({
    plugin: 'statusband', surface: 'terminal', component: 'Pane', requestId: 'statusband-scripts',
    props: { title: 'Scripts', isFocused: false, bodyColumns: 44, placement: 'dock' },
  } as any)
  await pane.unmount()
  const ui = await $.ui.mount({ plugin: 'statusband', surface: 'terminal', ...HINT, viewport: { columns: 140, rows: 40, isFullscreen: true } } as any)
  expect(await ui.find({ type: 'Text', text: /esc to interrupt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})

const SCRIPTS_TAB = {
  plugin: 'statusband', surface: 'terminal', component: 'Pane', requestId: 'statusband-scripts',
  props: { title: 'Scripts', isFocused: false, bodyColumns: 44, placement: 'dock' },
} as const

test('the Scripts tab shows this session\'s scripts; other sessions\' only as a count to clean', async ($, on) => {
  const log = { fills: [] as string[], copies: [] as string[], writes: [] as string[] }
  const removed: string[][] = []
  await setup($, on, undefined, scriptFs(log), { removed, ...OLD_PY_OWNER })
  expect(removed).toEqual([]) // old.py is 3 days old: the start-up cleaner keeps a week
  const ui = await $.ui.mount(SCRIPTS_TAB as any)
  expect(await ui.find({ type: 'Text', text: /deploy\.sh/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /old\.py/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1 from other sessions/ })).toBeDefined()
  await ui.press({ key: 'clean' })
  await ui.unmount()
  expect(removed).toEqual([['rm', '-f', '--', '/work/demo/.scripts/old.py']])
  // The fixture folder still lists old.py, so a second clean removes it again.
  const r = await $.command.run({ command: 'statusband', args: 'clean' } as any)
  expect(JSON.stringify(r)).toContain('Removed 1 script of other sessions')
})

test('a script another session wrote stays out of this session\'s tab', async ($, on) => {
  const log = { fills: [] as string[], copies: [] as string[], writes: [] as string[] }
  await setup($, on, undefined, scriptFs(log), { owners: { 'deploy.sh': 'other-session', ...OLD_PY_OWNER.owners } })
  const ui = await $.ui.mount(SCRIPTS_TAB as any)
  expect(await ui.find({ type: 'Text', text: /No scripts from this session yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 from other sessions/ })).toBeDefined()
  await ui.unmount()
})

// One agent that ran a step and finished, one still running.
async function twoAgents($: any) {
  await $.agent.spawn({ prompt: 'p', description: 'Audit the hooks', subagentType: 'general-purpose' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, agentId: 'a1', model: 'claude-opus-5-5', messageCount: 1 } as any)) void _
  await $.turn.complete({ turnId: 't1', agentId: 'a1', reason: 'answer', answer: 'ok', durationMs: 1000 } as any)
  await $.agent.spawn({ prompt: 'p', description: 'Scan the docs', subagentType: 'Explore' })
}

const agentBottoms = (opened?: string[]) => (on: any) => {
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: 'a' + ++n }) as any)
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage: { input_tokens: 1000, cache_read_input_tokens: 127_000, output_tokens: 39_000 } } as any
  })
  on('turn.complete', async () => ({ text: 'ok' }) as any)
  if (opened) on('ui.open', async (_$: any, e: any) => (opened.push(e.id), { value: { isPlaced: true } }) as any)
}

const COSTS_TAB = {
  plugin: 'statusband', surface: 'terminal', component: 'Pane', requestId: 'statusband-costs',
  props: { title: 'Costs', isFocused: false, bodyColumns: 44, placement: 'dock' },
} as const

const AGENTS_TAB = {
  plugin: 'statusband', surface: 'terminal', component: 'Pane', requestId: 'statusband-agents',
  props: { title: 'Activity', isFocused: false, bodyColumns: 44, placement: 'dock' },
} as const

test('the Activity tab keeps a finished agent\'s tokens; the status pane only counts who runs', async ($, on) => {
  await setup($, on, undefined, agentBottoms())
  await twoAgents($)
  const tab = await $.ui.mount(AGENTS_TAB as any)
  expect(await tab.find({ type: 'Text', text: /Audit the hooks/ })).toBeDefined()
  expect(await tab.find({ type: 'Text', text: /128K ctx/ })).toBeDefined()
  expect(await tab.find({ type: 'Text', text: /39K out/ })).toBeDefined()
  expect(await tab.find({ type: 'Text', text: /Scan the docs/ })).toBeDefined()
  await tab.unmount()
  const pane = await $.ui.mount({
    plugin: 'statusband', surface: 'terminal', component: 'Pane', requestId: 'statusband',
    props: { title: 'Status', isFocused: false, bodyColumns: 44, placement: 'dock' },
  } as any)
  expect(await pane.find({ type: 'Text', text: /1 running/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Audit the hooks/ })).toBeUndefined()
  await pane.unmount()
})

test('the Activity tab keeps finished agents in sight when the running ones fill it', async ($, on) => {
  await setup($, on, undefined, agentBottoms())
  await twoAgents($)
  for (let i = 0; i < 6; i++) await $.agent.spawn({ prompt: 'p', description: 'Busy ' + i, subagentType: 'Explore' })
  const tab = await $.ui.mount({ ...AGENTS_TAB, props: { ...AGENTS_TAB.props, scroll: { bodyRows: 12 } } } as any)
  expect(await tab.find({ type: 'Text', text: /7 running/ })).toBeDefined()
  expect(await tab.find({ type: 'Text', text: /1 finished/ })).toBeDefined()
  expect(await tab.find({ type: 'Text', text: /Audit the hooks/ })).toBeDefined()
  expect(await tab.findAll({ type: 'Box' }).then((b: any[]) => b.length)).toBeLessThanOrEqual(13) // the rows and the column holding them
  await tab.unmount()
})

test('the tabs open together in a fixed order, status last, and keep it when one comes back', async ($, on) => {
  const opened: string[] = []
  const closed: string[] = []
  let refuse = 'statusband-agents'
  await setup($, on, undefined, (on: any) => {
    agentBottoms()(on)
    on('ui.open', async (_$: any, e: any) => (opened.push(e.id), { value: { isPlaced: e.id !== refuse } }) as any)
    on('ui.close', async (_$: any, e: any) => (closed.push(e.id), { value: undefined }) as any)
  })
  await $.command.run({ command: 'statusband', args: '' } as any)
  expect(opened).toEqual(['statusband-scripts', 'statusband-agents', 'statusband-costs', 'statusband'])
  // An agent no longer opens a tab of its own at the end of the row.
  await twoAgents($)
  expect(opened.length).toBe(4)
  // Activity did not take its place: asked again, the tabs after it reopen behind it.
  refuse = ''
  opened.length = 0
  await $.command.run({ command: 'statusband', args: '' } as any)
  expect(closed).toEqual(['statusband-costs', 'statusband'])
  expect(opened).toEqual(['statusband-agents', 'statusband-costs', 'statusband'])
  // All in place: a further open only reaches the status pane.
  opened.length = 0
  await $.command.run({ command: 'statusband', args: '' } as any)
  expect(opened).toEqual(['statusband'])
})

test('files no session claims are the person\'s own: never deleted, no .gitignore written', async ($, on) => {
  const log = { fills: [] as string[], copies: [] as string[], writes: [] as string[] }
  const removed: string[][] = []
  await setup($, on, undefined, scriptFs(log), { removed })
  const r = await $.command.run({ command: 'statusband', args: 'clean' } as any)
  expect(JSON.stringify(r)).toContain('No scripts of other sessions to remove')
  expect(removed).toEqual([])
  expect(log.writes).not.toContain('/work/demo/.scripts/.gitignore')
})

test('a .scripts that is a link is left alone', async ($, on) => {
  const log = { fills: [] as string[], copies: [] as string[], writes: [] as string[] }
  const removed: string[][] = []
  await setup($, on, undefined, scriptFs(log, true), { removed, ...OLD_PY_OWNER })
  await $.command.run({ command: 'statusband', args: 'clean' } as any)
  expect(removed).toEqual([])
  expect(log.writes).toEqual([])
  const ui = await $.ui.mount(SCRIPTS_TAB as any)
  expect(await ui.find({ type: 'Text', text: /No scripts from this session yet/ })).toBeDefined()
  await ui.unmount()
})

test('tokens and time add up by model, for the session and the day', async ($, on) => {
  await setup($, on, undefined, agentBottoms())
  await twoAgents($)
  for await (const _ of $.turn.step({ turnId: 'm1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 } as any)) void _
  for await (const _ of $.turn.step({ turnId: 'm1', index: 1, model: 'claude-sonnet-5-5', messageCount: 2 } as any)) void _
  const pane = await $.ui.mount(COSTS_TAB as any)
  expect(await pane.find({ type: 'Text', text: /Models · session/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Models · today/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Sonnet 5\.5/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /2 calls/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /78K out/ })).toBeDefined()
  await pane.unmount()
  const r: any = await $.command.run({ command: 'statusband', args: 'models' } as any)
  expect(r.text).toContain('This session:')
  expect(r.text).toContain('Opus 5.5: 1K in · 39K out · 127K cached')
  expect(r.text).toContain('Sonnet 5.5: 2K in · 78K out · 254K cached')
  expect(r.text).toContain('Last 7 days:')
  expect(r.text).toMatch(/▶ demo · \d{4}-\d\d-\d\d \d\d:\d\d · s1:/)
  expect(r.text).toContain('    Sonnet 5.5: 2K in')
})

test('cost lives on the Costs tab, tools on the Activity tab; the status pane keeps the totals', async ($, on) => {
  await setup($, on, undefined, (on: any) => {
    agentBottoms()(on)
    on('tool.call', async () => ({ result: { text: 'ok' } }) as any)
    on('turn.start', async (_$: any, e: any) => e)
  })
  await $.turn.start({ turnId: 'm1' } as any)
  for await (const _ of $.turn.step({ turnId: 'm1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as any)) void _
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  await $.tool.call({ tool: 'Bash', command: 'pwd' } as any)
  const tab = await $.ui.mount(COSTS_TAB as any)
  expect(await tab.find({ type: 'Text', text: /\$3\.21/ })).toBeDefined()
  expect(await tab.find({ type: 'Text', text: /99%/ })).toBeDefined() // 127K cached of 128K
  expect(await tab.find({ type: 'Text', text: /1 of 14d/ })).toBeDefined() // the trend shows from the first day
  expect(await tab.find({ type: 'Text', text: /Tools · session/ })).toBeUndefined()
  await tab.unmount()
  // The tools are on the Activity tab, there even with no agents.
  const act = await $.ui.mount(AGENTS_TAB as any)
  expect(await act.find({ type: 'Text', text: /Tools · session/ })).toBeDefined()
  expect(await act.find({ type: 'Text', text: / 2×/ })).toBeDefined()
  expect(await act.find({ type: 'Text', text: /No agents/ })).toBeUndefined()
  await act.unmount()
  const pane = await $.ui.mount({
    plugin: 'statusband', surface: 'terminal', component: 'Pane', requestId: 'statusband',
    props: { title: 'Status', isFocused: false, bodyColumns: 44, placement: 'dock' },
  } as any)
  expect(await pane.find({ type: 'Text', text: /Costs tab/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Models · session/ })).toBeUndefined()
  await pane.unmount()
})

test('/statusband report writes a CSV row per day and session', async ($, on) => {
  const written: { path: string; data: string }[] = []
  await setup($, on, undefined, (on: any) => {
    agentBottoms()(on)
    on('fs.write', async (_$: any, e: any) => (written.push({ path: e.path, data: e.data ?? e.content ?? e.text }), { value: undefined }) as any)
  })
  for await (const _ of $.turn.step({ turnId: 'm1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as any)) void _
  const r: any = await $.command.run({ command: 'statusband', args: 'report 7' } as any)
  expect(r.text).toContain('Last 7 days by repo:')
  expect(r.text).toContain('demo:')
  const csv = written.find((w) => /statusband-report-.*\.csv$/.test(w.path))
  expect(csv).toBeDefined()
  const lines = String(csv!.data).trim().split('\n')
  expect(lines[0]).toBe('day,repo,session,session_start,cost_usd,model_minutes,calls,tokens_in,tokens_cached,tokens_out,models')
  expect(lines[1]).toMatch(/^\d{4}-\d\d-\d\d,demo,s1,.*,1,1000,127000,39000,Opus 5\.5$/)
})

test('a day budget colours the cost, warns, and notifies once it is spent', async ($, on) => {
  const toasts: string[] = []
  const notes: string[] = []
  await setup($, on, async (_$: any, e: any) => (toasts.push(String(e.text)), { value: undefined }) as any, (on: any) => {
    on('ui.notify', async (_$: any, e: any) => (notes.push(String(e.text)), { value: { isSent: true } }) as any)
  })
  const r: any = await $.command.run({ command: 'statusband', args: 'budget day 2' } as any)
  expect(r.text).toContain('today: $3.21 of $2.00 (161%)')
  await $.session.measure({ ...USAGE, changed: ['cost'] })
  await $.session.measure({ ...USAGE, changed: ['cost'] })
  expect(toasts.filter((t) => t.includes('budget')).length).toBe(1)
  expect(notes.length).toBe(1)
  const pane = await $.ui.mount({
    plugin: 'statusband', surface: 'terminal', component: 'Pane', requestId: 'statusband',
    props: { title: 'Status', isFocused: false, bodyColumns: 44, placement: 'dock' },
  } as any)
  expect(await pane.find({ type: 'Text', text: /🎯 today/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /161%/ })).toBeDefined()
  await pane.unmount()
  expect(((await $.command.run({ command: 'statusband', args: 'budget day x' } as any)) as any).text).toContain('Usage:')
  expect(((await $.command.run({ command: 'statusband', args: 'budget off' } as any)) as any).text).toContain('No budget set')
})

test('the audit trail flags writes outside the repo, network and risky commands, denials', async ($, on) => {
  const written: { path: string; data: string }[] = []
  await setup($, on, undefined, (on: any) => {
    agentBottoms()(on)
    on('tool.call', async (_$: any, e: any) => (e.command === 'sudo rm -rf /' ? { deny: 'no' } : { result: { text: 'ok' } }) as any)
    on('fs.write', async (_$: any, e: any) => (written.push({ path: e.path, data: e.data ?? e.content ?? e.text }), { value: undefined }) as any)
  })
  await $.tool.call({ tool: 'Write', file_path: '/work/demo/src/a.js', content: 'x' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/etc/hosts', old_string: 'a', new_string: 'b' } as any)
  await $.tool.call({ tool: 'Write', file_path: '/tmp/scratch.txt', content: 'x' } as any)
  await $.tool.call({ tool: 'Bash', command: 'ls -la' } as any)
  await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' } as any)
  await $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'p' } as any)
  await $.tool.call({ tool: 'Bash', command: 'sudo rm -rf /' } as any)
  const act = await $.ui.mount(AGENTS_TAB as any)
  expect(await act.find({ type: 'Text', text: /Audit · session/ })).toBeDefined()
  expect(await act.find({ type: 'Text', text: /3 files written/ })).toBeDefined()
  expect(await act.find({ type: 'Text', text: /1 outside/ })).toBeDefined()
  expect(await act.find({ type: 'Text', text: /2 net/ })).toBeDefined()
  expect(await act.find({ type: 'Text', text: /1 risky/ })).toBeDefined()
  expect(await act.find({ type: 'Text', text: /1 denied/ })).toBeDefined()
  expect(await act.find({ type: 'Text', text: /sudo rm -rf/ })).toBeDefined() // the newest flagged first
  await act.unmount()
  const r: any = await $.command.run({ command: 'statusband', args: 'audit 1' } as any)
  expect(r.text).toContain('3 writes (1 outside the repo) · 2 network · 1 risky commands · 1 denied')
  const csv = written.find((w) => /statusband-audit-.*\.csv$/.test(w.path))
  const lines = String(csv!.data).trim().split('\n')
  expect(lines[0]).toBe('time,repo,session,agent,kind,tool,tags,target')
  expect(lines.length).toBe(7) // ls -la leaves no trace
  expect(lines[2]).toMatch(/,demo,s1,,write,Edit,outside,\/etc\/hosts$/)
  expect(lines[3]).toMatch(/,write,Write,tmp,\/tmp\/scratch\.txt$/)
  expect(lines[4]).toMatch(/,cmd,Bash,net push force,git push --force origin main$/)
})

test('the report summary lists each day and the costliest turns', async ($, on) => {
  const written: { path: string; data: string }[] = []
  let usd = 3.21
  await setup($, on, undefined, (on: any) => {
    agentBottoms()(on)
    on('turn.start', async (_$: any, e: any) => e)
    on('fs.write', async (_$: any, e: any) => (written.push({ path: e.path, data: e.data ?? e.content ?? e.text }), { value: undefined }) as any)
  }, { usage: () => ({ ...USAGE, cost: { usd } }) })
  await $.turn.start({ turnId: 'm1', text: 'Refactor the | billing\nmodule please' } as any)
  usd = 4.71
  await $.turn.complete({ turnId: 'm1', reason: 'answer', answer: 'ok', durationMs: 90_000 } as any)
  const r: any = await $.command.run({ command: 'statusband', args: 'report 7' } as any)
  expect(r.text).toMatch(/Summary \(by day, costliest turns\): .*statusband-report-.*\.md/)
  const md = String(written.find((w) => /statusband-report-.*\.md$/.test(w.path))!.data)
  expect(md).toContain('## By day')
  expect(md).toMatch(/\| \d{4}-\d\d-\d\d \| \$\d+\.\d\d \| 1 \| .* \| demo \|/)
  expect(md).toContain('## Costliest turns')
  expect(md).toMatch(/\| demo \| \$1\.50 \| 1m30s \| Refactor the \\\| billing module please \|/)
})

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

async function setup($: any, on: any, toast?: (...a: any[]) => Promise<any>, before?: (on: any) => void, opts: { removed?: string[][]; owners?: Record<string, unknown> } = {}) {
  mock.clock(on, { now })
  if (!opts.owners) mock.store(on)
  else {
    // A store that already holds another session's claims.
    const kv = new Map<string, unknown>([['scripts:/work/demo/.scripts', opts.owners]])
    on('store.get', async (_$: any, e: any) => ({ value: kv.get(e.key) }) as any)
    on('store.set', async (_$: any, e: any) => (kv.set(e.key, e.value), { value: undefined }) as any)
  }
  const answer = (value: unknown) => async () => ({ value }) as any
  on('session.usage', answer(USAGE))
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
  expect(opened).toEqual(['statusband-scripts', 'statusband'])
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

const AGENTS_TAB = {
  plugin: 'statusband', surface: 'terminal', component: 'Pane', requestId: 'statusband-agents',
  props: { title: 'Agents', isFocused: false, bodyColumns: 44, placement: 'dock' },
} as const

test('the Agents tab keeps a finished agent\'s tokens; the status pane only counts who runs', async ($, on) => {
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

test('the Agents tab keeps finished agents in sight when the running ones fill it', async ($, on) => {
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

test('/statusband opens the Agents tab once there are agents, status last', async ($, on) => {
  const opened: string[] = []
  await setup($, on, undefined, agentBottoms(opened))
  await twoAgents($)
  await $.command.run({ command: 'statusband', args: '' } as any)
  expect(opened).toEqual(['statusband-agents', 'statusband'])
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

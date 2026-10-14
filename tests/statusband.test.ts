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

async function setup($: any, on: any, toast?: (...a: any[]) => Promise<any>, before?: (on: any) => void) {
  mock.clock(on, { now })
  mock.store(on)
  const answer = (value: unknown) => async () => ({ value }) as any
  on('session.usage', answer(USAGE))
  on('session.id', answer('s1'))
  on('session.cwd', answer('/work/demo'))
  on('process.run', answer({ exitCode: 1, stdout: '', stderr: '' }))
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

// A .scripts folder with two scripts, the newer written during the session.
const SCRIPTS: Record<string, { text: string; mtimeMs: number }> = {
  'deploy.sh': { text: '#!/bin/bash\n# Deploy the demo to staging\necho deploy\n', mtimeMs: now - 60_000 },
  'old.py': { text: '# Old helper\nprint(1)\n', mtimeMs: now - 3 * 86_400_000 },
}

function scriptFs(log: { fills: string[]; copies: string[]; writes: string[] }) {
  return (on: any) => {
    const answer = (f: (e: any) => unknown) => async (_$: any, e: any) => ({ value: f(e) }) as any
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

test('sidebar lists scripts; run fills the prompt, copy puts the file on the clipboard', async ($, on) => {
  const log = { fills: [] as string[], copies: [] as string[], writes: [] as string[] }
  await setup($, on, undefined, scriptFs(log))
  expect(log.writes).toContain('/work/demo/.scripts/.gitignore')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'statusband', surface, component: 'Pane', requestId: 'statusband',
      props: { title: 'Status', isFocused: false, bodyColumns: 44, placement: 'dock' },
    } as any)
    expect(await ui.find({ type: 'Text', text: /Scripts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Deploy the demo to staging/ })).toBeDefined()
    await ui.press({ key: 'run:deploy.sh' })
    await ui.press({ key: 'copy:old.py' })
    await ui.unmount()
  }
  expect(log.fills).toEqual(['! bash /work/demo/.scripts/deploy.sh', '! bash /work/demo/.scripts/deploy.sh'])
  expect(log.copies).toEqual([SCRIPTS['old.py'].text, SCRIPTS['old.py'].text])
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
  await setup($, on, undefined, scriptFs(log))
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

import { test, expect } from 'claude-code/testing'
// @ts-ignore: plain JS module without types
import { num, fmtTokens, fmtDur, fmtUsd, dayKey, toMs, bar, shorten, prettyModel, cells, limitShape, addSample, quotaFor, fit, scriptDesc, runLine, pickScript } from '../hooks/lib.js'

const MIN = 60_000
const HOUR = 60 * MIN
const near = (got: number | null, want: number, tol: number) => expect(Math.abs((got ?? NaN) - want) < tol).toBe(true)

test('num picks the first finite number', async () => {
  expect(num(undefined, NaN, 'x', 3, 4)).toBe(3)
  expect(num(null, Infinity)).toBe(null)
})

test('fmtTokens', async () => {
  expect(fmtTokens(null)).toBe('?')
  expect(fmtTokens(950)).toBe('950')
  expect(fmtTokens(49_153)).toBe('49K')
  expect(fmtTokens(1_000_000)).toBe('1M')
  expect(fmtTokens(1_500_000)).toBe('1.5M')
})

test('fmtDur', async () => {
  expect(fmtDur(-1)).toBe('?')
  expect(fmtDur(NaN)).toBe('?')
  expect(fmtDur(42_000)).toBe('42s')
  expect(fmtDur(5 * MIN + 7_000)).toBe('5m07s')
  expect(fmtDur(42 * MIN)).toBe('42m')
  expect(fmtDur(HOUR + 5 * MIN)).toBe('1h05m')
  expect(fmtDur(2 * 24 * HOUR + 3 * HOUR)).toBe('2d3h')
  expect(fmtDur(3 * 24 * HOUR)).toBe('3d')
})

test('fmtUsd, dayKey, toMs', async () => {
  expect(fmtUsd(null)).toBe('$-')
  expect(fmtUsd(3.214)).toBe('$3.21')
  expect(dayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05')
  expect(toMs(1_791_906_494)).toBe(1_791_906_494_000) // seconds
  expect(toMs(1_791_906_494_244)).toBe(1_791_906_494_244) // already ms
  expect(toMs('2026-10-15T11:00:00.000Z')).toBe(Date.UTC(2026, 9, 15, 11))
  expect(toMs('soon')).toBe(null)
  expect(toMs(null)).toBe(null)
})

test('bar clamps to its width', async () => {
  expect(bar(50, 10)).toEqual(['█████', '░░░░░'])
  expect(bar(-5, 4)).toEqual(['', '░░░░'])
  expect(bar(130, 4)).toEqual(['████', ''])
})

test('shorten and prettyModel', async () => {
  expect(shorten('abcdef', 4)).toBe('abc…')
  expect(shorten('abc', 4)).toBe('abc')
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-fable-5-1[1m]')).toBe('Fable 5.1 1M')
  expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(prettyModel('claude-sonnet-5')).toBe('Sonnet 5')
  expect(prettyModel(null)).toBe(null)
  expect(prettyModel('some-very-long-custom-model-name')).toBe('some-very-long-custom…')
})

test('cells counts wide emoji as two', async () => {
  expect(cells('abc')).toBe(3)
  for (const e of ['⚡', '⏳', '✅', '🤖', '📅']) expect(cells(e)).toBe(2)
  expect(cells('⚠️ tight')).toBe(8) // VS16 makes the sign an emoji
  expect(cells('⚠ tight')).toBe(7)
  expect(cells('█░│')).toBe(3)
})

test('limitShape names the windows', async () => {
  expect(limitShape('five_hour')).toMatchObject({ label: '5h', windowMs: 5 * HOUR, recent: true })
  expect(limitShape('seven_day')).toMatchObject({ label: '7d', windowMs: 7 * 24 * HOUR, recent: false })
  expect(limitShape('seven_day_opus')).toMatchObject({ label: '7d opus', windowMs: 7 * 24 * HOUR })
  expect(limitShape('monthly')).toMatchObject({ label: 'monthly', windowMs: null })
  expect(limitShape(undefined).label).toBe('?')
})

test('addSample keeps changes and a sample per gap, drops old ones', async () => {
  const now = 10 * 24 * HOUR
  let s = addSample([], 10, now)
  expect(s).toEqual([[now, 10]])
  expect(addSample(s, 10, now + MIN)).toEqual(s) // same value, within the gap
  expect(addSample(s, 11, now + MIN)).toHaveLength(2) // changed
  expect(addSample(s, 10, now + 3 * MIN)).toHaveLength(2) // gap passed
  expect(addSample([[now - 9 * 24 * HOUR, 1]], 5, now)).toEqual([[now, 5]])
  expect(addSample('junk', 5, now)).toEqual([[now, 5]])
})

test('quotaFor: on pace lasts until the reset', async () => {
  const now = 1_000 * HOUR
  // 7d window, half elapsed, 30% used: pace 0.6
  const q = quotaFor({ kind: 'seven_day', pct: 30, resetsAt: now + 3.5 * 24 * HOUR }, [], now)
  near(q.pace, 0.6, 1e-6)
  expect(q.status).toBe('ok')
})

test('quotaFor: a fast 5h window runs out before the reset', async () => {
  const now = 1_000 * HOUR
  const resetsAt = now + 3 * HOUR // 2h elapsed
  // Window average says 40% in 2h -> 100% by the reset is tight; recent samples say 30% in 20m.
  const samples = [
    [now - 20 * MIN, 10],
    [now - 10 * MIN, 25],
    [now, 40],
  ]
  const q = quotaFor({ kind: 'five_hour', pct: 40, resetsAt }, samples, now)
  expect(q.status).toBe('out')
  near(q.eta, 40 * MIN, 1_000) // 60% left at 1.5% per minute
  near(q.pace, 1.0, 1e-6)
})

test('quotaFor: too few recent samples fall back to the window average', async () => {
  const now = 1_000 * HOUR
  const q = quotaFor({ kind: 'five_hour', pct: 40, resetsAt: now + 3 * HOUR }, [[now, 40]], now)
  // 20% per hour, 3h left: 100% exactly at the reset
  expect(q.status).toBe('out')
  near(q.eta, 3 * HOUR, 1_000)
})

test('quotaFor: no reset time, no forecast', async () => {
  const q = quotaFor({ kind: 'seven_day', pct: 30, resetsAt: null }, [], 0)
  expect(q).toMatchObject({ pace: null, status: null, eta: null })
})

test('fit drops the highest-pri segments, then trailing separators', async () => {
  const seg = (t: string, pri?: number) => ({ t, pri })
  const line = [seg('aaaa'), seg(' │ '), seg('bbbb', 1), seg(' │ '), seg('cccc', 2)]
  expect(fit(line, 100).map((s: any) => s.t).join('')).toBe('aaaa │ bbbb │ cccc')
  expect(fit(line, 12).map((s: any) => s.t).join('')).toBe('aaaa │ bbbb')
  expect(fit(line, 6).map((s: any) => s.t).join('')).toBe('aaaa')
  expect(fit([seg('too long for it')], 3)).toHaveLength(1) // pri 0 stays
})

test('scriptDesc reads the first comment under the shebang', async () => {
  expect(scriptDesc('#!/bin/bash\n# Build the image\necho')).toBe('Build the image')
  expect(scriptDesc('#!/usr/bin/env node\n// Seed the db\n')).toBe('Seed the db')
  expect(scriptDesc('echo hi')).toBe(null)
  expect(scriptDesc(undefined)).toBe(null)
})

test('runLine picks the interpreter and quotes odd names', async () => {
  expect(runLine('.scripts', 'deploy.sh')).toBe('! bash .scripts/deploy.sh')
  expect(runLine('.scripts', 'fix.py')).toBe('! python3 .scripts/fix.py')
  expect(runLine('.scripts', 'setup.zsh')).toBe('! zsh .scripts/setup.zsh')
  expect(runLine('.scripts', 'noext')).toBe('! bash .scripts/noext')
  expect(runLine('.scripts', "it's here.sh")).toBe("! bash '.scripts/it'\\''s here.sh'")
})

test('pickScript: exact, then prefix, then the newest', async () => {
  const list = [{ name: 'deploy.sh' }, { name: 'deploy-old.sh' }, { name: 'fix.py' }]
  expect(pickScript(list, '')?.name).toBe('deploy.sh')
  expect(pickScript(list, 'deploy-old.sh')?.name).toBe('deploy-old.sh')
  expect(pickScript(list, 'fi')?.name).toBe('fix.py')
  expect(pickScript(list, 'nope')).toBe(null)
  expect(pickScript([], undefined)).toBe(null)
})

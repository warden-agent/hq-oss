// Bug 349: a ticket auto mode parked said why only on its box and in the ⚠ menu; its Ticket tab had just the status pill. The tab now says it too (board.ts
// parkWords, shown by App.tsx's TicketInfo): why auto mode parked it, in the box's words, what Try again does, and a Try again button like the box's.
// The real page was checked in a headless browser on an isolated HQ by a one-off script; this keeps the rule in the code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { register } from 'node:module'

// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts (as heldline.test.ts does).
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { buildBoard, parkWords, PARK_NEXT, PARK_STOPPED, PARK_OFF } = await import(BOARD) as {
  buildBoard: (s: any, now: number, repo?: any) => any; PARK_NEXT: string; PARK_STOPPED: string; PARK_OFF: string
  parkWords: (t: any, repo: any) => { why: string; next: string } | null }

const WHY = 'Its tests still fail on main after 2 fixes.'
const AUTO = { auto_mode: 1, auto_stopped_why: null, clearing_at: null }
const state = (t: Record<string, unknown>, agents: any[] = [], repo: Record<string, unknown> = AUTO): any => ({
  repos: [{ id: 'r1', name: 'notes', default_branch: 'main', tpm_agent_id: null, ...repo }],
  features: [{ id: 'f1', repo_id: 'r1', title: 'Notes page', status: 'building', created_at: 1 }],
  tickets: [{ id: 't1', key: 'T-01', feature_id: 'f1', title: 'A list', size: 'S', status: 'escalated', deps: '[]', assignee_agent_id: null, ...t }],
  agents, messages: [], reviews: [], attention: [], asks: [], settings: {}, defaults: {}, held: 0, ports: {}, previews: [], testRuns: [],
})
const view = (s: any) => buildBoard(s, 1_000, s.repos[0]).nodes.find((n: any) => n.id === 't:t1').data.view

test('Bug 349: the Ticket tab says why auto mode parked a ticket, with the box\'s reason, and what Try again does', () => {
  const w = parkWords({ auto_parked_why: WHY }, AUTO)!
  assert.equal(w.why, WHY)
  assert.equal(w.next, PARK_NEXT)
  assert.match(w.next, /Try again hands it back to auto mode/)
  // the box says the same reason (its first line, or under its engineer's line once one works on it, Bug 336) and has the same Try again
  const eng = { id: 'e1', role: 'engineer', status: 'working', repo_id: 'r1', feature_id: 'f1', ticket_id: 't1' }
  for (const s of [state({ auto_parked_why: WHY }), state({ auto_parked_why: WHY, status: 'implementing', assignee_agent_id: 'e1' }, [eng])]) {
    const v = view(s)
    assert.ok(v.lines.some((l: any) => l.text.endsWith(`: ${w.why}`) && /^parked\b/.test(l.text)), `the box: ${JSON.stringify(v.lines)}`)
    assert.ok(v.acts.some((a: any) => a.kind === 'auto-retry'), 'the box has Try again')
    // with Bug 336 the "parked by auto mode" line under an engineer's line has a hover: the tab's words are the same
    const tip = v.lines.find((l: any) => l.tip?.startsWith('Auto mode parked it'))?.tip
    if (tip) assert.equal(tip, `Auto mode parked it: ${w.why} ${w.next}`)
  }
})

test('Bug 349: what it must not catch: a ticket that isn\'t parked (never, or after Try again) has no park words, on the tab or the box', () => {
  for (const t of [{}, { auto_parked_why: null }, { auto_parked_why: '' }]) {
    assert.equal(parkWords(t, AUTO), null, JSON.stringify(t))
    const v = view(state(t))
    assert.ok(!v.lines.some((l: any) => /parked/.test(l.text)) && !v.acts.some((a: any) => a.kind === 'auto-retry'), JSON.stringify(v.lines))
  }
})

test('Bug 349: TicketInfo shows the park words and a Try again that asks for another go, as the box\'s does', () => {
  const app = fs.readFileSync(new URL('../../frontend/src/App.tsx', import.meta.url), 'utf8')
  const at = app.indexOf('\nfunction TicketInfo('), end = app.indexOf('\nconst ', at), f = app.slice(at, end)
  assert.ok(at >= 0 && end > at, 'App.tsx has TicketInfo')
  assert.match(f, /park = parkWords\(t, repo\)/)
  assert.match(f, /\{park && <div[^]*\{park\.why\}[^]*\{park\.next\}[^]*\{retry && <div[^>]*><ActBtn[^>]*label="Try again"[^]*tickets\/\$\{t\.id\}\/auto-retry/)
  assert.match(f, /const retry = !!repo && autoRetries\(repo\)/, 'Bug 364: the tab asks the same rule as the box and the backend')
  const nodes = fs.readFileSync(new URL('../../frontend/src/Nodes.tsx', import.meta.url), 'utf8')
  assert.match(nodes, /label="Try again"[^\n]*tickets\/\$\{v\.t\.id\}\/auto-retry/, "the box's Try again asks the same")
})

// Bug 364: auto mode turned off after it parked a ticket. The box and the tab still offered Try again, "hands it back to auto mode"; pressing it dropped
// the park's reason and nothing started ("no engineer running"). Now Try again shows only while auto mode can take it (mover.ts autoRetries, which the
// backend's autoRetry asks too), and the words say who moves it on in each mode.
test('Bug 364: with auto mode off a parked ticket has no Try again, and the box and the tab say it is the user\'s, and how to hand it back', () => {
  const eng = { id: 'e1', role: 'engineer', status: 'working', repo_id: 'r1', feature_id: 'f1', ticket_id: 't1' }
  const modes = [
    { name: 'auto on', repo: AUTO, retry: true, next: PARK_NEXT },
    { name: 'auto stopped', repo: { ...AUTO, auto_stopped_why: "main's own tests fail." }, retry: true, next: PARK_STOPPED },
    { name: 'auto off', repo: { ...AUTO, auto_mode: 0 }, retry: false, next: PARK_OFF },
    { name: 'auto off (false)', repo: { ...AUTO, auto_mode: false }, retry: false, next: PARK_OFF },
  ]
  for (const m of modes) {
    assert.equal(parkWords({ auto_parked_why: WHY }, m.repo)!.next, m.next, m.name)
    // its box: parked first (no engineer) or under its engineer's line (Bug 336); a finished one with a branch (Resume shows when it has none at work)
    for (const s of [state({ auto_parked_why: WHY }, [], m.repo), state({ auto_parked_why: WHY, status: 'implementing', assignee_agent_id: 'e1' }, [eng], m.repo)]) {
      const v = view(s), at = `${m.name}, ${s.tickets[0].status}`
      assert.equal(v.acts.some((a: any) => a.kind === 'auto-retry'), m.retry, `${at}: Try again ${JSON.stringify(v.acts)}`)
      const line = v.lines.find((l: any) => /^parked\b/.test(l.text))
      assert.ok(line, `${at}: the park stays on the box: ${JSON.stringify(v.lines)}`)
      assert.equal(line.tip, `Auto mode parked it: ${WHY} ${m.next}`, `${at}: its hover says what the tab says`)
    }
  }
  assert.match(PARK_OFF, /^Auto mode is off/); assert.doesNotMatch(PARK_OFF, /Try again hands it back/)
  // a parked ticket with a branch and no engineer: with auto off the user's own way on is still there (Resume), only Try again goes
  const v = view(state({ auto_parked_why: WHY, status: 'implementing', branch: 'hq/x/T-01' }, [], { ...AUTO, auto_mode: 0 }))
  assert.deepEqual(v.acts.map((a: any) => a.kind), ['resume'])
})

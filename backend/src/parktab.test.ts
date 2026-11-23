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
const { buildBoard, parkWords, PARK_NEXT } = await import(BOARD) as {
  buildBoard: (s: any, now: number, repo?: any) => any; PARK_NEXT: string
  parkWords: (t: any) => { why: string; next: string } | null }

const WHY = 'Its tests still fail on main after 2 fixes.'
const state = (t: Record<string, unknown>, agents: any[] = []): any => ({
  repos: [{ id: 'r1', name: 'notes', default_branch: 'main', auto_mode: 1, tpm_agent_id: null }],
  features: [{ id: 'f1', repo_id: 'r1', title: 'Notes page', status: 'building', created_at: 1 }],
  tickets: [{ id: 't1', key: 'T-01', feature_id: 'f1', title: 'A list', size: 'S', status: 'escalated', deps: '[]', assignee_agent_id: null, ...t }],
  agents, messages: [], reviews: [], attention: [], asks: [], settings: {}, defaults: {}, held: 0, ports: {}, previews: [], testRuns: [],
})
const view = (s: any) => buildBoard(s, 1_000, s.repos[0]).nodes.find((n: any) => n.id === 't:t1').data.view

test('Bug 349: the Ticket tab says why auto mode parked a ticket, with the box\'s reason, and what Try again does', () => {
  const w = parkWords({ auto_parked_why: WHY })!
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
    assert.equal(parkWords(t), null, JSON.stringify(t))
    const v = view(state(t))
    assert.ok(!v.lines.some((l: any) => /parked/.test(l.text)) && !v.acts.some((a: any) => a.kind === 'auto-retry'), JSON.stringify(v.lines))
  }
})

test('Bug 349: TicketInfo shows the park words and a Try again that asks for another go, as the box\'s does', () => {
  const app = fs.readFileSync(new URL('../../frontend/src/App.tsx', import.meta.url), 'utf8')
  const at = app.indexOf('\nfunction TicketInfo('), end = app.indexOf('\nconst ', at), f = app.slice(at, end)
  assert.ok(at >= 0 && end > at, 'App.tsx has TicketInfo')
  assert.match(f, /park = parkWords\(t\)/)
  assert.match(f, /\{park && <div[^]*\{park\.why\}[^]*\{park\.next\}[^]*label="Try again"[^]*tickets\/\$\{t\.id\}\/auto-retry/)
  const nodes = fs.readFileSync(new URL('../../frontend/src/Nodes.tsx', import.meta.url), 'utf8')
  assert.match(nodes, /label="Try again"[^\n]*tickets\/\$\{v\.t\.id\}\/auto-retry/, "the box's Try again asks the same")
})

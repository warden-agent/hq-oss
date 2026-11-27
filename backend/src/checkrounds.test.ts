// Bug 401: once the user sends HQ's failed test back to the ticket's engineer and it finishes the ticket again, the box says its fix is back: the pill, the
// first line and the check button (first, in its own colour), with Merge no longer the primary. It used to read "ready to merge", exactly like a ticket that
// never went back, with a grey "Results out of date" (frontend/src/board.ts, hqcheckrules.ts fixBack).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts (as donefold.test.ts does).
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { buildBoard, checkWords, ticketLabel } = await import(BOARD) as { buildBoard: (s: any, now: number, repo?: any) => any; ticketLabel: (...a: any[]) => string
  checkWords: (t: any) => string }

const check = (o: Record<string, unknown> = {}) => JSON.stringify({ id: 'check-1', state: 'fail', sha: 'aaaaaaa1', base: 'main', base_sha: 'bbbbbbb2', finished_sha: 'aaaaaaa1',
  started_at: 1_000, ended_at: 60_000, round: 1, steps: [{ kind: 'ui', state: 'fail', words: 'found 1 problem' }], send: { kind: 'fix', test: 'npm test', output: 'x', earlier: '' },
  sent_at: 70_000, back: { at: 160_000, sha: 'ccccccc3', files: ['src/list.js'], note: 'fixed the list' }, ...o })
const ticket = (o: Record<string, unknown> = {}) => ({ id: 't1', key: 'T-01', feature_id: 'f1', title: 'A list', size: 'S', status: 'pr_ready', pr_state: 'local', deps: '[]',
  branch: 'hq/T-01', finished_sha: 'ccccccc3', hq_check: check(), ...o })
const state = (t: Record<string, unknown>, repo: Record<string, unknown> = {}) => ({
  repos: [{ id: 'r1', name: 'notes', default_branch: 'main', tpm_agent_id: null, ...repo }],
  features: [{ id: 'f1', repo_id: 'r1', title: 'Notes page', status: 'planning', created_at: 1 }],
  tickets: [ticket(t)], agents: [], messages: [], reviews: [], attention: [], asks: [], settings: {}, defaults: {}, held: 0, ports: {}, previews: [], testRuns: [] })
const view = (t: Record<string, unknown> = {}, repo: Record<string, unknown> = {}) => {
  const s = state(t, repo); return buildBoard(s, 200_000, s.repos[0]).nodes.find((n: any) => n.id === 't:t1').data.view
}
const acts = (v: any) => v.acts.map((a: any) => a.kind === 'merge' ? `merge${a.soft ? ':soft' : ''}` : a.kind === 'check' ? `check:${a.label}` : a.kind)

test('the fix is back: the pill, the first line and the check button say so, the button comes first, and Merge is no longer the primary', () => {
  const v = view()
  assert.equal(v.back, true)
  assert.equal(ticketLabel(v.t, false, false, v.back), 'fix is back')
  assert.equal(v.lines[0].text, 'its engineer is back from round 1 · test it again'); assert.equal(v.lines[0].tone, 'sky')
  assert.deepEqual(acts(v), ['check:Fix is back · test again', 'merge:soft', 'do-rest'])
  // Merge's are-you-sure names the button that tests it, as it is called now
  assert.match(checkWords(v.t), /hasn't tested its engineer's fix of what you sent back: to have it tested first, press Fix is back · test again\.$/)
  // round 2 came back too: its number
  assert.equal(view({ hq_check: check({ round: 2 }) }).lines[0].text, 'its engineer is back from round 2 · test it again')
  // GitHub: Create PR stops being the primary too
  const gh = view({ pr_state: null, pr_url: 'https://github.com/e2e/notes/compare/main...hq/T-01?expand=1' })
  assert.deepEqual(gh.acts.filter((a: any) => a.kind === 'link').map((a: any) => a.primary), [false])
})

test('what it must not catch: never sent, sent and tested again, auto mode, its conflicts', () => {
  const plain = view({ hq_check: check({ sent_at: undefined, back: undefined }) }) // finished again, but nothing was sent: out of date, as before
  assert.equal(plain.back, false); assert.equal(ticketLabel(plain.t, false, false, plain.back), 'ready to merge')
  assert.equal(checkWords(plain.t), 'HQ runs no tests as it merges: to have it tested first, press Have HQ test this.')
  assert.equal(plain.lines[0].text, 'done · waiting for you to merge it'); assert.deepEqual(acts(plain), ['merge', 'check:Results out of date', 'do-rest'])
  const tested = view({ finished_sha: 'aaaaaaa1' }) // the same commit HQ tested: nothing new came back yet
  assert.equal(tested.back, false); assert.deepEqual(acts(tested), ['merge', 'check:View results ✗', 'do-rest'])
  const auto = view({}, { auto_mode: 1, auto_state: 'running' }) // auto mode tests and merges it itself
  assert.equal(auto.back, false); assert.equal(auto.lines[0].text, 'done · HQ tests it, then merges it')
  const conflict = view({ conflict_files: '["a.txt"]' }) // its conflicts first: Fix conflicts is its button
  assert.equal(conflict.back, false); assert.equal(ticketLabel(conflict.t, false, false, conflict.back), 'conflicts'); assert.match(conflict.lines[0].text, /conflicts with main/)
  assert.equal(conflict.acts[0].kind, 'fix', 'Fix conflicts first, as before')
})

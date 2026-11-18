// Bug 244: when GitHub refuses to open a ticket's PR, HQ's error says "Create PR ↗ on its box opens GitHub's own form". The box
// (frontend/src/board.ts mergeActs) must then have that link: it takes Make PR's place on a `not_opened` ticket.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { register } from 'node:module'

// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts (as donefold.test.ts does).
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { mergeActs, CREATE_PR } = await import(BOARD) as { mergeActs: (t: any, base: string, eng: any) => any[]; CREATE_PR: string }

const FORM = 'https://github.com/e2e/notes/compare/main...hq/T-01?expand=1'
const ticket = (o: Record<string, unknown> = {}) => ({ id: 't1', key: 'T-01', status: 'pr_ready', branch: 'hq/T-01', pr_state: 'waiting', pr_url: null, ...o })
const kinds = (acts: any[]) => acts.map((a) => a.kind === 'link' ? `link:${a.label}:${a.href}` : a.kind)

test('GitHub refused the PR: the box has the Create PR link the error names, in place of Make PR', () => {
  const acts = mergeActs(ticket({ pr_state: 'not_opened', pr_url: FORM }), 'main', null)
  assert.deepEqual(kinds(acts), ['merge', `link:${CREATE_PR}:${FORM}`])
  assert.equal(acts[0].github, true)
  const src = fs.readFileSync(new URL('./mergewatch.ts', import.meta.url), 'utf8')
  const said = src.match(/GitHub wouldn't open the PR for \$\{t\.key\}[^`]*/)?.[0] ?? ''
  assert.ok(said.includes(`${CREATE_PR} on its box`), `makePr's refusal names the box's link: ${said}`)
})

test('what it must not catch: a PR nobody asked for yet, a refusal with no link, a conflict, an open PR, a local repo', () => {
  assert.deepEqual(kinds(mergeActs(ticket(), 'main', null)), ['merge', 'make-pr'], 'waiting: Make PR as before')
  assert.deepEqual(kinds(mergeActs(ticket({ pr_url: FORM }), 'main', null)), ['merge', 'make-pr'], 'waiting with a URL: still Make PR')
  assert.deepEqual(kinds(mergeActs(ticket({ pr_state: 'not_opened' }), 'main', null)), ['merge', 'make-pr'], 'no link to give: Make PR stays')
  const conflict = ticket({ pr_state: 'not_opened', pr_url: FORM, conflict_files: '["a.txt"]' })
  assert.deepEqual(kinds(mergeActs(conflict, 'main', null)), ['fix', `link:${CREATE_PR}:${FORM}`], 'conflict: Fix conflicts, then the link')
  const open = ticket({ status: 'pr_open', pr_state: 'open', pr_number: 7, pr_url: 'https://github.com/e2e/notes/pull/7' })
  assert.deepEqual(kinds(mergeActs(open, 'main', null)), ['merge', 'link:PR #7 ↗:https://github.com/e2e/notes/pull/7'])
  assert.deepEqual(kinds(mergeActs(ticket({ pr_state: 'local' }), 'main', null)), ['merge'])
})

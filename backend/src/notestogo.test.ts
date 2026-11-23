// Bug 313: during a Clear the top bar's "Clearing… N notes to go" counted only the agents HQ had already asked (fresh_start_at), and HQ asks them one
// at a time, so it read 2, then 3 a second later. It now counts everyone the Clear asks for a note from the start (frontend/src/board.ts noteTakers,
// the same rule as Clear's dialog), and each drops out as it stops.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts.
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { noteTakers } = await import(BOARD) as { noteTakers: (all: any, repo: any) => { id: string }[] }

const ag = (id: string, role: string, o: Record<string, unknown> = {}) => ({ id, role, display_name: id, status: 'working', repo_id: 'r1', feature_id: 'f1',
  ticket_id: null, fresh_start_at: null, ...o })
const state = (agents: any[]): any => ({
  repos: [{ id: 'r1', name: 'garden', default_branch: 'main', auto_mode: 0, clearing_at: 5 }, { id: 'r2', name: 'other', default_branch: 'main', auto_mode: 0 }],
  features: [{ id: 'f1', repo_id: 'r1', status: 'planning' }, { id: 'f2', repo_id: 'r2', status: 'planning' }],
  tickets: [{ id: 't1', key: 'T-01', feature_id: 'f1', status: 'implementing' }, { id: 't2', key: 'T-02', feature_id: 'f1', status: 'implementing' },
    { id: 't3', key: 'T-03', feature_id: 'f1', status: 'plan_review' }, { id: 't4', key: 'T-04', feature_id: 'f1', status: 'pr_ready' },
    { id: 't9', key: 'T-01', feature_id: 'f2', status: 'implementing' }],
  agents, reviews: [{ id: 'R1', ticket_id: 't3', status: 'open' }], messages: [], attention: [], asks: [], settings: {}, defaults: {}, previews: [],
})
const count = (agents: any[]) => noteTakers(state(agents), { id: 'r1' }).map((a) => a.id).sort()

test('Bug 313: the count starts at everyone the Clear asks, and only goes down as each one stops', () => {
  const tpm = ag('tpm', 'tpm', { feature_id: null }), e1 = ag('e1', 'engineer', { ticket_id: 't1' }), e2 = ag('e2', 'engineer', { ticket_id: 't2' })
  const others = [ag('e3', 'engineer', { ticket_id: 't3', status: 'plan_review' }), ag('e4', 'engineer', { ticket_id: 't4', status: 'idle' }), // stop at once
    ag('rev', 'reviewer'), ag('lh', 'launcher', { feature_id: null }), ag('x9', 'engineer', { ticket_id: 't9', repo_id: 'r2', feature_id: 'f2' })] // not asked / not this repo
  const asked = (a: any) => ({ ...a, fresh_start_at: 10 }), stopped = (a: any) => ({ ...a, status: 'exited' })
  assert.deepEqual(count([tpm, e1, e2, ...others]), ['e1', 'e2', 'tpm']) // the clear has only just begun: nobody asked yet
  assert.deepEqual(count([asked(tpm), e1, e2, ...others]), ['e1', 'e2', 'tpm']) // HQ has reached the TPM: still 3, not 1
  assert.deepEqual(count([asked(tpm), asked(e1), asked(e2), ...others.map(stopped)]), ['e1', 'e2', 'tpm'])
  assert.deepEqual(count([asked(tpm), stopped(asked(e1)), asked(e2), ...others.map(stopped)]), ['e2', 'tpm']) // e1's note is in
  assert.deepEqual(count([stopped(tpm), stopped(e1), stopped(e2), ...others.map(stopped)]), [])
})

test('what it must not catch: an agent on a dialog stops at once with no note, so it is never counted', () => {
  const tpm = ag('tpm', 'tpm', { feature_id: null, status: 'paused' }), e1 = ag('e1', 'engineer', { ticket_id: 't1' }) // the TPM: a dialog on its terminal
  assert.deepEqual(count([tpm, e1]), ['e1'])
})

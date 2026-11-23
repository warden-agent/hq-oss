// Bug 339: switching projects while an agent writes a fresh start's note. The switch dialog (frontend/src/board.ts stopOthers) said it
// "keeps running" and didn't ask HQ to park the project when it was the only agent, so the new session started in the project the user
// left. Now an agent already writing a note is parked like the rest (parksOnSwitch); a Clear's note request is left alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts.
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { parksOnSwitch } = await import(BOARD) as { parksOnSwitch: (a: any, s: any) => boolean }

const eng = (o: object = {}): any => ({ id: 'e1', role: 'engineer', status: 'working', ticket_id: 'b339t', feature_id: 'f1', repo_id: 'r1', ...o })
const state = (status = 'implementing'): any => ({
  repos: [{ id: 'r1', name: 'b339x', auto_mode: 0 }], features: [{ id: 'f1', repo_id: 'r1', status: 'planning' }],
  tickets: [{ id: 'b339t', key: 'B-1', feature_id: 'f1', status }], agents: [], reviews: [], settings: {}, defaults: {},
})

test('Bug 339: an agent writing a fresh start\'s note is parked by a switch, like one that can write a note now', () => {
  assert.equal(parksOnSwitch(eng(), state()), true)
  assert.equal(parksOnSwitch(eng({ fresh_start_at: 5, fresh_start_then: 'continue' }), state()), true)
  assert.equal(parksOnSwitch(eng({ fresh_start_at: 5, fresh_start_then: 'park' }), state()), true)
  assert.equal(parksOnSwitch(eng({ fresh_start_at: 5, fresh_start_then: 'switch' }), state()), true)
})

test('Bug 339, what it must not catch: a Clear\'s note request, an agent that has ended, one on a dialog, finished work', () => {
  assert.equal(parksOnSwitch(eng({ fresh_start_at: 5, fresh_start_then: 'clear' }), state()), false)
  assert.equal(parksOnSwitch(eng({ status: 'exited', fresh_start_at: 5, fresh_start_then: 'continue' }), state()), false)
  assert.equal(parksOnSwitch(eng({ status: 'paused' }), state()), false) // on a dialog: it stays, as before
  assert.equal(parksOnSwitch(eng(), state('merged')), false)
})

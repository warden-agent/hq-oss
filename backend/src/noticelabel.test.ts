// Bug 251: a notice about a whole project (repo_<what>:<repo id>) says what about it in the ⚠ menu (frontend/src/board.ts kindLabel),
// not a bare "Repo" over good news like "Cleared garden: …".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts (as donefold.test.ts does).
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { kindLabel } = await import(BOARD) as { kindLabel: (k: string) => string }

test('Bug 251: project notices are named for what happened, never a bare "Repo"', () => {
  assert.equal(kindLabel('repo_cleared:r1'), 'Project cleared')
  assert.equal(kindLabel('repo_cleared_left:r1'), 'Cleared, worktrees left')
  assert.equal(kindLabel('repo_clear_tpm:r1'), "TPM didn't start after Clear")
  assert.equal(kindLabel('repo_clear_failed:r1'), "Clear didn't finish")
  assert.equal(kindLabel('repo_sync:r1'), "Couldn't sync")
  assert.equal(kindLabel('repo_testsetup_ok:r1'), 'Test setup ready'); assert.equal(kindLabel('repo_testsetup:r1'), 'Test setup problem')
  assert.equal(kindLabel('repo_new_thing:r1'), 'Project') // one HQ has no words for yet
  // what it must not change: kinds that aren't about a project, and auto mode's own
  assert.equal(kindLabel('merged'), 'Merged'); assert.equal(kindLabel('auto_finished:r1'), 'Auto mode finished')
  assert.equal(kindLabel('launch_failed'), 'Launch failed')
})

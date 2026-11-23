// Bug 224: the Clear and Remove dialogs (frontend/src/board.ts) name the folder HQ really archives to: HQ's own archive, which follows
// HQ_HOME, with the folder name HQ gives the project (clear.ts), the home folder shown as ~ the way the notices write it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-archwords-'))
const { migrate, run } = await import('./db.ts')
migrate()
const { removeRepo } = await import('./remove.ts')
const { PATHS } = await import('./config.ts')
const { archiveName, homeShort } = await import('./projectname.ts')

// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts.
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const board = await import(BOARD) as { onAsk: (fn: (q: any) => Promise<boolean>) => void; clearConfirm: (s: any, r: any) => Promise<boolean>
  removeConfirm: (s: any, r: any) => Promise<boolean> }
let asked: any = null
board.onAsk(async (q) => { asked = q; return false })
const state = (repo: any, archive?: string): any => ({ repos: [repo], features: [], tickets: [], agents: [], messages: [], reviews: [], attention: [], asks: [],
  settings: {}, defaults: {}, held: 0, ports: {}, previews: [], ...(archive === undefined ? {} : { archive }) })
const bodies = async (s: any, repo: any): Promise<string[]> => {
  await board.clearConfirm(s, repo); const clear = asked.body; await board.removeConfirm(s, repo); return [clear, asked.body]
}

test('the dialogs name the archive HQ was given, not ~/.hq/archive', async () => {
  const repo = { id: 'r1', name: 'garden' }
  const [clear, remove] = await bodies(state(repo, '/private/tmp/test-hq/archive'), repo)
  assert.match(clear, /a summary go to \/private\/tmp\/test-hq\/archive\/garden\/\./); assert.match(remove, /HQ's notes go to \/private\/tmp\/test-hq\/archive\/garden\/\./)
  for (const b of [clear, remove]) assert.doesNotMatch(b, /~\/\.hq/)
})

test("HQ's usual home still reads ~/.hq/archive/, and so does a page from before the backend said", async () => {
  const repo = { id: 'r1', name: 'garden' }
  for (const s of [state(repo, homeShort('/Users/someone/.hq/archive', '/Users/someone')), state(repo)]) {
    for (const b of await bodies(s, repo)) assert.match(b, / go to ~\/\.hq\/archive\/garden\/\./)
  }
})

test('a name with spaces or odd characters names the folder HQ makes for it', async () => {
  const repo = { id: 'r1', name: 'Recipe box (v2)' }
  for (const b of await bodies(state(repo, '~/.hq/archive'), repo)) assert.match(b, / go to ~\/\.hq\/archive\/Recipe-box-v2\/\./)
})

test("the folder the dialogs name is the one Remove really writes", async () => {
  for (const [id, name] of [['a1', 'Recipe box (v2)'], ['a2', 'plain-name.v1'], ['a3', '!!!']]) {
    run("INSERT INTO repos(id, name, path, kind, created_at) VALUES (?, ?, ?, 'local', ?)", id, name, path.join(os.tmpdir(), `hq-archwords-gone-${id}`), Date.now())
    const r = await removeRepo(id!)
    assert.equal(path.dirname(r.archive), path.join(PATHS.archive, archiveName(name!)), name)
  }
})

test('Bug 314: Clear says a Launch helper keeps going and that the app does not start again without an OK; with none it says nothing of one', async () => {
  const repo = { id: 'r1', name: 'garden' }, s = state(repo, '~/.hq/archive')
  const [plain] = await bodies(s, repo); assert.doesNotMatch(plain, /Claude keeps/)
  s.previews = [{ id: 'r1', status: 'stopped', helper_agent_id: 'launch-x', helper_state: 'working' }]
  const [helped] = await bodies(s, repo)
  assert.match(helped, /Claude keeps working out how to start garden's app \(start steps aren't part of the board\); the app doesn't start again without your OK\.$/)
})

test('homeShort: only the home folder itself becomes ~', () => {
  assert.equal(homeShort('/Users/k/.hq/archive', '/Users/k'), '~/.hq/archive')
  assert.equal(homeShort('/Users/k', '/Users/k'), '~')
  assert.equal(homeShort('/Users/kb/.hq/archive', '/Users/k'), '/Users/kb/.hq/archive') // another user's folder that starts the same
  assert.equal(homeShort('/tmp/x/Users/k/archive', '/Users/k'), '/tmp/x/Users/k/archive')
  assert.equal(homeShort('/Users/k/.hq/archive', undefined), '/Users/k/.hq/archive')
})

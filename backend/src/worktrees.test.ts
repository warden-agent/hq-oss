// Ticket worktree housekeeping against throwaway repos: stale Claude Code locks are cleared, nobody else's are; a merged
// ticket's worktree goes only when nothing in it would be lost.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { claudeLockPid, claudeRunning, listWorktrees, removeMerged, unlockStale } from './worktrees.ts'

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const DEAD = 999_999 // above macOS's pid limit: never running
const lockText = (key: string, pid: number) => `claude session ${key} (pid ${pid} start Thu Oct 22 01:38:44 2026)`
/** A repo with main and ticket worktrees under .claude/worktrees/ (one per key, on hq/f/<key>). */
function repo(...keys: string[]): { dir: string; wt: (k: string) => string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-wt-'))); sh(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n'); fs.writeFileSync(path.join(dir, 'a.txt'), '1'); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'base')
  const wt = (k: string) => path.join(dir, '.claude', 'worktrees', k)
  for (const k of keys) sh(dir, 'worktree', 'add', '-q', '-b', `hq/f/${k}`, wt(k))
  return { dir, wt }
}
const lockOf = async (dir: string, p: string) => (await listWorktrees(dir)).find((w) => w.path === p)?.locked

test('claudeLockPid reads only Claude Code\'s own lock text', () => {
  assert.equal(claudeLockPid('claude session PAN-1 (pid 12974 start Thu Oct 22 01:38:44 2026)'), 12974)
  assert.equal(claudeLockPid('kept by hand'), null); assert.equal(claudeLockPid(''), null); assert.equal(claudeLockPid(null), null)
})

test('claudeRunning: a live claude/node pid yes; a dead pid or another program no', async () => {
  assert.equal(await claudeRunning(process.pid), true) // node
  assert.equal(await claudeRunning(DEAD), false)
  const sleeper = spawn('sleep', ['5']); try { assert.equal(await claudeRunning(sleeper.pid!), false) } finally { sleeper.kill() } // a reused pid
})

test('listWorktrees: linked worktrees with branch and lock reason; the main checkout left out', async () => {
  const { dir, wt } = repo('T-1', 'T-2')
  sh(dir, 'worktree', 'lock', '--reason', lockText('T-1', DEAD), wt('T-1'))
  assert.deepEqual(await listWorktrees(dir), [{ path: wt('T-1'), branch: 'hq/f/T-1', locked: lockText('T-1', DEAD) }, { path: wt('T-2'), branch: 'hq/f/T-2', locked: null }])
})

test('unlockStale: a dead session\'s lock goes; a live one, someone else\'s, or one outside .claude/worktrees stays', async () => {
  const { dir, wt } = repo('DEAD', 'LIVE', 'MINE')
  const outside = path.join(path.dirname(dir), `${path.basename(dir)}-other`); sh(dir, 'worktree', 'add', '-q', '-b', 'other', outside)
  sh(dir, 'worktree', 'lock', '--reason', lockText('DEAD', DEAD), wt('DEAD'))
  sh(dir, 'worktree', 'lock', '--reason', lockText('LIVE', process.pid), wt('LIVE'))
  sh(dir, 'worktree', 'lock', '--reason', 'kept by hand', wt('MINE'))
  sh(dir, 'worktree', 'lock', '--reason', lockText('other', DEAD), outside)
  assert.deepEqual(await unlockStale(dir), [wt('DEAD')])
  assert.equal(await lockOf(dir, wt('DEAD')), null)
  assert.equal(await lockOf(dir, wt('LIVE')), lockText('LIVE', process.pid))
  assert.equal(await lockOf(dir, wt('MINE')), 'kept by hand')
  assert.equal(await lockOf(dir, outside), lockText('other', DEAD))
  assert.deepEqual(await unlockStale(dir), []) // nothing left to do
})

test('removeMerged: only a merged, clean worktree no live session holds; the branch stays', async () => {
  const { dir, wt } = repo('DONE', 'OPEN', 'DIRTY', 'HELD', 'STALE')
  const work = (k: string) => { fs.writeFileSync(path.join(wt(k), `${k}.txt`), k); sh(wt(k), 'add', '.'); sh(wt(k), 'commit', '-qm', k) }
  for (const k of ['DONE', 'OPEN', 'DIRTY', 'HELD', 'STALE']) work(k)
  for (const k of ['DONE', 'DIRTY', 'HELD', 'STALE']) sh(dir, 'merge', '-q', '--no-ff', '-m', `merge ${k}`, `hq/f/${k}`)
  fs.mkdirSync(path.join(wt('DONE'), 'node_modules', 'p'), { recursive: true }); fs.writeFileSync(path.join(wt('DONE'), 'node_modules', 'p', 'i.js'), '') // ignored: doesn't count
  fs.writeFileSync(path.join(wt('DIRTY'), 'notes.txt'), 'unsaved')
  sh(dir, 'worktree', 'lock', '--reason', lockText('HELD', process.pid), wt('HELD'))
  sh(dir, 'worktree', 'lock', '--reason', lockText('STALE', DEAD), wt('STALE'))
  assert.deepEqual(await removeMerged(dir, wt('DONE'), 'hq/f/DONE', 'main'), { removed: true })
  assert.equal(fs.existsSync(wt('DONE')), false); assert.match(sh(dir, 'branch', '--list', 'hq/f/DONE'), /hq\/f\/DONE/)
  assert.deepEqual(await removeMerged(dir, wt('OPEN'), 'hq/f/OPEN', 'main'), { removed: false, why: 'hq/f/OPEN is not in main' })
  assert.deepEqual(await removeMerged(dir, wt('DIRTY'), 'hq/f/DIRTY', 'main'), { removed: false, why: 'it has uncommitted changes or untracked files' })
  assert.deepEqual(await removeMerged(dir, wt('HELD'), 'hq/f/HELD', 'main'), { removed: false, why: `it is locked (${lockText('HELD', process.pid)})` })
  assert.deepEqual(await removeMerged(dir, wt('STALE'), 'hq/f/STALE', 'main'), { removed: true })
  assert.deepEqual(await removeMerged(dir, wt('OPEN'), 'hq/f/other', 'main'), { removed: false, why: 'it is on hq/f/OPEN, not hq/f/other' })
  for (const k of ['OPEN', 'DIRTY', 'HELD']) assert.equal(fs.existsSync(path.join(wt(k), `${k}.txt`)), true) // untouched
})

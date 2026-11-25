// Ticket worktree housekeeping against throwaway repos: stale Claude Code locks are cleared, nobody else's are; a merged
// ticket's worktree goes only when nothing in it would be lost.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { claudeLockPid, claudeRunning, copyPackages, copyTree, excludeLeftovers, listWorktrees, removeMerged, seedPackages, unlockStale } from './worktrees.ts'

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const DEAD = 999_999 // above macOS's pid limit: never running
const lockText = (key: string, pid: number) => `claude session ${key} (pid ${pid} start Thu Oct 22 15:38:44 2026)`
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
  assert.equal(claudeLockPid('claude session APP-1 (pid 12974 start Thu Oct 22 15:38:44 2026)'), 12974)
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

test('seedPackages (Bug 30): a new worktree gets main\'s node_modules at the root and in sub-packages; nothing else is touched', async () => {
  const { dir, wt } = repo()
  fs.mkdirSync(path.join(dir, 'web')); fs.mkdirSync(path.join(dir, 'docs')); for (const d of ['.', 'web']) fs.writeFileSync(path.join(dir, d, 'package.json'), '{}')
  fs.writeFileSync(path.join(dir, 'docs', 'x.md'), 'no package.json here')
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'packages'); sh(dir, 'worktree', 'add', '-q', '-b', 'hq/f/T-1', wt('T-1'))
  for (const d of ['.', 'web', 'docs']) {
    fs.mkdirSync(path.join(dir, d, 'node_modules', 'p'), { recursive: true }); fs.writeFileSync(path.join(dir, d, 'node_modules', 'p', 'i.js'), d)
    fs.writeFileSync(path.join(dir, d, 'node_modules', '.package-lock.json'), '{}') // a finished npm install (Bug 393)
  }
  const t = new Date('2026-01-02T03:04:05Z'); fs.utimesSync(path.join(dir, 'node_modules', 'p', 'i.js'), t, t)
  assert.deepEqual(await seedPackages(dir, wt('T-1')), ['.', 'web'])
  assert.equal(fs.readFileSync(path.join(wt('T-1'), 'web', 'node_modules', 'p', 'i.js'), 'utf8'), 'web')
  assert.equal(fs.statSync(path.join(wt('T-1'), 'node_modules', 'p', 'i.js')).mtimeMs, t.getTime(), 'times kept, so the install check sees it as current')
  assert.ok(!fs.existsSync(path.join(wt('T-1'), 'docs', 'node_modules')), 'no package.json: left alone')
  assert.equal(sh(wt('T-1'), 'status', '--porcelain'), '', 'ignored: nothing new to commit')
  fs.writeFileSync(path.join(wt('T-1'), 'node_modules', 'p', 'i.js'), 'mine')
  assert.deepEqual(await seedPackages(dir, wt('T-1')), [], 'a worktree that has packages keeps them')
  assert.equal(fs.readFileSync(path.join(wt('T-1'), 'node_modules', 'p', 'i.js'), 'utf8'), 'mine')
})

test('seedPackages: no copy when git doesn\'t ignore node_modules there, or main has none', async () => {
  const { dir, wt } = repo(); fs.writeFileSync(path.join(dir, '.gitignore'), ''); fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'not ignored'); sh(dir, 'worktree', 'add', '-q', '-b', 'hq/f/T-1', wt('T-1'))
  assert.deepEqual(await seedPackages(dir, wt('T-1')), [], 'main has none')
  fs.mkdirSync(path.join(dir, 'node_modules')); fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), '{}')
  assert.deepEqual(await seedPackages(dir, wt('T-1')), [], 'would show up as new files')
  assert.ok(!fs.existsSync(path.join(wt('T-1'), 'node_modules')))
})

/** Main's node_modules for Bug 393: a package with a program in .bin, and the tool's last file when `done` names it. */
function installed(nm: string, done: string | null): void {
  fs.mkdirSync(path.join(nm, 'vite'), { recursive: true }); fs.mkdirSync(path.join(nm, '.bin'), { recursive: true }); fs.writeFileSync(path.join(nm, 'vite', 'index.js'), 'v')
  fs.writeFileSync(path.join(nm, '.bin', 'vite'), 'v'); const old = new Date(Date.now() - 60_000); fs.utimesSync(path.join(nm, '.bin'), old, old)
  if (done) fs.writeFileSync(path.join(nm, done), '{}')
}
test('seedPackages (Bug 393): main\'s node_modules is copied only as a finished install left it, for npm, Yarn 1 and 2+, pnpm; Bun\'s as before', async () => {
  const { dir, wt } = repo(); fs.writeFileSync(path.join(dir, 'package.json'), '{}'); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'pkg')
  let n = 0; const fresh = () => { const w = wt(`T-${++n}`); sh(dir, 'worktree', 'add', '-q', '-b', `hq/f/T-${n}`, w); return w }
  const nm = path.join(dir, 'node_modules')
  installed(nm, null); let w = fresh()
  assert.deepEqual(await seedPackages(dir, w), [], 'no record: an install is filling it (npm ci deletes the record first and writes it last)')
  assert.ok(!fs.existsSync(path.join(w, 'node_modules')), 'nothing copied: the look sees no node_modules and installs its own (smoke.ts installs)')
  for (const done of ['.package-lock.json', '.yarn-integrity', '.yarn-state.yml', '.modules.yaml']) {
    fs.rmSync(nm, { recursive: true }); installed(nm, done); w = fresh()
    assert.deepEqual(await seedPackages(dir, w), ['.'], done); assert.ok(fs.existsSync(path.join(w, 'node_modules', 'vite', 'index.js')), done)
  }
  const later = new Date(Date.now() + 5_000); fs.utimesSync(path.join(nm, '.bin'), later, later); w = fresh()
  assert.deepEqual(await seedPackages(dir, w), [], 'its programs changed after the last file: pnpm (or npm adding a package) is still at work')
  fs.rmSync(nm, { recursive: true }); installed(nm, null); fs.writeFileSync(path.join(dir, 'bun.lock'), '{}'); w = fresh()
  assert.deepEqual(await seedPackages(dir, w), ['.'], 'Bun writes no such file: copied as before')
})
test('copyPackages (Bug 393): an install that starts during the copy takes the copy away; a workspace member counts on the root\'s install', async () => {
  const { dir, wt } = repo(); const nm = path.join(dir, 'node_modules'); installed(nm, '.package-lock.json')
  const to = path.join(wt('X'), 'node_modules'); fs.mkdirSync(wt('X'), { recursive: true })
  const npmCi = async (from: string, dest: string) => { await copyTree(from, dest); fs.rmSync(path.join(nm, '.package-lock.json')) } // npm ci began meanwhile
  assert.equal(await copyPackages(dir, '.', to, npmCi), false); assert.ok(!fs.existsSync(to), 'the half copy is gone')
  installed(nm, '.package-lock.json')
  const doneAgain = async (from: string, dest: string) => { await copyTree(from, dest); fs.rmSync(path.join(nm, '.package-lock.json')); fs.writeFileSync(path.join(nm, '.package-lock.json'), '{}') }
  assert.equal(await copyPackages(dir, '.', to, doneAgain), false, 'a whole install ran during the copy: its file is new'); assert.ok(!fs.existsSync(to))
  assert.equal(await copyPackages(dir, '.', to), true); assert.ok(fs.existsSync(path.join(to, '.package-lock.json')))
  fs.mkdirSync(path.join(dir, 'web', 'node_modules', 'x'), { recursive: true }); fs.writeFileSync(path.join(dir, 'web', 'package.json'), '{}')
  const webTo = path.join(wt('X'), 'web', 'node_modules'); fs.mkdirSync(path.dirname(webTo), { recursive: true })
  assert.equal(await copyPackages(dir, 'web', webTo), false, 'not a workspace: web has no install of its own that finished')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ workspaces: ['web'] }))
  assert.equal(await copyPackages(dir, 'web', webTo), true, 'a member: the root\'s finished install filled it')
  fs.rmSync(webTo, { recursive: true }); fs.rmSync(path.join(nm, '.package-lock.json'))
  assert.equal(await copyPackages(dir, 'web', webTo), false, 'and the root\'s install under way')
})

test('excludeLeftovers (Bug 263): an install\'s files never show in git status, in the checkout or its worktrees; ignored or tracked ones are left alone', async () => {
  const { dir, wt } = repo('T-1') // its .gitignore covers node_modules/
  fs.mkdirSync(path.join(dir, '.yarn', 'cache'), { recursive: true }); fs.writeFileSync(path.join(dir, '.yarn', 'cache', 'ms.zip'), 'z') // zero-install: the cache is committed
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'cache')
  const rels = ['node_modules/', '.pnp.cjs', '.pnp.loader.mjs', '.yarn/install-state.gz', '.yarn/cache/', '.yarn/unplugged/']
  assert.deepEqual(await excludeLeftovers(dir, rels), ['/.pnp.cjs', '/.pnp.loader.mjs', '/.yarn/install-state.gz', '/.yarn/unplugged/'])
  const install = (at: string) => { // what Yarn 4 leaves after `yarn install --immutable` (checked on 4.5.3)
    for (const f of ['.pnp.cjs', '.yarn/install-state.gz', '.yarn/unplugged/x/index.js', 'node_modules/ms/index.js']) {
      fs.mkdirSync(path.dirname(path.join(at, f)), { recursive: true }); fs.writeFileSync(path.join(at, f), 'x')
    }
  }
  install(dir); install(wt('T-1'))
  assert.equal(sh(dir, 'status', '--porcelain', '--untracked-files=all'), '')
  assert.equal(sh(wt('T-1'), 'status', '--porcelain', '--untracked-files=all'), '', 'a ticket worktree shares the exclude')
  fs.writeFileSync(path.join(dir, '.yarn', 'cache', 'new.zip'), 'z') // a zero-install project's new package still shows, to be committed
  assert.equal(sh(dir, 'status', '--porcelain', '--untracked-files=all'), '?? .yarn/cache/new.zip')
  assert.deepEqual(await excludeLeftovers(dir, rels), [], 'already covered: nothing added twice')
  fs.mkdirSync(path.join(dir, 'web')); fs.writeFileSync(path.join(dir, 'web', 'package.json'), '{}')
  assert.deepEqual(await excludeLeftovers(path.join(dir, 'web'), ['.pnp.cjs']), ['/web/.pnp.cjs']) // a checkout below the repo's top: anchored there
  const excl = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')
  assert.equal(excl.split('\n').filter((l) => l === '/.pnp.cjs').length, 1); assert.match(excl, /^\/web\/\.pnp\.cjs$/m)
  assert.deepEqual(await excludeLeftovers(dir, []), [])
})

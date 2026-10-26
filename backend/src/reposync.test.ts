// Sync rules against throwaway repos: a local bare repo stands in for GitHub (origin URL is a github.com URL, fetchUrl points at the bare repo).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseGithubRemote, syncCheckout, repoRoot, findRepos, branchMerged } from './reposync.ts'

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hq-sync-'))
const opts = (fetchUrl: string) => ({ ghConfigDir: '/nonexistent', account: 'warden-agent', fetchUrl })

/** Bare "GitHub" repo with one commit on main, and a clone of it whose origin claims to be github.com/o/r. */
function setup(): { bare: string; clone: string; push: (msg: string) => string } {
  const root = tmp(); const bare = path.join(root, 'r.git'); const seed = path.join(root, 'seed'); const clone = path.join(root, 'clone')
  sh(root, 'init', '--bare', '-b', 'main', bare); sh(root, 'init', '-b', 'main', seed)
  const push = (msg: string) => { fs.writeFileSync(path.join(seed, 'f.txt'), msg); sh(seed, 'add', '.'); sh(seed, 'commit', '-m', msg); sh(seed, 'push', bare, 'main'); return sh(seed, 'rev-parse', 'HEAD') }
  push('one'); sh(root, 'clone', bare, clone); sh(clone, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git')
  return { bare, clone, push }
}

test('parseGithubRemote', () => {
  assert.equal(parseGithubRemote('https://github.com/warden-agent/hq.git'), 'warden-agent/hq')
  assert.equal(parseGithubRemote('https://github.com/warden-agent/hq'), 'warden-agent/hq')
  assert.equal(parseGithubRemote('https://x-token@github.com/o/r.git'), 'o/r')
  assert.equal(parseGithubRemote('git@github.com:o/my.repo.git'), 'o/my.repo')
  assert.equal(parseGithubRemote('ssh://git@github.com/o/r'), 'o/r')
  assert.equal(parseGithubRemote('https://gitlab.com/o/r.git'), null)
  assert.equal(parseGithubRemote(''), null)
})

test('not a git repo / missing path is refused', async () => {
  await assert.rejects(repoRoot(path.join(tmp(), 'nope')), /does not exist/)
  await assert.rejects(repoRoot(tmp()), /not a git repository/)
})

test('findRepos: the repo, a subfolder of it, or a plain wrapper folder around it', async () => {
  const w = fs.realpathSync(tmp()) // git reports real paths (/private/var/…)
  const mk = (dir: string, origin?: string) => { fs.mkdirSync(dir, { recursive: true }); sh(dir, 'init', '-b', 'main'); if (origin) sh(dir, 'remote', 'add', 'origin', origin); return dir }
  const app = mk(path.join(w, 'app'), 'git@github.com:o/app.git'); fs.mkdirSync(path.join(app, 'src'))
  const one = [{ path: app, name: 'app', github: 'o/app' }]
  assert.deepEqual(await findRepos(app), one)
  assert.deepEqual(await findRepos(path.join(app, 'src')), one)
  fs.mkdirSync(path.join(w, 'notes')) // plain sibling folder: ignored
  assert.deepEqual(await findRepos(w), one)
  const alpha = mk(path.join(w, 'alpha'))
  assert.deepEqual(await findRepos(w), [...one, { path: alpha, name: 'alpha', github: null }]) // GitHub first, then by name
  const skip = fs.realpathSync(tmp()); mk(path.join(skip, '.cache')); mk(path.join(skip, 'node_modules'))
  assert.deepEqual(await findRepos(skip), [])
  assert.deepEqual(await findRepos(tmp()), [])
  await assert.rejects(findRepos(path.join(tmp(), 'nope')), /does not exist/)
})

test('branchMerged: yes after a merge commit, no before; unknown branch is no', async () => {
  const d = tmp(); sh(d, 'init', '-b', 'main'); fs.writeFileSync(path.join(d, 'a'), '1'); sh(d, 'add', '.'); sh(d, 'commit', '-m', 'one')
  sh(d, 'checkout', '-b', 'hq/f/T-1'); fs.writeFileSync(path.join(d, 'b'), '1'); sh(d, 'add', '.'); sh(d, 'commit', '-m', 'work'); sh(d, 'checkout', 'main')
  assert.equal(await branchMerged(d, 'hq/f/T-1', 'refs/heads/main'), false)
  sh(d, 'merge', '--no-ff', '-m', 'merge', 'hq/f/T-1')
  assert.equal(await branchMerged(d, 'hq/f/T-1', 'refs/heads/main'), true)
  assert.equal(await branchMerged(d, 'nope', 'refs/heads/main'), false)
})

test('no remote → local, no network', async () => {
  const d = tmp(); sh(d, 'init', '-b', 'trunk'); fs.writeFileSync(path.join(d, 'a'), 'a'); sh(d, 'add', '.'); sh(d, 'commit', '-m', 'a')
  const r = await syncCheckout(d, opts('/nonexistent'))
  assert.equal(r.kind, 'local'); assert.equal(r.ok, true); assert.equal(r.defaultBranch, 'trunk'); assert.equal(r.remote, null)
})

test('non-GitHub origin → local', async () => {
  const { clone } = setup(); sh(clone, 'remote', 'set-url', 'origin', 'https://gitlab.com/o/r.git')
  const r = await syncCheckout(clone, opts('/nonexistent')); assert.equal(r.kind, 'local')
})

test('already up to date', async () => {
  const { bare, clone } = setup()
  const r = await syncCheckout(clone, opts(bare))
  assert.equal(r.status, 'up_to_date'); assert.equal(r.defaultBranch, 'main'); assert.equal(sh(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main')
})

test('behind on clean main → fast-forward pulled', async () => {
  const { bare, clone, push } = setup(); const two = push('two')
  const r = await syncCheckout(clone, opts(bare))
  assert.equal(r.status, 'pulled'); assert.equal(r.head, two); assert.equal(sh(clone, 'rev-parse', 'main'), two)
  assert.equal(fs.readFileSync(path.join(clone, 'f.txt'), 'utf8'), 'two')
})

test('behind on dirty main → fetched, working tree untouched', async () => {
  const { bare, clone, push } = setup(); const two = push('two'); fs.writeFileSync(path.join(clone, 'f.txt'), 'my edit')
  const r = await syncCheckout(clone, opts(bare))
  assert.equal(r.status, 'fetched'); assert.match(r.detail, /uncommitted/); assert.equal(sh(clone, 'rev-parse', 'origin/main'), two)
  assert.notEqual(sh(clone, 'rev-parse', 'main'), two); assert.equal(fs.readFileSync(path.join(clone, 'f.txt'), 'utf8'), 'my edit')
})

test('on another branch → local main ref moved, checkout untouched', async () => {
  const { bare, clone, push } = setup(); sh(clone, 'checkout', '-b', 'mine'); fs.writeFileSync(path.join(clone, 'wip'), 'x'); const two = push('two')
  const r = await syncCheckout(clone, opts(bare))
  assert.equal(r.status, 'pulled'); assert.equal(sh(clone, 'rev-parse', 'main'), two)
  assert.equal(sh(clone, 'symbolic-ref', '--short', 'HEAD'), 'mine'); assert.equal(fs.readFileSync(path.join(clone, 'f.txt'), 'utf8'), 'one'); assert.ok(fs.existsSync(path.join(clone, 'wip')))
})

test('diverged local main → fetched, not pulled', async () => {
  const { bare, clone, push } = setup(); fs.writeFileSync(path.join(clone, 'local'), 'l'); sh(clone, 'add', '.'); sh(clone, 'commit', '-m', 'local'); const mine = sh(clone, 'rev-parse', 'HEAD'); push('two')
  const r = await syncCheckout(clone, opts(bare))
  assert.equal(r.status, 'fetched'); assert.match(r.detail, /commits not on GitHub/); assert.equal(sh(clone, 'rev-parse', 'main'), mine)
})

test('unreachable GitHub → error, ok false, nothing changed', async () => {
  const { clone } = setup(); const before = sh(clone, 'rev-parse', 'main')
  const r = await syncCheckout(clone, opts(path.join(tmp(), 'missing.git')))
  assert.equal(r.ok, false); assert.equal(r.status, 'error'); assert.equal(r.kind, 'github'); assert.equal(sh(clone, 'rev-parse', 'main'), before)
})

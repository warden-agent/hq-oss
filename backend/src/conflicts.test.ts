// Who merged first (git + HQ's records in a temp HQ_HOME) and the wording of HQ's fix instructions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-conflicts-'))
const { migrate, run } = await import('./db.ts')
migrate()
const { fixConflictsText, mergeBase, whoMergedFirst } = await import('./conflicts.ts')
const { getRepo, getTicket, localOnly, syncBlocks, usesGithub } = await import('./records.ts')

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-who-')))
const write = (f: string, s: string) => fs.writeFileSync(path.join(d, f), s)
sh(d, 'init', '-q', '-b', 'main'); write('app.js', 'a\n'); write('README.md', 'r\n'); write('old.txt', 'o\n'); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'base')
const branch = (name: string, f: string, s: string, from = 'main') => { sh(d, 'checkout', '-qb', name, from); write(f, s); sh(d, 'commit', '-qam', name); sh(d, 'checkout', '-q', 'main') }
branch('b/OLD', 'old.txt', 'older\n'); sh(d, 'merge', '-q', '--no-ff', '--no-edit', 'b/OLD') // merged before INV forked: not a suspect
branch('b/INV', 'app.js', 'a\ninv\n')
branch('b/ORD', 'app.js', 'a\nord\n'); branch('b/DOCS', 'README.md', 'docs\n') // both merge after INV forked; only ORD touches app.js
sh(d, 'merge', '-q', '--no-ff', '--no-edit', 'b/ORD'); sh(d, 'merge', '-q', '--no-ff', '--no-edit', 'b/DOCS')
const now = Date.now()
run("INSERT INTO repos(id, name, path, kind, default_branch, created_at) VALUES ('r1', 'demo', ?, 'local', 'main', ?), ('r2', 'other', '/tmp/x', 'local', 'main', ?)", d, now, now)
for (const [id, repo] of [['f1', 'r1'], ['f2', 'r1'], ['f3', 'r2']]) {
  run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', 'planning', ?, ?)", id!, repo!, id!, id!, now, now)
}
const tk = (id: string, f: string, key: string, status: string, br: string | null, at = now) =>
  run('INSERT INTO tickets(id, feature_id, key, slug, title, size, status, branch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, f, key, key, `${key} title`, 'S', status, br, at, at)
tk('shop', 'f1', 'invoices', 'pr_ready', 'b/INV'); tk('rec', 'f2', 'orders', 'merged', 'b/ORD', now + 2) // another feature, same repo
tk('docs', 'f1', 'docs', 'merged', 'b/DOCS', now + 3); tk('old', 'f1', 'old', 'merged', 'b/OLD', now + 1); tk('gone', 'f1', 'gone', 'merged', 'b/GONE')
tk('elsewhere', 'f3', 'elsewhere', 'merged', 'b/ORD') // another repo entirely

test('whoMergedFirst: merged tickets of the same repo that changed a conflicting file after the branch forked', async () => {
  const repo = getRepo('r1')!, shop = getTicket('shop')!
  assert.deepEqual(await whoMergedFirst(repo, shop, ['app.js'], 'refs/heads/main'), ['orders'])
  assert.deepEqual(await whoMergedFirst(repo, shop, ['README.md', 'app.js'], 'refs/heads/main'), ['orders', 'docs']) // oldest merge first
  assert.deepEqual(await whoMergedFirst(repo, shop, ['old.txt'], 'refs/heads/main'), []) // OLD was in main before INV forked
  assert.deepEqual(await whoMergedFirst(repo, shop, ['nothing.txt'], 'refs/heads/main'), [])
  sh(d, 'checkout', '-q', 'b/INV'); sh(d, 'merge', '-q', '--no-edit', '-X', 'ours', 'main'); sh(d, 'checkout', '-q', 'main') // main merged in: nobody is to blame
  assert.deepEqual(await whoMergedFirst(repo, shop, ['app.js'], 'refs/heads/main'), [])
})

test('mergeBase: main locally, origin/main on GitHub, main again on a GitHub repo HQ can\'t push to', () => {
  const gh = { ...getRepo('r1')!, kind: 'github' as const, remote: 'https://github.com/o/r.git' }
  assert.deepEqual(mergeBase({ ...getRepo('r1')! }), { name: 'main', ref: 'refs/heads/main' })
  assert.deepEqual(mergeBase(gh), { name: 'origin/main', ref: 'refs/remotes/origin/main' })
  assert.deepEqual(mergeBase({ ...gh, can_push: 1 }), { name: 'origin/main', ref: 'refs/remotes/origin/main' })
  assert.deepEqual(mergeBase({ ...gh, can_push: 0 }), { name: 'main', ref: 'refs/heads/main' })
})

test('usesGithub / localOnly: GitHub unless HQ is known not to be able to push', () => {
  const gh = { ...getRepo('r1')!, kind: 'github' as const, remote: 'https://github.com/o/r.git' }
  const cases: [Parameters<typeof usesGithub>[0], boolean, boolean][] = [
    [getRepo('r1')!, false, false], // local
    [{ ...gh, can_push: 1 }, true, false],
    [{ ...gh, can_push: null }, true, false], // GitHub couldn't be asked: as before
    [{ ...gh, can_push: 0 }, false, true],
    [{ ...gh, remote: 'git@gitlab.com:o/r.git' }, false, false],
  ]
  for (const [r, uses, local] of cases) assert.deepEqual([usesGithub(r), localOnly(r)], [uses, local], JSON.stringify([r.kind, r.remote, r.can_push]))
})

test('syncBlocks: a GitHub repo that failed to sync blocks launches, even one never synced (no remote yet); a local-only one does not', () => {
  const gh = { ...getRepo('r1')!, kind: 'github' as const, remote: 'https://github.com/o/r.git', sync_ok: 0 }
  assert.equal(syncBlocks(gh), true)
  assert.equal(syncBlocks({ ...gh, remote: null, can_push: null }), true) // first fetch failed: no access at all
  assert.equal(syncBlocks({ ...gh, can_push: 0 }), false)
  assert.equal(syncBlocks({ ...gh, sync_ok: 1 }), false)
  assert.equal(syncBlocks({ ...getRepo('r1')!, sync_ok: 0 }), false) // local
})

test('fixConflictsText: the steps, who merged first, a merge in progress, a fresh engineer, nothing left to resolve', () => {
  const t = getTicket('shop')!
  const msg = fixConflictsText({ t, base: 'main', files: ['README.md', 'src/app.js'], merged: ['orders'], inProgress: false })
  assert.equal(msg, `HQ: main has moved on since you finished invoices. orders merged first, and now b/INV conflicts with main in README.md, src/app.js. Fix it now, in your worktree:
1. git merge --no-edit main (merge, never rebase, never push).
2. In each conflicted file keep both sides' intent: your ticket's change and theirs.
3. Run the tests.
4. Commit the merge (if git made one already, there is nothing to commit).
5. Call update_handoff(kind: before_pr) saying what you kept.
6. Call open_pr again with the same title and body, keeping the "## Deviations from approved plan" section.
If you can't keep both, call report_blocked and say why.`)
  const gh = fixConflictsText({ t, base: 'origin/main', files: ['a'], merged: [], inProgress: true, launch: { worktree: '/w/invoices' } })
  assert.match(gh, /^You are the engineer for ticket invoices \(S\): invoices title\. Its work is already finished and committed on branch b\/INV in your worktree \/w\/invoices; call get_ticket/)
  assert.match(gh, /HQ: main has moved on since you finished invoices\. Now b\/INV conflicts with origin\/main in a\./)
  assert.match(gh, /\n1\. A merge is already in progress in your worktree: finish it/)
  const clean = fixConflictsText({ t, base: 'main', files: [], merged: [], inProgress: false })
  assert.match(clean, /it already merges cleanly with main now/); assert.doesNotMatch(clean, /conflicted file/); assert.match(clean, /\n5\. Call open_pr again/)
  const many = fixConflictsText({ t, base: 'main', files: Array.from({ length: 25 }, (_, i) => `f${i}`), merged: [], inProgress: false })
  assert.match(many, /f19 and 5 more\./)
})

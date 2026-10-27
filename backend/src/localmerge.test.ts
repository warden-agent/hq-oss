// Merge into main against throwaway repos: every refusal leaves the checkout exactly as it was; a merge is one commit with
// both parents and the given message, and the branch is kept.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { conflictsWith, mergeIntoMain } from './localmerge.ts'

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Sam'; process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'k@x'
const B = 'hq/kl/PAN-1-api'
/** main (a.txt, keep.txt) and branch B adding api.txt; `ours`/`theirs` change things on main / on B. */
function repo(o: { theirs?: (d: string) => void; ours?: (d: string) => void } = {}): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-merge-'))); sh(d, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(d, '.gitignore'), 'data/\n'); fs.writeFileSync(path.join(d, 'a.txt'), 'one\n'); fs.writeFileSync(path.join(d, 'keep.txt'), 'keep\n')
  sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'base')
  sh(d, 'checkout', '-qb', B); fs.writeFileSync(path.join(d, 'api.txt'), 'api\n'); o.theirs?.(d); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'api')
  sh(d, 'checkout', '-q', 'main'); if (o.ours) { o.ours(d); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'main moved') }
  return d
}
const opts = { branch: B, into: 'main', subject: 'Merge PAN-1: Kitchen items API', body: ['Adds the API.\n\n## Deviations from approved plan\nNone', `HQ ticket PAN-1 · ${B}`] }
/** HEAD, status and file contents: what "nothing changed" means. */
const snap = (d: string) => ({ head: sh(d, 'rev-parse', 'HEAD'), branch: sh(d, 'rev-parse', '--abbrev-ref', 'HEAD'), status: sh(d, 'status', '--porcelain'), files: fs.readdirSync(d).filter((f) => f !== '.git').sort().map((f) => [f, fs.statSync(path.join(d, f)).isFile() ? fs.readFileSync(path.join(d, f), 'utf8') : 'dir']) })
async function refused(d: string, why: RegExp): Promise<void> {
  const before = snap(d); const r = await mergeIntoMain(d, opts)
  assert.equal(r.ok, false); assert.match((r as { why: string }).why, why); assert.deepEqual(snap(d), before)
  assert.equal(fs.existsSync(path.join(d, '.git', 'MERGE_HEAD')), false)
}

test('a clean merge: one commit, both parents, the message as given, main and the files moved together, branch kept', async () => {
  const d = repo({ ours: (x) => fs.writeFileSync(path.join(x, 'c.txt'), 'main\n') })
  fs.mkdirSync(path.join(d, 'data')); fs.writeFileSync(path.join(d, 'data', 'items.json'), '[]') // ignored (the running app's data) doesn't block
  fs.writeFileSync(path.join(d, 'notes.txt'), 'mine') // nor does an untracked file the merge doesn't touch
  const main = sh(d, 'rev-parse', 'main'), tip = sh(d, 'rev-parse', B)
  const r = await mergeIntoMain(d, opts); assert.equal(r.ok, true)
  const { sha, already } = r as { sha: string; already: boolean }
  assert.equal(already, false); assert.equal(sh(d, 'rev-parse', 'HEAD'), sha); assert.equal(sh(d, 'rev-parse', 'main'), sha)
  assert.equal(sh(d, 'log', '-1', '--format=%P', sha), `${main} ${tip}`)
  assert.equal(sh(d, 'log', '-1', '--format=%B', sha), `Merge PAN-1: Kitchen items API\n\nAdds the API.\n\n## Deviations from approved plan\nNone\n\nHQ ticket PAN-1 · ${B}`)
  assert.equal(sh(d, 'log', '-1', '--format=%an', sha), 'Sam')
  assert.equal(fs.readFileSync(path.join(d, 'api.txt'), 'utf8'), 'api\n'); assert.equal(fs.readFileSync(path.join(d, 'c.txt'), 'utf8'), 'main\n')
  assert.equal(sh(d, 'status', '--porcelain'), '?? notes.txt'); assert.equal(fs.readFileSync(path.join(d, 'data', 'items.json'), 'utf8'), '[]')
  assert.match(sh(d, 'branch', '--list', B), /PAN-1/)
  const again = await mergeIntoMain(d, opts); assert.deepEqual(again, { ok: true, sha, already: true }) // already in main: nothing to do
})

test('refusals leave everything as it was', async () => {
  { const d = repo(); sh(d, 'checkout', '-qb', 'experiment'); await refused(d, /is on branch experiment, not main\. Switch it back \(git switch main\) and press Merge again\.$/) }
  { const d = repo(); sh(d, 'checkout', '-q', '--detach'); await refused(d, /is on a detached HEAD, not main/) }
  { const d = repo(); fs.writeFileSync(path.join(d, 'a.txt'), 'edited\n'); await refused(d, /has uncommitted changes in a\.txt\. Commit or stash them/) }
  { const d = repo(); fs.writeFileSync(path.join(d, 'keep.txt'), 'staged\n'); sh(d, 'add', 'keep.txt'); await refused(d, /uncommitted changes in keep\.txt/) }
  { const d = repo({ theirs: (x) => fs.writeFileSync(path.join(x, 'a.txt'), 'theirs\n'), ours: (x) => fs.writeFileSync(path.join(x, 'a.txt'), 'ours\n') })
    const rest = 'Press Fix conflicts to have its engineer merge main in, or merge it by hand; HQ notices within 2 minutes\\.$'
    await refused(d, new RegExp(`^${B.replace(/\//g, '\\/')} conflicts with main in a\\.txt\\. Nothing was changed\\. ${rest}`))
    assert.deepEqual(((await mergeIntoMain(d, opts)) as { conflicts?: string[] }).conflicts, ['a.txt']) }
  { const d = repo({ theirs: (x) => fs.rmSync(path.join(x, 'keep.txt')), ours: (x) => fs.writeFileSync(path.join(x, 'keep.txt'), 'changed\n') }); await refused(d, /conflicts with main in keep\.txt/) }
  { const d = repo(); fs.writeFileSync(path.join(d, 'api.txt'), 'my own\n') // untracked, and the merge would bring a tracked api.txt
    await refused(d, /would overwrite files in .* that git doesn't track: api\.txt\. Move them away/); assert.equal(fs.readFileSync(path.join(d, 'api.txt'), 'utf8'), 'my own\n') }
  { const d = repo({ theirs: (x) => fs.writeFileSync(path.join(x, 'a.txt'), 'theirs\n'), ours: (x) => fs.writeFileSync(path.join(x, 'a.txt'), 'ours\n') })
    try { sh(d, 'merge', B) } catch { /* conflict: a merge is now in progress */ }
    const r = await mergeIntoMain(d, opts); assert.deepEqual(r, { ok: false, why: `A merge is in progress in ${path.basename(d)}. Finish or abort it, then press Merge again.` }) }
})

test('a missing branch is refused', async () => {
  const d = repo(); assert.deepEqual(await mergeIntoMain(d, { ...opts, branch: 'nope' }), { ok: false, why: "Branch nope is gone, so there's nothing to merge." })
})

test('conflictsWith: [] when it merges cleanly, the files when it conflicts (all of them), null when git can\'t tell', async () => {
  const clean = repo({ ours: (x) => fs.writeFileSync(path.join(x, 'c.txt'), 'main\n') })
  assert.deepEqual(await conflictsWith(clean, 'main', B), [])
  const both = (x: string, s: string) => { for (const f of ['a.txt', 'keep.txt', 'b1.txt', 'b2.txt', 'b3.txt', 'b4.txt']) fs.writeFileSync(path.join(x, f), `${s}\n`) }
  const d = repo({ theirs: (x) => both(x, 'theirs'), ours: (x) => both(x, 'ours') })
  assert.deepEqual(await conflictsWith(d, 'main', B), ['a.txt', 'b1.txt', 'b2.txt', 'b3.txt', 'b4.txt', 'keep.txt'])
  const head = sh(d, 'rev-parse', 'HEAD'); assert.equal(sh(d, 'status', '--porcelain'), ''); assert.equal(sh(d, 'rev-parse', 'HEAD'), head) // nothing touched
  assert.equal(await conflictsWith(d, 'main', 'no-such-branch'), null)
})

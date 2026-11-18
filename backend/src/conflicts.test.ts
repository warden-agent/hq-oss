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
const { changeText, fixButton, fixConflictsText, fixTestsText, fixWords, forTests, keepTestsFailed, mergeBase, stalledKind, testsFailed, whoMergedFirst } = await import('./conflicts.ts')
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
  // Bug 210: a project whose default branch is master says master, locally and on GitHub
  assert.match(fixConflictsText({ t, base: 'origin/master', files: ['a'], merged: [], inProgress: false }),
    /HQ: master has moved on since you finished invoices\. Now b\/INV conflicts with origin\/master in a\.[\s\S]*git merge --no-edit origin\/master/)
  assert.match(fixConflictsText({ t, base: 'master', files: ['a'], merged: [], inProgress: false }), /HQ: master has moved on since you finished invoices\./)
  const clean = fixConflictsText({ t, base: 'main', files: [], merged: [], inProgress: false })
  assert.match(clean, /it already merges cleanly with main now/); assert.doesNotMatch(clean, /conflicted file/); assert.match(clean, /\n5\. Call open_pr again/)
  const many = fixConflictsText({ t, base: 'main', files: Array.from({ length: 25 }, (_, i) => `f${i}`), merged: [], inProgress: false })
  assert.match(many, /f19 and 5 more\./)
})

test('fixTestsText (Bug 82): what failed early is kept with the end of the output, and a run that never finished says so', () => {
  const t = getTicket('shop')!, passing = Array.from({ length: 300 }, (_, i) => `  ✔ case ${i} passes (1ms)`).join('\n')
  const failed = { kind: 'fail' as const, test: 'npm test', output: `${passing}\nℹ fail 1`, earlier: "Error: Cannot find module 'jsdom'" }
  const text = fixTestsText({ t, base: 'main', failed })
  assert.match(text, /fails its tests, so HQ didn't merge it/); assert.match(text, /Error: Cannot find module 'jsdom'/); assert.match(text, /ℹ fail 1\n\nFix it now/)
  assert.match(text, /Run `npm test` and fix what fails/); assert.ok(text.length < 5500, String(text.length))
  const hung = fixTestsText({ t, base: 'main', failed: { ...failed, earlier: '', hung: true } })
  assert.match(hung, /never finished its tests: HQ stopped `npm test` after 15 minutes/); assert.doesNotMatch(hung, /fails its tests/)
  assert.match(hung, /find what never finishes and fix it/); assert.match(hung, /ℹ fail 1\n\nFix it now/)
})

test('Bug 84: what the tests printed is kept for an engineer that takes over, and a note stands in when it\'s gone', () => {
  const t = getTicket('shop')!, failed = { kind: 'fail' as const, test: 'npm test', output: 'ℹ fail 1', earlier: "Error: Cannot find module 'jsdom'", hung: true }
  assert.match(testsFailed({ ...t, fixing: 'tests_hung' }, 'npm run check').output, /doesn't have what they printed/)
  assert.equal(testsFailed({ ...t, fixing: 'tests_hung' }, 'npm run check').test, 'npm run check'); assert.equal(testsFailed({ ...t, fixing: 'tests_hung' }, null).hung, true)
  keepTestsFailed(t, failed); assert.deepEqual(testsFailed(t, 'other'), failed)
  keepTestsFailed(t, { ...failed, output: 'second', hung: false }); assert.equal(testsFailed(t, null).output, 'second') // the latest failure, not the first
  assert.deepEqual(fixWords(null, 'main'), { to: 'merge main in and fix its conflicts', ing: 'fixing its conflicts with main' })
  assert.equal(fixWords('tests', 'origin/main').ing, 'fixing its tests on origin/main')
})

test('a finished ticket whose spec changed: its own words, notice and instructions, apart from tests and conflicts', () => {
  assert.deepEqual(fixWords('changes', 'main'), { to: 'build the change to its spec', ing: 'building the change to its spec' })
  assert.deepEqual(['changes', 'tests', 'tests_hung', null].map((f) => forTests(f as never)), [false, true, true, false])
  assert.deepEqual(['changes', 'tests', 'tests_hung', null].map((f) => stalledKind(f as never)), ['change_stalled', 'fix_stalled', 'fix_stalled', 'merge_conflict'])
  const t = getTicket('shop')!, live = changeText({ t }), fresh = changeText({ t, launch: { worktree: '/wt/shop' } })
  assert.match(live, /^HQ: the TPM changed the spec of invoices after it was finished\. It isn't merged yet/)
  const steps = ['1. Call get_ticket and read the spec as it is now.', 'Run the tests.', 'update_handoff(kind: before_pr)', 'Call open_pr again', 'report_blocked']
  for (const s of steps) assert.ok(live.includes(s), s)
  assert.doesNotMatch(live, /conflict|git merge|fails its tests/)
  assert.match(fresh, /^You are the engineer for ticket invoices \(S\): invoices title\. .*committed on branch b\/INV in your worktree \/wt\/shop; get_ticket has/)
  assert.ok(fresh.endsWith(`the handoff so far.\n\n${live}`))
})

test('a ticket with acceptance criteria: going back says what to do about the tests it named; a ticket with none hears nothing about them', () => {
  const plain = getTicket('shop')!, t = { ...plain, criteria: JSON.stringify([{ id: 'A1', kind: 'ui', text: 'The list shows dates.' }]) }
  const again = /Call open_pr again with the same title and body, keeping the "## Deviations from approved plan" section \(leave `tests` out unless a criterion's test moved/
  const failed = { kind: 'fail' as const, test: 'npm test', output: 'not ok 1 - join', earlier: '' }
  for (const text of [fixTestsText({ t, base: 'main', failed }), fixConflictsText({ t, base: 'main', files: ['app.js'], merged: [], inProgress: false })]) assert.match(text, again)
  assert.match(changeText({ t }), /1\. Call get_ticket and read the spec and the acceptance criteria as they are now\./)
  assert.match(changeText({ t }), /section, and with `tests` for the criteria as they are now\.\n/)
  const none = [fixTestsText({ t: plain, base: 'main', failed }), fixConflictsText({ t: plain, base: 'main', files: ['app.js'], merged: [], inProgress: false }), changeText({ t: plain })]
  for (const text of none) assert.doesNotMatch(text, /`tests`|criteri/)
  // HQ's run passed, but skipped a test the ticket named: its own words, the list as HQ wrote it, and it survives a takeover (Bug 84)
  const unproven = { ...failed, unproven: true, output: "The tests that didn't run:\n- A1: \"shows dates\" in test/list.test.js was skipped, so nothing proved A1." }
  const text = fixTestsText({ t, base: 'main', failed: unproven })
  assert.match(text, /^HQ: b\/INV merged with main passes `npm test`, but that run didn't run every test you named for the ticket's criteria, so HQ didn't merge it\.\n\n/)
  assert.match(text, /merge it\.\n\nThe tests that didn't run:\n- A1: "shows dates"/)
  assert.match(text, /2\. Make each test listed above run and pass under `npm test` \(HQ reads that command's output\), or name a test that does\. Don't drop a criterion's test\./)
  assert.doesNotMatch(text, /fails its tests|never finished/)
  keepTestsFailed(t, unproven); assert.equal(testsFailed(t, 'npm test').unproven, true); assert.equal(testsFailed(t, 'npm test').output, unproven.output)
  keepTestsFailed(t, failed); assert.equal(testsFailed(t, 'npm test').unproven, undefined)
})

test('a ticket sent back for what HQ saw when it opened the app: its own words, notice and button, and HQ\'s report as it wrote it', () => {
  assert.deepEqual(fixWords('look', 'main'), { to: 'fix what went wrong when HQ opened the app with it on main', ing: 'fixing what went wrong when HQ opened the app with it on main' })
  assert.equal(forTests('look'), true); assert.equal(stalledKind('look'), 'look_stalled')
  assert.deepEqual([null, 'tests', 'tests_hung', 'look', 'changes'].map((f) => fixButton(f as never)), ['Fix conflicts', 'Fix tests', 'Fix tests', 'Fix the app', 'Build the change'])
  const t = getTicket('shop')!, report = "HQ started the app the way its preview does (npm run dev) and opened its pages in a headless browser.\n- /: error in the console: boom"
  const failed = { kind: 'fail' as const, test: 'npm run dev', output: report, earlier: '', look: true }
  const text = fixTestsText({ t, base: 'main', failed })
  assert.match(text, /^HQ: b\/INV merged with main passes its tests, but the app has problems when HQ opens it with your ticket merged in, so HQ didn't merge it\.\n\nHQ started the app/)
  assert.match(text, /2\. Fix what the report above shows, .* A real browser can't start in your session: go by the report, .* Then run the tests\.\n3\. Commit\./)
  assert.doesNotMatch(text, /fails its tests|never finished|Lines that named a failure/)
  keepTestsFailed(t, failed); assert.equal(testsFailed(t, 'npm test').look, true); assert.equal(testsFailed(t, 'npm test').output, report)
  keepTestsFailed(t, { ...failed, look: false }); assert.equal(testsFailed(t, 'npm test').look, undefined)
  assert.equal(testsFailed({ ...t, id: 'nothing-kept', fixing: 'look' }, 'npm test').look, true) // what was printed is gone: the reason on the ticket still says which
})

test('a ticket sent back for what a fresh reader of its changes found: its own words, notice and button, and the findings as the reader wrote them', () => {
  assert.deepEqual(fixWords('review', 'main'), { to: 'fix what a fresh reader of its changes found', ing: 'fixing what a fresh reader of its changes found' })
  assert.equal(forTests('review'), true); assert.equal(stalledKind('review'), 'review_stalled'); assert.equal(fixButton('review' as never), 'Fix what it found')
  const t = getTicket('shop')!, found = 'What the reader found:\n- A1: add() subtracts.\n- bug: add.js: add("2", 3) gives "23".'
  const failed = { kind: 'fail' as const, test: 'npm test', output: found, earlier: '', review: true }, text = fixTestsText({ t, base: 'main', failed })
  assert.match(text, /^HQ: b\/INV merged with main passes its tests, but a fresh reader of your changes found problems, so HQ didn't merge it\. The reader saw only the ticket's/)
  assert.match(text, /what the tests printed\.\n\nWhat the reader found:\n- A1: add\(\) subtracts\.\n- bug: add\.js: add\("2", 3\) gives "23"\.\n\nFix it now/)
  assert.match(text, /2\. Fix what the reader found, .* If a finding is wrong, say why in your handoff instead of changing the code: this read happens once, .* Then run the tests\.\n3\. Commit\./)
  assert.doesNotMatch(text, /fails its tests|never finished|opens it|Lines that named a failure/)
  keepTestsFailed(t, failed); assert.equal(testsFailed(t, 'npm test').review, true); assert.equal(testsFailed(t, 'npm test').look, undefined)
  assert.equal(testsFailed({ ...t, id: 'nothing-kept-2', fixing: 'review' }, 'npm test').review, true)
})

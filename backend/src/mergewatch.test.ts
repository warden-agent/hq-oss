// Bug 264: the "merged" notice told the user to press "Start ready", a button the UI doesn't have. Its words name the buttons the board really shows,
// and this test reads the frontend so a renamed button breaks it here, not in front of the user.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-mw-'))
const { changedSince, didWords, finishWords, startWords } = await import('./mergewatch.ts')
const front = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'frontend', 'src', f), 'utf8')

test('startWords: one ticket or several; Resume only while auto mode is on but stopped; the parallel limit when no slot is free', () => {
  assert.equal(startWords(1, false), 'Start it with Start under Your turn, or Launch engineer on its box.')
  assert.equal(startWords(2, false), 'Start them with Start under Your turn, or Launch engineer on each box.')
  assert.equal(startWords(2, true), 'Start them with Start under Your turn, or Launch engineer on each box. Or press Resume on the "Auto mode stopped" bar and HQ starts them.')
  assert.equal(startWords(1, false, true),
    'Start it with Start under Your turn, or Launch engineer on its box. The parallel limit is reached now, so that waits until an engineer finishes.')
  assert.doesNotMatch(startWords(3, true), /Start ready/)
})

test('the buttons startWords names are the ones the frontend shows', () => {
  const nodes = front('Nodes.tsx'), app = front('App.tsx'), board = front('board.ts'), auto = front('Auto.tsx')
  assert.match(nodes, />Your turn</, 'the TPM box\'s Your turn'); assert.match(app, />Your turn</, 'the ⚠ menu\'s Your turn')
  assert.match(board, /startLabel = .*`Start \$\{keys\.join/, 'its Start button on the TPM box ("Start T-02")')
  assert.match(app, /label="Start" busyLabel="Starting…" run=\{\(\) => api\(`repos\/\$\{repo\.id\}\/start-ready`/)
  assert.match(board, /'launch' \? 'Launch engineer'/, 'a ready ticket\'s box')
  assert.match(auto, /`Auto mode stopped: \$\{repo\.auto_stopped_why\}`/); assert.match(auto, /auto-resume`, \{\}\)\)\}>Resume</)
})

// Bug 373: "SHOP-2's engineer fixed its tests on origin/main" was all the TPM heard when the engineer had changed one line of package.json and found that
// nothing had been failing. HQ now says what it knows: why the ticket had gone back, the files changed since, and the engineer's own notes.
const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
test('Bug 373: the files an engineer changed after a send-back are its own: not what merging main in brought, but what it settled by hand in that merge', async () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-since-'))), put = (f: string, s: string) => fs.writeFileSync(path.join(d, f), s)
  sh(d, 'init', '-q', '-b', 'main'); put('app.js', 'a\n'); put('shared.txt', 's\n'); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'base')
  sh(d, 'checkout', '-qb', 'hq/t1'); put('list.js', 'l\n'); put('shared.txt', 'ticket\n'); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'the ticket')
  const tested = sh(d, 'rev-parse', 'HEAD') // the commit HQ tested and sent back
  assert.deepEqual(await changedSince(d, tested, tested, 'refs/heads/main'), { files: [], more: 0 }, 'finished again with nothing new')
  sh(d, 'checkout', '-q', 'main'); put('other.js', 'o\n'); put('shared.txt', 'main\n'); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'another ticket merged first')
  sh(d, 'checkout', '-q', 'hq/t1')
  try { sh(d, 'merge', '--no-edit', 'main') } catch { /* shared.txt conflicts: settled by hand below */ }
  put('shared.txt', 'both\n'); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'merge main in')
  put('package.json', '{}\n'); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'list the tests by name')
  const head = sh(d, 'rev-parse', 'HEAD')
  assert.deepEqual(await changedSince(d, tested, head, 'refs/heads/main'), { files: ['package.json', 'shared.txt'], more: 0 }) // not other.js, not list.js
  assert.deepEqual(await changedSince(d, tested, head, 'refs/heads/main', 1), { files: ['package.json'], more: 1 })
  sh(d, 'mv', 'list.js', 'rows.js'); sh(d, 'commit', '-qm', 'moved'); const moved = sh(d, 'rev-parse', 'HEAD') // a move: the name that went, and the new one
  assert.deepEqual(await changedSince(d, head, moved, 'refs/heads/main'), { files: ['list.js', 'rows.js'], more: 0 })
  assert.equal(await changedSince(d, null, head, 'refs/heads/main'), null, 'finished before HQ kept its commit: nothing to count from')
  assert.equal(await changedSince(d, 'not-a-commit', head, 'refs/heads/main'), null)
  fs.rmSync(d, { recursive: true, force: true })
})

test('Bug 373: a ticket back from HQ\'s check: the TPM hears why it had gone back, what changed and the engineer\'s own notes, never "fixed its tests"', () => {
  assert.equal(didWords({ files: ['frontend/package.json'], more: 0 }, 'The tests did run and pass.\nChanged the test script.'),
    'Since then its engineer changed 1 file: frontend/package.json. Its engineer\'s own notes on it: "The tests did run and pass. / Changed the test script."')
  assert.equal(didWords({ files: [], more: 0 }, ''), 'Since then its engineer changed no files. Its engineer wrote no note about it.')
  assert.equal(didWords(null, ''), 'Its engineer wrote no note about it.') // nothing to count from: no claim about files
  assert.ok(didWords(null, 'x'.repeat(5000)).length < 800, 'a long note is cut for the TPM (the ticket keeps more)')
  const repo: any = { id: 'r1', name: 'shop', path: '/p', default_branch: 'main', auto_mode: 0, auto_stopped_why: null, clearing_at: null }
  const t: any = { key: 'T-01', branch: 'hq/x/T-01', auto_parked_why: null }
  const again = { back: "its tests passed with it merged into main and none failed, but 8 tests named for its criteria weren't seen running",
    did: didWords({ files: ['package.json'], more: 0 }, 'They ran all along.') }
  const o = { base: 'main', pushed: false, tests: true, changed: false, fixed: true, again }
  assert.equal(finishWords(repo, t, o).tpm, "HQ: T-01's engineer finished it again (hq/x/T-01). It had gone back because its tests passed with it merged into main and none "
    + "failed, but 8 tests named for its criteria weren't seen running. Since then its engineer changed 1 file: package.json. Its engineer's own notes on it: "
    + "\"They ran all along.\" The user merges it from HQ; you'll be told when it merges.")
  assert.doesNotMatch(finishWords(repo, t, o).tpm, /fixed its tests/)
  assert.match(finishWords({ ...repo, auto_mode: 1 }, t, o).tpm, /finished it again \(hq\/x\/T-01\)\. It had gone back because .* HQ tests it on main and merges it; you'll be told/)
  assert.equal(finishWords(repo, t, o).notice, null) // "conflicts fixed" is for conflicts only
  // what it must not change: a first finish, a fix of its conflicts and a built spec change say what they said
  assert.equal(finishWords(repo, t, { ...o, tests: false, fixed: false, again: undefined }).tpm,
    "HQ: T-01 is finished (hq/x/T-01). The user merges it into main from HQ; you'll be told when it merges.")
  assert.equal(finishWords(repo, t, { ...o, tests: false, again: undefined }).tpm, "HQ: T-01's conflicts with main are fixed. The user merges it from HQ; you'll be told when it merges.")
})

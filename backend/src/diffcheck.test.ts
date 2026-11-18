// The diff check (diffcheck.ts): which tickets get a reader before they merge and which don't, what the reader is shown of a branch's changes, and every way
// the read can end. The reader is a stand-in (e2e/fake-claude.mjs in `-p` mode); auto mode's use of it end to end is in e2e/auto.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-diffcheck-'))
process.env.HQ_HOME = path.join(home, 'hq'); process.env.HOME = home
process.env.HQ_CLAUDE_BIN = path.join(import.meta.dirname, '..', 'e2e', 'fake-claude.mjs')
const { migrate } = await import('./db.ts'); migrate()
const { diffFor, diffPrompt, readAgain, readDiff, readReport, whyRead } = await import('./diffcheck.ts')
import type { Proof } from './criteria.ts'
import type { PlanCheck } from './checks.ts'

const proof = (o: { tests?: Proof['tests']; flags?: Partial<Proof['flags']> } = {}): Proof => ({ at: 1, tests: o.tests ?? [], flags: { tests_deleted: [], tests_cut: [], outside: [], ...o.flags } })
const T = { criterion: 'A1', file: 'test/add.test.js', name: 'adds two numbers' }, cost = { at: 1, ms: 1, tokens: 1, model: 'opus' }
test('a ticket gets a reader for its size, or for what git or the plan check flagged', () => {
  assert.deepEqual(whyRead({ size: 'M' }, proof(), []), ['it is a size M ticket']); assert.deepEqual(whyRead({ size: 'l' }, null, []), ['it is a size L ticket'])
  assert.deepEqual(whyRead({ size: 'S' }, proof({ flags: { tests_deleted: ['test/old.test.js'], tests_cut: [{ file: 'test/a.test.js', removed: 3 }], outside: ['src/db.js'] } }), []),
    ['it deleted tests', 'it took lines out of existing tests', 'it changed files outside the ones planned for it'])
  assert.deepEqual(whyRead({ size: 'S' }, proof({ tests: [T, { criterion: 'A2', cant_test: 'Needs a real phone camera.' }] }), []), ['one of its criteria has no test'])
  const back: PlanCheck = { state: 'sent_back', findings: [{ about: 'A2', problem: 'No step shows the total in bold.' }], ...cost }
  assert.deepEqual(whyRead({ size: 'S' }, proof(), [{ state: 'ok', ...cost }, back]), ['its plan was sent back once'])
  assert.deepEqual(whyRead({ size: 'S' }, proof(), [{ state: 'unchecked', at: 1, why: 'the check couldn\'t run' }]), ['its plan was never checked'])
})
test('a small ticket with nothing flagged merges without one', () => {
  assert.deepEqual(whyRead({ size: 'S' }, null, []), []); assert.deepEqual(whyRead({ size: 'S' }, proof({ tests: [{ ...T, state: 'passed' }] }), [{ state: 'ok', ...cost }]), [])
  assert.deepEqual(whyRead({ size: 'S' }, proof({ tests: [{ ...T, state: 'unconfirmed' }] }), []), []) // a test runner that prints no names says nothing about the ticket
  assert.deepEqual(whyRead({ size: 'S' }, proof(), [{ state: 'checking', since: 1 }]), [])
})
test('Bug 185: each commit an open_pr names is read; the same commit tested again is not, and a ticket sent back merges on its next pass unread', () => {
  const ok = { state: 'ok' as const, why: ['it is a size M ticket'], ...cost }
  assert.equal(readAgain(null, 'aaa'), true) // never read
  assert.equal(readAgain({ ...ok, sha: 'aaa' }, 'aaa'), false) // tested again at the same commit (main moved during the test): no second read
  assert.equal(readAgain({ ...ok, sha: 'aaa' }, 'bbb'), true) // a later open_pr named a new commit
  assert.equal(readAgain(ok, 'aaa'), true) // read before HQ kept the commit: HQ can't tell it is the same one
  assert.equal(readAgain({ state: 'unchecked', at: 1, why: [], error: 'down', sha: 'aaa' }, 'aaa'), true) // the reader couldn't be asked: try again
  assert.equal(readAgain({ state: 'sent_back', why: [], findings: [{ about: 'bug', problem: 'x' }], ...cost, sha: 'aaa' }, 'bbb'), false) // one send-back
})

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-diffcheck-repo-'))
const sh = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8' })
const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text) }
sh('init', '-q', '-b', 'main'); write('add.js', 'exports.add = (a, b) => a - b\n'); write('package-lock.json', '{}\n'); write('web/package-lock.json', '{}\n')
sh('add', '.'); sh('commit', '-qm', 'main')
sh('checkout', '-qb', 'ticket'); write('add.js', 'exports.add = (a, b) => a + b\n'); write('test/add.test.js', "test('adds two numbers', () => {})\n")
write('package-lock.json', `{${'"x": 1,\n'.repeat(500)}}\n`); write('web/package-lock.json', '{"y": 2}\n'); sh('add', '-A'); sh('commit', '-qm', 'ticket')
sh('checkout', '-q', 'main'); write('README.md', 'main moved on\n'); sh('add', '.'); sh('commit', '-qm', 'later on main')

test('what the reader is shown: every changed file, then the branch\'s own diff without lockfiles, cut where it gets too long', async () => {
  const d = await diffFor(dir, 'refs/heads/main', 'refs/heads/ticket')
  assert.match(d, /^Changed files:\n add\.js +\| +2 \+-\n package-lock\.json +\| +\d+ \+.*\n test\/add\.test\.js +\| +1 \+\n web\/package-lock\.json +\| +2 \+-\n 4 files changed/)
  assert.match(d, /\n-exports\.add = \(a, b\) => a - b\n\+exports\.add = \(a, b\) => a \+ b\n/); assert.match(d, /\+test\('adds two numbers'/)
  assert.doesNotMatch(d, /"x": 1|"y": 2|README|main moved on/) // lockfiles are named, not shown; what main did since isn't the ticket's change
  sh('checkout', '-q', 'ticket'); write('big.txt', 'a line of a very long file\n'.repeat(4000)); sh('add', '.'); sh('commit', '-qm', 'big'); sh('checkout', '-q', 'main')
  const cut = await diffFor(dir, 'refs/heads/main', 'refs/heads/ticket')
  assert.ok(cut.length < 62_000, String(cut.length)); assert.match(cut.slice(-80), /\n\n\(The diff is cut here: \d+ more characters are not shown\.\)$/)
  sh('checkout', '-q', 'ticket'); sh('rm', '-q', 'big.txt'); sh('commit', '-qm', 'small again'); sh('checkout', '-q', 'main')
})
test('the prompt: the criteria, the diff and the end of what the tests printed; a ticket with no criteria is read for bugs only', () => {
  const p = diffPrompt({ criteria: [{ id: 'A1', kind: 'backend', text: 'add(2, 3) gives 5.' }], diff: 'THE DIFF', test: 'npm test', output: `${'x'.repeat(3000)}\nℹ pass 2` })
  assert.match(p, /^## Acceptance criteria\n- A1 \(behind the screen\): add\(2, 3\) gives 5\.\n\n## The changes, as a diff against the main branch\nTHE DIFF\n\n/)
  assert.match(p, /THE DIFF\n\n## What the test run printed \(`npm test`, which passed\)\n…\nx+\nℹ pass 2\n$/)
  assert.ok(p.length < 2300)
  const bare = diffPrompt({ criteria: [], diff: 'D', test: 'npm test', output: '' })
  assert.match(bare, /^## Acceptance criteria\n\(This ticket has no list of criteria: look for bugs only\.\)\n\n[\s\S]*\n\(nothing\)\n$/)
  assert.equal(readReport([{ about: 'A1', problem: 'add() subtracts.' }, { about: 'bug', problem: 'add.js: add("2", 3) gives "23".' }]),
    'What the reader found:\n- A1: add() subtracts.\n- bug: add.js: add("2", 3) gives "23".')
})

const calls = (): any[] => { try { return fs.readFileSync(path.join(home, 'fake-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] } }
const C = [{ id: 'A1', kind: 'backend' as const, text: 'add(2, 3) gives 5.' }]
/** A read of the ticket branch after one more commit of `text` (the stand-in answers what a `FAKE-CHECK:` line in the diff says). */
async function read(text: string, criteria = C, signal = new AbortController().signal) {
  sh('checkout', '-q', 'ticket'); write('notes.txt', `${text}\n`); sh('add', '.'); sh('commit', '-qm', 'notes'); sh('checkout', '-q', 'main')
  return readDiff({ repoPath: dir, base: 'refs/heads/main', branch: 'refs/heads/ticket', criteria, why: ['it is a size M ticket'], test: 'npm test', output: 'ℹ pass 2', signal })
}
const say = (verdict: string, ...f: [string, string][]) => `FAKE-CHECK: ${JSON.stringify({ verdict, findings: f.map(([about, problem]) => ({ about, problem })) })}`
test('a read ends one of four ways: nothing found, findings that send it back, nobody could be asked, or stopped', async () => {
  const ok = await read('nothing to see'); assert.ok(ok !== 'stopped' && ok.state === 'ok', JSON.stringify(ok).slice(0, 300))
  assert.deepEqual(ok.why, ['it is a size M ticket']); assert.equal(ok.tokens, 1802)
  const c = calls().at(-1); assert.match(c.system, /^You are a second reader for a finished software ticket/); assert.equal(c.tools, '')
  assert.ok(/## Acceptance criteria\n- A1 [\s\S]*\+nothing to see\n[\s\S]*## What the test run printed \(`npm test`, which passed\)\nℹ pass 2\n$/.test(c.prompt), c.prompt.slice(-400))
  const back = await read(say('send_back', ['A1', 'add() is never exported under that name.'], ['bug', 'add.js: add("2", 3) gives "23", not 5.'], ['style', 'Use a named function instead.']))
  assert.ok(back !== 'stopped' && back.state === 'sent_back'); assert.deepEqual(back.findings.map((f) => f.about), ['A1', 'bug']) // not about a criterion or a bug: dropped
  const bugs = await read(say('send_back', ['A1', 'There is no A1 on a ticket with no criteria.'], ['bug', 'add.js: add() with no arguments gives NaN.']), [])
  assert.ok(bugs !== 'stopped' && bugs.state === 'sent_back'); assert.deepEqual(bugs.findings.map((f) => f.about), ['bug'])
  const down = { ...await read('FAKE-CHECK: error') as object, at: 0 }
  assert.deepEqual(down, { state: 'unchecked', at: 0, why: ['it is a size M ticket'], error: "the reader couldn't be asked (API Error: Overloaded)" })
  const stop = new AbortController(), n = calls().length, going = read('FAKE-CHECK: hang', C, stop.signal)
  for (const end = Date.now() + 3000; calls().length === n && Date.now() < end;) await new Promise((r) => setTimeout(r, 50))
  stop.abort(); assert.equal(await going, 'stopped')
  const none = await readDiff({ repoPath: dir, base: 'refs/heads/main', branch: 'refs/heads/gone', criteria: C, why: [], test: 'npm test', output: '', signal: new AbortController().signal })
  assert.ok(none !== 'stopped' && none.state === 'unchecked'); assert.match(none.error, /^HQ couldn't work out its changes \(/); assert.equal(calls().length, n + 1) // nobody was asked
})
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

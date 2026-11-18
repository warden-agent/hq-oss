// The git checks on a finished ticket's map (proof.ts), against a real repo in a temp folder: a main with tests, and a ticket branch that adds a test, cuts
// an old one, deletes one, moves one and touches a file outside the plan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { changedSince, checkProof } from './proof.ts'
import type { Criterion, ProofEntry } from './criteria.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-proof-'))
const sh = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8' })
const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text) }
sh('init', '-q', '-b', 'main')
write('src/list.js', 'exports.list = () => []\n'); write('src/db.js', 'exports.db = 1\n')
write('test/items.test.js', "test('lists items', () => {})\ntest('removes an item', () => {})\ntest('keeps the order', () => {})\n")
write('test/old.test.js', "test('old', () => {})\n"); write('test/moved.test.js', `${"test('one of many', () => {})\n".repeat(12)}`)
sh('add', '.'); sh('commit', '-qm', 'main')
sh('checkout', '-qb', 'ticket')
write('src/list.js', 'exports.list = () => [1]\n'); write('src/db.js', 'exports.db = 2\n')
write('test/list.test.js', "test('shows each due date', () => {})\ntest('marks \"Due soon\" within 3 days', () => {})\n")
write('test/items.test.js', "test('lists items', () => {})\ntest('keeps the order', () => {})\n") // one test taken out
fs.rmSync(path.join(dir, 'test/old.test.js')); sh('mv', 'test/moved.test.js', 'test/renamed.test.js')
sh('add', '-A'); sh('commit', '-qm', 'ticket')
sh('checkout', '-q', 'main'); write('README.md', 'main moved on\n'); sh('add', '.'); sh('commit', '-qm', 'later on main') // not the ticket's change

const C: Criterion[] = [{ id: 'A1', kind: 'ui', text: 'The list shows each due date.' }, { id: 'A2', kind: 'ui', text: 'Books near their due date say "Due soon".' }]
const T: ProofEntry[] = [{ criterion: 'A1', file: 'test/list.test.js', name: 'shows each due date' }, { criterion: 'A2', file: 'test/list.test.js', name: 'marks "Due soon" within 3 days' }]
const check = (o: { criteria?: Criterion[]; tests?: ProofEntry[] | null; expected?: string[] } = {}) =>
  checkProof({ repoPath: dir, base: 'refs/heads/main', branch: 'ticket', criteria: o.criteria ?? C, tests: o.tests === undefined ? T : o.tests, expected: o.expected ?? ['src/list.js'], at: 5 })
const problem = async (o: Parameters<typeof check>[0]) => { const r = await check(o); assert.ok('problem' in r, JSON.stringify(r)); return r.problem }

test('what a branch changed since it left main: its own changes only, with a moved test under its new name', async () => {
  const c = await changedSince(dir, 'refs/heads/main', 'refs/heads/ticket')
  assert.deepEqual(c.map((x) => `${x.status} ${x.path} +${x.added} -${x.removed}`).sort(), ['A test/list.test.js +2 -0', 'D test/old.test.js +0 -1', 'M src/db.js +1 -1', 'M src/list.js +1 -1',
    'M test/items.test.js +0 -1', 'M test/renamed.test.js +0 -0'])
})
test('a map whose tests are on the branch is kept, with what git flagged', async () => {
  const r = await check(); assert.ok('proof' in r, JSON.stringify(r))
  assert.deepEqual(r.proof, { at: 5, tests: T, flags: { tests_deleted: ['test/old.test.js'], tests_cut: [{ file: 'test/items.test.js', removed: 1 }], outside: ['src/db.js'] } })
})
test('open_pr is refused, with what to do, for a map git can\'t back up', async () => {
  assert.match(await problem({ tests: null }), /has acceptance criteria \(A1, A2; get_ticket lists them\), so open_pr needs `tests`/)
  assert.match(await problem({ tests: [T[0]!] }), /Nothing named for A2\./)
  assert.match(await problem({ tests: [T[0]!, { criterion: 'A2', file: 'test/nope.test.js', name: 'x' }] }), /A2: there's no test\/nope\.test\.js on your branch/)
  assert.match(await problem({ tests: [T[0]!, { criterion: 'A2', file: 'test/list.test.js', name: 'marks Due soon' }] }), /A2: test\/list\.test\.js has no "marks Due soon" in it/)
  // tests that were there before the ticket and that it didn't touch prove nothing new
  const old = [{ criterion: 'A1', file: 'test/renamed.test.js', name: 'one of many' }, { criterion: 'A2', cant_test: 'Needs a real phone camera, which no test here has.' }]
  assert.match(await problem({ tests: old }), /adds or changes none of the test files you named \(test\/renamed\.test\.js\)/)
})
test('what must not be refused: a criterion nothing can test, a ticket with no criteria, a test in an old file the ticket changed', async () => {
  const cant = (criterion: string) => ({ criterion, cant_test: 'Needs a real phone camera, which no test here has.' })
  const all = await check({ tests: [cant('A1'), cant('A2')] })
  assert.ok('proof' in all && all.proof.tests.every((e) => e.cant_test))
  const none = await check({ criteria: [], tests: null }) // HQ's own repair tickets, and every ticket from before criteria were a list
  assert.ok('proof' in none); assert.deepEqual(none.proof.tests, []); assert.deepEqual(none.proof.flags.tests_deleted, ['test/old.test.js'])
  const edited = await check({ tests: [{ criterion: 'A1', file: 'test/items.test.js', name: 'keeps the order' }, T[1]!], expected: [] })
  assert.ok('proof' in edited); assert.deepEqual(edited.proof.flags.outside, [])
})
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

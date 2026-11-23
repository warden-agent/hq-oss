// Bug 291: node's test runner calls a test file a pass when its process exits 0, whatever it reported. A file that stopped part-way,
// or whose later tests were never declared, left those tests out of the count and the run said OK (678 tests, not 681, on 2026-11-18).
// scripts/whole-files.mjs is a reporter that fails such a run and names the file; own-tmp.mjs adds it to `npm test` and `npm run e2e`.
// Here the real runner runs small files through own-tmp.mjs, with the flags the suites use.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '../..'), OWN_TMP = path.join(root, 'scripts/own-tmp.mjs')
type Seen = { started: number; finished: number; top: number | null; last?: string }
const { declared, problems } = await import(pathToFileURL(path.join(root, 'scripts/whole-files.mjs')).href) as {
  declared: (text: string) => number; problems: (files: Map<string, Seen>, o?: { part?: boolean; read?: (f: string) => string }) => string[] }
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-whole-')))
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const HEAD = "import { test, describe, it } from 'node:test'\n"
const FILES: Record<string, string> = {
  // something inside a test ends the process with code 0: the three tests after it never run
  'exits.test.mjs': `${HEAD}test('one', () => {})\ntest('two: the process ends here', () => { process.exit(0) })\ntest('three', () => {})\ntest('four', () => {})\n`,
  // the file is still loading when its first test is done: with --test-force-exit node ends it there, and the two tests below are never declared
  'late.test.mjs': `${HEAD}test('one', () => {})\nawait new Promise(() => {})\ntest('two', () => {})\ntest('three', () => {})\n`,
  'fine.test.mjs': `${HEAD}test('fine', () => {})\n`,
  // everything a whole file may hold: skipped and todo tests, a suite, tests made in a loop (more than its text declares), subtests,
  // a test file written out as text, and lines printed while it loads and while it runs (node's own warnings come the same way)
  'kinds.test.mjs': `${HEAD}console.error('a warning as the file loads')\ntest('plain', () => { console.log('a line on stdout'); console.error('and one on stderr') })\n`
    + "test('skipped', { skip: 'not here' }, () => {})\ntest.todo('later')\n"
    + "describe('a suite', () => { it('inner one', () => {}); it('inner two', () => {}) })\nfor (const n of [1, 2, 3]) test(`made in a loop ${n}`, () => {})\n"
    + "test('with subtests', async (t) => { await t.test('sub one', () => {}); await t.test('sub two', () => {}) })\n"
    + "const fixture = `\ntest('a line of a test file written as text', () => {})\ntest('and another', () => {})\n`\ntest('reads its fixture', () => { fixture.trim() })\n",
  'fails.test.mjs': `${HEAD}import assert from 'node:assert/strict'\ntest('fine', () => {})\ntest('fails', () => { assert.equal(1, 2) })\n`,
}
for (const [name, text] of Object.entries(FILES)) fs.writeFileSync(path.join(dir, name), text)

/** `npm test`, as own-tmp.mjs runs it, on these files (all of them when none is named), with the user's own options first. */
function run(files: string[], ...user: string[]): { status: number | null; out: string; err: string } {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT // this file runs under a runner itself: the one started here is a runner of its own, not its child
  const r = spawnSync(process.execPath, [OWN_TMP, '--tests=*.test.mjs', process.execPath, '--test', '--test-timeout=120000', '--test-force-exit', ...user, ...files],
    { cwd: dir, env, encoding: 'utf8', timeout: 60_000 })
  return { status: r.status, out: r.stdout, err: r.stderr }
}
const counts = (out: string) => Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'todo'].map((k) => [k, Number(new RegExp(`^ℹ ${k} (\\d+)$`, 'm').exec(out)?.[1])]))

test('Bug 291: a file that ends in the middle of a test fails the run, and the run says which file', () => {
  const r = run(['exits.test.mjs', 'fine.test.mjs'])
  assert.equal(counts(r.out).fail, 0, 'node itself saw nothing wrong') // the hole: exit code 0 was all it asked of the file
  assert.equal(r.status, 1, r.err)
  assert.match(r.err, /✖ A test file did not run whole, so this run fails \(scripts\/whole-files\.mjs, Bug 291\):\n {2}exits\.test\.mjs stopped before its end: /)
  assert.doesNotMatch(r.err, /the last it started was "exits\.test\.mjs"/) // the runner's own entry for the file is not one of its tests
  assert.doesNotMatch(r.err, /fine\.test\.mjs/)
})

test('Bug 291: tests a file never got to declare (--test-force-exit ended it first) fail the run', () => {
  const r = run(['late.test.mjs'])
  assert.deepEqual([counts(r.out).tests, counts(r.out).fail], [1, 0]); assert.equal(r.status, 1, r.err)
  assert.match(r.err, /late\.test\.mjs ran 1 of the 3 tests it declares: the rest were never run/)
})

test('whole files say nothing and pass: skipped, todo, a suite, tests made in a loop, subtests, a test file written out as text, printed lines', () => {
  const r = run(['kinds.test.mjs', 'fine.test.mjs'])
  assert.equal(r.status, 0, r.out + r.err); assert.doesNotMatch(r.err, /whole-files|did not run whole/)
  assert.match(r.out, /a warning as the file loads/); assert.match(r.out, /and one on stderr/) // what it printed did reach the runner
  assert.deepEqual(counts(r.out), { tests: 13, pass: 11, fail: 0, skipped: 1, todo: 1 })
})

test('a run asked for part of the tests (a name pattern) passes with fewer than the file declares', () => {
  const r = run(['kinds.test.mjs'], '--test-name-pattern=plain')
  assert.equal(r.status, 0, r.out + r.err); assert.doesNotMatch(r.err, /whole-files|did not run whole/); assert.equal(counts(r.out).tests, 1)
})

test('a test that fails in the usual way is left to node: the file ran whole', () => {
  const r = run(['fails.test.mjs'])
  assert.equal(r.status, 1); assert.equal(counts(r.out).fail, 1); assert.doesNotMatch(r.err, /whole-files/)
})

test('a run that names its own reporter gets only that one', () => {
  const r = run(['exits.test.mjs'], '--test-reporter=dot')
  assert.equal(r.status, 0, r.err); assert.doesNotMatch(r.err, /whole-files/) // as node alone has it: the price of choosing the reporter
})

// What made files stop part-way: with --test-force-exit a test file's process ends while the last of its report is still queued for a full
// pipe, and that part is thrown away. flush-report.mjs makes the file's output wait until it is written. Whether the loss happens depends on
// how fast the runner reads, so what is checked here is what the preload does: a test file's stdout and stderr are set to blocking, and a
// process that is not a test file's (the runner itself) is left as it was. A one-off script showed the loss and the cure.
test('Bug 291: the preload makes a test file\'s output to the runner blocking, and leaves any other process alone', () => {
  const spy = path.join(dir, 'spy.mjs'), seen = path.join(dir, 'spy.txt'), flush = pathToFileURL(path.join(root, 'scripts/flush-report.mjs')).href
  fs.writeFileSync(spy, `import fs from 'node:fs'
for (const [name, s] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
  const h = s._handle, real = h.setBlocking.bind(h)
  h.setBlocking = (on) => { fs.appendFileSync(${JSON.stringify(seen)}, name + ':' + on + '\\n'); return real(on) }
}
`)
  const as = (context: string | undefined): string => {
    fs.rmSync(seen, { force: true }); const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; if (context) env.NODE_TEST_CONTEXT = context
    const r = spawnSync(process.execPath, [`--import=${pathToFileURL(spy).href}`, `--import=${flush}`, '-e', 'process.stdout.write("ok")'], { env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'ok')
    return fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8') : ''
  }
  assert.equal(as('child-v8'), 'stdout:true\nstderr:true\n') // how the runner marks a test file's process
  assert.equal(as(undefined), '')
})

test('declared: lines that begin a top-level test, and nothing indented, looped, or inside a template string', () => {
  assert.equal(declared("test('a', () => {})\nit('b', () => {})\ndescribe('c', () => {\n  test('inner', () => {})\n})\nsuite('d', () => {})\n"), 4)
  assert.equal(declared("test.skip('a', () => {})\ntest.todo('b')\ndescribe.only('c', () => {})\ntest.each('not node', () => {})\n"), 3)
  assert.equal(declared("for (const n of [1, 2]) test(`n ${n}`, () => {})\nif (MAC) test('mac', () => {})\n  test('indented', () => {})\ntestBase(d, 'main')\n"), 0)
  assert.equal(declared("const a = `x`, b = `y`\ntest('after a line with whole templates', () => {})\n"), 1)
  assert.equal(declared("const f = `\ntest('in the fixture', () => {})\n`\ntest('real', () => {})\nconst g = `a \\` b\ntest('still text', () => {})\n`\n"), 1)
  assert.equal(declared(''), 0)
})

test('problems: no summary, a test that never finished, fewer than declared; and none for a whole file', () => {
  const read = (f: string) => ({ '/r/a.test.ts': "test('1', f)\ntest('2', f)\ntest('3', f)\n" })[f] ?? (() => { throw new Error('no such file') })()
  const files = (x: Seen) => new Map([['/r/a.test.ts', x]]), rel = path.relative(process.cwd(), '/r/a.test.ts')
  assert.deepEqual(problems(files({ started: 3, finished: 3, top: 3 }), { read }), [])
  assert.deepEqual(problems(files({ started: 7, finished: 7, top: 5 }), { read }), []) // more than declared: tests made in a loop, subtests
  assert.deepEqual(problems(files({ started: 3, finished: 2, top: null, last: 'the third' }), { read }),
    [`${rel} stopped before its end: it never sent its end-of-file summary (2 of its tests were reported; the last it started was "the third")`])
  assert.deepEqual(problems(files({ started: 3, finished: 2, top: 3 }), { read }), [`${rel}: 1 of its tests started and never finished`])
  assert.deepEqual(problems(files({ started: 2, finished: 2, top: 2 }), { read }), [`${rel} ran 2 of the 3 tests it declares: the rest were never run`])
  assert.deepEqual(problems(files({ started: 2, finished: 2, top: 2 }), { read, part: true }), [])
  assert.deepEqual(problems(new Map([['/r/gone.test.ts', { started: 1, finished: 1, top: 1 }]]), { read }), []) // a file it can't read back: nothing to compare with
})

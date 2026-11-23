// Bug 200: `npm run e2e -- <file>` ran the whole e2e suite (and `npm test -- <file>` every unit test), because the scripts always
// named the glob and npm adds the file after it. own-tmp.mjs's --tests=<glob> is the files to run only when the command names none.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '../..'), ownTmp = path.join(root, 'scripts/own-tmp.mjs')
/** What own-tmp.mjs hands the command, with /bin/echo standing in for node: one line, its arguments. */
const runs = (...argv: string[]) => execFileSync(process.execPath, [ownTmp, ...argv], { encoding: 'utf8' }).trim()
const NODE = ['--experimental-strip-types', '--test', '--test-force-exit'] // what the scripts pass, before npm adds the user's words
// Bug 291: after the options, the preload that keeps the end of a test file's report (flush-report.mjs), then the usual reporter and the one
// that fails a run whose test file did not run whole (whole-files.mjs)
const FLUSH = `--import=${pathToFileURL(path.join(root, 'scripts/flush-report.mjs')).href}`
const WHOLE = `${FLUSH} --test-reporter=spec --test-reporter-destination=stdout --test-reporter=${path.join(root, 'scripts/whole-files.mjs')} --test-reporter-destination=stderr`
const e2e = (...user: string[]) => runs('--tests=e2e/*.test.ts', '/bin/echo', ...NODE, ...user)

test('Bug 200: files named after `--` replace the glob; with none the glob runs the whole suite', () => {
  assert.equal(e2e(), `${NODE.join(' ')} ${WHOLE} e2e/*.test.ts`)
  assert.equal(e2e('e2e/heavy.test.ts'), `${NODE.join(' ')} ${WHOLE} e2e/heavy.test.ts`)
  assert.equal(e2e('e2e/auto.test.ts', 'e2e/auto-github.test.ts'), `${NODE.join(' ')} ${WHOLE} e2e/auto.test.ts e2e/auto-github.test.ts`)
})

test('two --tests= name two suites for one run (coverage:all): both globs run, and files named after `--` still replace them', () => {
  const both = (...user: string[]) => runs('--tests=src/**/*.test.ts', '--tests=e2e/*.test.ts', '/bin/echo', ...NODE, ...user)
  assert.equal(both(), `${NODE.join(' ')} ${WHOLE} src/**/*.test.ts e2e/*.test.ts`)
  assert.equal(both('--test-name-pattern', 'Bug 70'), `${NODE.join(' ')} --test-name-pattern Bug 70 ${WHOLE} src/**/*.test.ts e2e/*.test.ts`)
  assert.equal(both('e2e/gate.test.ts'), `${NODE.join(' ')} ${WHOLE} e2e/gate.test.ts`)
})

test('Bug 200: options go before the files, where node reads them, and an option\'s value is no file', () => {
  // node takes what follows the first file as the test file's own argument: `--test-name-pattern` there filtered nothing
  assert.equal(e2e('e2e/auto.test.ts', '--test-name-pattern', 'Bug 70'), `${NODE.join(' ')} --test-name-pattern Bug 70 ${WHOLE} e2e/auto.test.ts`)
  assert.equal(e2e('--test-name-pattern', 'Bug 70'), `${NODE.join(' ')} --test-name-pattern Bug 70 ${WHOLE} e2e/*.test.ts`)
  assert.equal(e2e('--test-name-pattern=Bug', 'e2e/a.test.ts', '--test-only'), `${NODE.join(' ')} --test-name-pattern=Bug --test-only ${WHOLE} e2e/a.test.ts`)
  // a run that names its own reporter keeps just that one: node wants every reporter named once one is, and one more would need a place to write to
  assert.equal(e2e('-r', 'x.mjs', '--test-reporter', 'dot'), `${NODE.join(' ')} -r x.mjs --test-reporter dot ${FLUSH} e2e/*.test.ts`)
  assert.equal(e2e('--test-reporter=tap', 'e2e/a.test.ts'), `${NODE.join(' ')} --test-reporter=tap ${FLUSH} e2e/a.test.ts`)
})

test('Bug 200: without --tests= own-tmp.mjs runs the command as it is (one-off demo scripts)', () => {
  assert.equal(runs('/bin/echo', '--experimental-strip-types', 'e2e/bug89demo.mts', '--flag'), '--experimental-strip-types e2e/bug89demo.mts --flag')
})

test('Bug 200: npm test and npm run e2e name their glob through --tests=, quoted for node to expand', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'backend/package.json'), 'utf8'))
  // sh would turn `src/**/*.test.ts` into `src/*/*.test.ts`: once a folder under src/ held a test, only those would run
  assert.match(scripts.test, /^node \.\.\/scripts\/own-tmp\.mjs --tests='src\/\*\*\/\*\.test\.ts' node .* --test .*[^']$/)
  assert.match(scripts.e2e, /^node \.\.\/scripts\/own-tmp\.mjs --tests='e2e\/\*\.test\.ts' node .* --test .*[^']$/)
  for (const s of [scripts.test, scripts.e2e]) assert.doesNotMatch(s.replace(/--tests='[^']*'/, ''), /\*/) // no second glob after it
})

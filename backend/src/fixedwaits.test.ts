// scripts/fixed-waits.mjs: what it counts as a fixed pause in a test, what it leaves alone, and when the check fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
// @ts-expect-error a plain script, no types
import { pauses, verdict, readBaseline, testFiles, LABELS } from '../../scripts/fixed-waits.mjs'

const found = (text: string): string[] => pauses(text).map((p: { line: number; kind: string; label: string | null }) => `${p.line}:${p.kind}${p.label ? `:${p.label}` : ''}`)
const SLEEP = 'await new Promise((r) => setTimeout(r, 100))'

test('a pause written out, a call to the file\'s own sleep helper, and a "still pending" check each count, where they are used', () => {
  assert.deepEqual(found(`test('x', async () => {\n  ${SLEEP}; assert.ok(1)\n})`), ['2:sleep'])
  assert.deepEqual(found('await new Promise<void>((resolve) => { setTimeout(resolve, MS) })'), ['1:sleep'])
  const helper = 'const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))'
  assert.deepEqual(found(`${helper}\nawait wait(100)\nawait wait(5); await wait(6)`), ['2:helper', '3:helper', '3:helper'], 'the calls, not the definition')
  assert.deepEqual(found('export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))\nawait tick()'), ['2:helper'])
  // a one-line function that pauses inside is a helper too: each call is a pause (finished.test.ts's kept)
  assert.deepEqual(found(`${helper}\nconst kept = async (e: any) => { await wait(1600); assert.ok(e) }\nawait kept(1)\nawait kept(2)`), ['3:helper', '4:helper'])
  assert.deepEqual(found('assert.equal(await pendingAfter(held, 2500), true)'), ['1:pending'])
  // a file with a pendingAfter of its own (turnwait.test.ts): each use is one pause, not two
  assert.deepEqual(found('const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))\n'
    + 'const pendingAfter = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => false), tick(ms).then(() => true)])\nawait pendingAfter(held, 600)'), ['3:pending'])
})

test('what is not a fixed pause: a poll, waitFor, a dummy process, the same words in a string or a comment, another file\'s helper name', () => {
  assert.deepEqual(found(`for (;;) { if (await up()) break; ${SLEEP} }`), [])
  assert.deepEqual(found(`while (!done) {\n  ${SLEEP}\n  n++\n}\n${SLEEP}`), ['5:sleep'], 'the loop ends where its block does')
  assert.deepEqual(found(`while (busy()) ${SLEEP}; ${SLEEP}`), ['1:sleep'], 'a loop with no block: its one statement')
  assert.deepEqual(found(`do {\n  ${SLEEP}\n} while (x)\nfor (const a of all) { await go(a) }\n${SLEEP}`), ['5:sleep'])
  assert.deepEqual(found("await waitFor('the app', async () => (await state()).ok, 20_000)"), [])
  assert.deepEqual(found("spawn('sleep', ['600']); sh(dir, 'sleep 61.9 &'); const cmd = `sleep(5); wait(3)`"), [])
  assert.deepEqual(found(`// ${SLEEP}\nconst s = "await wait(100)"`), [])
  assert.deepEqual(found('const kept = (a: any) => a.id\nkept(1); await wait(100); tick()'), [], 'no definition of a sleep helper in this file')
  assert.deepEqual(found("setTimeout(() => proc.kill(), 500); const t = setTimeout(done, 100)"), [], 'a timer, not a pause')
  assert.deepEqual(found("import { pendingAfter } from './harness.ts'\nexport const pendingAfter = (p: Promise<unknown>, ms: number) => new Promise((r) => r(ms))"), [])
  assert.deepEqual(found(`const text = \`\n  ${SLEEP}\n\`\n${SLEEP}`), ['4:sleep'], 'a template string over lines')
})

test('a pause with its reason in a comment, on its line or the line above, is counted apart', () => {
  assert.deepEqual(LABELS, ['limit', 'window', 'real-time', 'hold'])
  assert.deepEqual(found(`${SLEEP} // limit: the stop delay is 2 s`), ['1:sleep:limit'])
  assert.deepEqual(found(`// real-time: ps counts whole seconds\n${SLEEP}\n${SLEEP}`), ['2:sleep:real-time', '3:sleep'])
  assert.deepEqual(found(`${SLEEP} // todo: convert`), ['1:sleep'], 'only the four reasons count, and "todo" is not one')
  assert.deepEqual(found(`x() // hold: nothing shows it\n${SLEEP}`), ['2:sleep'], 'the line above counts only when it is a comment alone')
})

test('the check: over either baseline number fails and says which; under says to lower it; the tree is at its baseline', () => {
  const base = readBaseline('unlabelled 10\nlabelled 2\n'); assert.deepEqual(base, { unlabelled: 10, labelled: 2 })
  assert.deepEqual(verdict({ unlabelled: 10, labelled: 2 }, base).over, []); assert.equal(verdict({ unlabelled: 10, labelled: 2 }, base).under, '')
  assert.match(verdict({ unlabelled: 11, labelled: 2 }, base).over.join('\n'), /^1 more with no reason than the baseline/)
  assert.match(verdict({ unlabelled: 9, labelled: 3 }, base).over.join('\n'), /^1 more with a reason than the baseline: .*raise "labelled"/)
  assert.equal(verdict({ unlabelled: 9, labelled: 2 }, base).under, 'Below the baseline: set scripts/fixed-waits.baseline to unlabelled 9.')
  assert.ok(verdict({ unlabelled: 1, labelled: 1 }, readBaseline('nonsense')).over.length === 2, 'a baseline that can\'t be read fails')
  // it reads the real test files, this one among them, and passes on the tree as it is
  const files: string[] = testFiles(); assert.ok(files.includes('backend/src/fixedwaits.test.ts') && files.includes('backend/e2e/harness.ts') && files.length > 150, String(files.length))
  const script = path.resolve(import.meta.dirname, '../../scripts/fixed-waits.mjs'), r = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^Fixed waits in tests: \d+ with no reason given \(baseline \d+\), \d+ with one \(baseline \d+\)$/m)
  assert.equal(fs.existsSync(path.resolve(import.meta.dirname, '../../scripts/fixed-waits.baseline')), true)
})

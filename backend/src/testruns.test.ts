// Bug 106 (frontend/src/testruns.ts): what the board says while HQ runs its own tests on a finished ticket, on main, or on a repair's test command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clock, featureTestsLine, mergeTestOf, mergeTestWords, runWords } from '../../frontend/src/testruns.ts'
import { forRepo } from '../../frontend/src/needs.ts'

test('Bug 106: how long a run has been going reads as a clock, and never as a minus', () => {
  assert.deepEqual([0, 999, 1000, 42_000, 60_000, 605_000, 3_599_999, 3_723_000].map(clock), ['0:00', '0:00', '0:01', '0:42', '1:00', '10:05', '59:59', '1:02:03'])
  assert.equal(clock(-1500), '0:00', "the page's clock a little behind HQ's")
})
test('Bug 106: a run in words: "it" on its ticket\'s box, the ticket named in the top bar, and waiting its turn said as that', () => {
  const words = (what: 'ticket' | 'main' | 'command', state: 'running' | 'waiting', key: string | null = 'SHOP-2') => runWords({ what, state }, key, 'main')
  assert.deepEqual(words('ticket', 'running'), { box: 'HQ is testing it on main', bar: 'HQ is testing SHOP-2 on main' })
  assert.deepEqual(words('ticket', 'waiting'), { box: "HQ's test is waiting its turn", bar: "HQ's test of SHOP-2 is waiting its turn" })
  assert.deepEqual(words('main', 'running'), { box: 'its tests failed · HQ is testing main without it', bar: 'HQ is testing main without SHOP-2' })
  assert.equal(words('main', 'running', null).bar, 'HQ is testing main', "main's own tests as a run starts: no ticket")
  assert.deepEqual(words('main', 'waiting'), { box: "its tests failed · HQ's test of main without it is waiting its turn", bar: "HQ's test of main without SHOP-2 is waiting its turn" })
  assert.equal(words('main', 'waiting', null).bar, "HQ's test of main is waiting its turn")
  assert.deepEqual(words('command', 'running'), { box: 'HQ is trying its new test command', bar: "HQ is trying SHOP-2's new test command" })
  assert.equal(words('command', 'waiting').box, 'HQ is waiting its turn to try its new test command')
  assert.equal(words('ticket', 'running', null).bar, 'HQ is testing a ticket on main', 'its ticket went meanwhile (Clear)')
  assert.equal(runWords({ what: 'ticket', state: 'running' }, 'T-1', 'develop').box, 'HQ is testing it on develop')
})
test('Bug 289: a run in line says behind whom, on its box and in the top bar; a running one, or one with nobody named, says what it said before', () => {
  const r = (what: 'ticket' | 'main' | 'command' | 'tester', behind?: string[], state: 'running' | 'waiting' = 'waiting') => runWords({ what, state, behind }, 'SHOP-2', 'main')
  assert.deepEqual(r('ticket', ['eng SHOP-1']), { box: "HQ's test is waiting its turn behind eng SHOP-1", bar: "HQ's test of SHOP-2 is waiting its turn behind eng SHOP-1" })
  assert.equal(r('main', ['eng SHOP-1', "HQ's test of SHOP-3"]).bar, "HQ's test of main without SHOP-2 is waiting its turn behind eng SHOP-1 and HQ's test of SHOP-3")
  assert.equal(r('tester', ['a', 'b', 'c']).box, "HQ's tester is waiting its turn behind a and 2 more")
  assert.deepEqual(r('command', ['eng SHOP-1']), { box: 'HQ is waiting its turn to try its new test command behind eng SHOP-1',
    bar: "HQ is waiting its turn to try SHOP-2's new test command behind eng SHOP-1" })
  assert.deepEqual(r('ticket', ['eng SHOP-1'], 'running'), { box: 'HQ is testing it on main', bar: 'HQ is testing SHOP-2 on main' })
  assert.equal(r('command', ['eng SHOP-1'], 'running').box, 'HQ is trying its new test command')
  assert.equal(r('ticket', []).box, "HQ's test is waiting its turn"); assert.equal(r('ticket').box, "HQ's test is waiting its turn") // a page from before the field
})
test('Bug 106: each project sees its own runs, and a state from before this field is left as it is', () => {
  const s = { repos: [], features: [], tickets: [], agents: [], reviews: [], attention: [], messages: [] }
  const runs = [{ id: 'a', repo_id: 'r1' }, { id: 'b', repo_id: 'r2' }, { id: 'c', repo_id: 'r1' }]
  assert.deepEqual(forRepo({ ...s, testRuns: runs }, 'r1').testRuns.map((r) => r.id), ['a', 'c'])
  assert.deepEqual(forRepo({ ...s, testRuns: runs }, 'r3').testRuns, [])
  assert.equal('testRuns' in forRepo(s, 'r1'), false)
})

test('Bug 126: a merged ticket says what HQ ran on it first and how it ended, and says nothing it has no record of', () => {
  const words = (m: string | null) => mergeTestWords(mergeTestOf({ merge_test: m }))
  const pass = { ran: 'pass', test: 'npm test', counts: { passed: 412, failed: 0, skipped: 6 }, ms: 8200, on: 'main', at: 1 }
  assert.deepEqual(words(JSON.stringify(pass)), { box: 'tests passed', passed: true,
    long: "HQ's tests passed on main with it merged in, before it merged · 412 passed, 6 skipped · 8 s" })
  assert.equal(words(JSON.stringify({ ...pass, counts: null, ms: 125_000 }))!.long, "HQ's tests passed on main with it merged in, before it merged · 2 min 5 s", 'no counts: none made up')
  assert.deepEqual(words(JSON.stringify({ ran: 'none', by: 'user', at: 1 })), { box: 'no HQ test', passed: false,
    long: 'You merged it with Merge, which runs no tests: HQ did not test this version as it merged (Have HQ test this, or auto mode, tests before a merge).' })
  assert.equal(words(JSON.stringify({ ran: 'none', by: 'outside', at: 1 }))!.long, 'It was merged outside HQ, so HQ did not test it as it merged.')
  assert.equal(words(null), null, 'merged before HQ kept a record: not "no tests", which may be untrue')
  assert.equal(words('{not json'), null); assert.equal(words('{"ran":"maybe"}'), null)
})
test('Bug 126: a finished feature, its tickets folded away, says what HQ ran on them', () => {
  const pass = JSON.stringify({ ran: 'pass', test: 'npm test', counts: { passed: 2, failed: 0, skipped: 1 }, ms: 3000, on: 'main', at: 1 })
  const user = JSON.stringify({ ran: 'none', by: 'user', at: 1 }), outside = JSON.stringify({ ran: 'none', by: 'outside', at: 1 })
  const line = (...ms: (string | null)[]) => featureTestsLine(ms.map((m, i) => ({ key: `T-0${i + 1}`, merge_test: m })))
  assert.deepEqual(line(pass, pass), { text: 'HQ tested all 2 right before they merged', passed: true,
    tip: "T-01: tests passed on main with it merged in, before it merged · 2 passed, 1 skipped · 3 s\nT-02: tests passed on main with it merged in, before it merged · 2 passed, 1 skipped · 3 s" })
  assert.equal(line(pass)!.text, 'HQ tested it right before it merged')
  assert.deepEqual({ ...line(user, user, outside, user, user, user)!, tip: '' }, { text: 'none tested by HQ as they merged', passed: false, tip: '' }, "F-4's six merges")
  assert.equal(line(pass, user, outside, null)!.text, 'HQ tested 1 of 3 right before they merged · 1 with no record')
  assert.match(line(pass, user, outside, null)!.tip,
    /\nT-02: You merged it with Merge, which runs no tests: .*\nT-03: It was merged outside HQ, so HQ did not test it as it merged\.\nT-04: no record \(merged before HQ kept one\)$/)
  assert.equal(line(pass, null)!.passed, false, 'one with no record: not "all tested"')
  assert.equal(line(null, null), null, 'no record of any: nothing said')
  assert.match(featureTestsLine([{ key: 'T-10', merge_test: null }, { key: 'T-9', merge_test: null }, { key: 'T-2', merge_test: pass }])!.tip, /^T-2: .*\nT-9: .*\nT-10: /, 'in key order, as numbers')
})

test('HQ\'s look at the app is the same run a step on: the box and the bar say it is opening the app, with the ticket or on main without it', () => {
  const words = (what: 'look' | 'look_main', state: 'running' | 'waiting', key: string | null = 'SHOP-2') => runWords({ what, state }, key, 'main')
  assert.deepEqual(words('look', 'running'), { box: 'tests passed · HQ is opening the app', bar: 'HQ is opening the app with SHOP-2 merged in' })
  assert.deepEqual(words('look', 'waiting'), { box: "HQ's look at the app is waiting its turn", bar: "HQ's look at the app with SHOP-2 is waiting its turn" })
  assert.deepEqual(words('look_main', 'running'), { box: 'HQ is opening the app on main without it', bar: 'HQ is opening the app on main without SHOP-2' })
  assert.deepEqual(words('look_main', 'waiting', null), { box: "HQ's look at main without it is waiting its turn", bar: "HQ's look at main is waiting its turn" })
  for (const w of [words('look', 'running'), words('look_main', 'running')]) assert.doesNotMatch(`${w.box} ${w.bar}`, /testing|tests failed/) // its tests passed
  assert.deepEqual(runWords({ what: 'review', state: 'running' }, 'SHOP-2', 'main'), { box: 'tests passed · a fresh reader has its changes', bar: "A fresh reader has SHOP-2's changes" })
  assert.equal(runWords({ what: 'review', state: 'running' }, null, 'main').bar, "A fresh reader has a ticket's changes")
  // the tester has no ticket: the whole run's work, as it ends
  assert.equal(runWords({ what: 'tester', state: 'running' }, null, 'main').bar, "HQ's tester is using the app in a browser, as a person would")
  assert.equal(runWords({ what: 'tester', state: 'waiting' }, null, 'main').bar, "HQ's tester is waiting its turn")
})

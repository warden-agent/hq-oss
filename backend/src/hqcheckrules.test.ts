// "Have HQ test this": the button's words and colour as the ticket's check stands, when results are out of date, when Send to engineer is offered, and when
// a merge may record the check as its test. Pure (hqcheckrules.ts), so the page shows what these say.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allSteps, canSend, changedWords, checkButton, checkFacts, checkHeadline, checkOf, checksOf, checkTone, commandGap, fixBack, nextRound, outOfDate, pastChecks, pastWith,
  roundOf, testedFor, unseenCount, unseenOnly, unseenWords, type HqCheck } from './hqcheckrules.ts'

const base: HqCheck = { id: 'check-1', state: 'pass', sha: 'aaaaaaa1', base: 'main', base_sha: 'bbbbbbb2', finished_sha: 'aaaaaaa1', started_at: 1_000, ended_at: 66_000,
  steps: [{ kind: 'tests', state: 'pass', words: '`npm test` passed' }], tested: { test: 'npm test', counts: { passed: 3, failed: 0, skipped: 0 }, ms: 900, output: 'ok' } }
const tk = (c: Partial<HqCheck> | null, t: Record<string, unknown> = {}) => ({ key: 'T-01', status: 'pr_ready', finished_sha: 'aaaaaaa1',
  hq_check: c ? JSON.stringify({ ...base, ...c }) : null, ...t })

test('the button: every state in its words and colour, and a click starts a check only when there is none to read', () => {
  const b = (c: Partial<HqCheck> | null, t?: Record<string, unknown>) => { const x = checkButton(tk(c, t), true); return x && [x.label, x.tone, x.start] }
  assert.deepEqual(b(null), ['Have HQ test this', 'plain', true])
  assert.deepEqual(b({ state: 'running', now: 'ui', ended_at: undefined }), ['Testing…', 'plain', false])
  assert.match(checkButton(tk({ state: 'running', now: 'ui' }), true)!.tip, /trying it in a browser/) // what it's doing, in its tooltip
  assert.deepEqual(b({}), ['View results ✓', 'green', false])
  assert.deepEqual(b({ state: 'fail' }), ['View results ✗', 'red', false])
  assert.deepEqual(b({ state: 'error', why: 'the app wouldn\'t start' }), ["Couldn't finish", 'amber', false])
  assert.deepEqual(b({ state: 'stopped', why: 'you stopped it' }), ["Couldn't finish", 'amber', false])
  assert.match(checkButton(tk({ state: 'stopped', why: 'you stopped it' }), true)!.tip, /you stopped it/)
  assert.deepEqual(b({}, { finished_sha: 'ccccccc3' }), ['Results out of date', 'grey', false]) // finished again since: old code, whatever it said
  assert.deepEqual(b({ state: 'fail' }, { finished_sha: 'ccccccc3' }), ['Results out of date', 'grey', false])
  assert.deepEqual(b({ state: 'running' }, { finished_sha: 'ccccccc3' }), ['Testing…', 'plain', false], 'a check under way is never out of date: it ends first')
  assert.deepEqual(b({}, { status: 'pr_open' }), ['View results ✓', 'green', false]) // a GitHub ticket with its PR open is finished too
})

test('the button is not there where it must not be: auto mode moves the ticket, or it isn\'t finished (or is merged already)', () => {
  assert.equal(checkButton(tk(null), false), null) // auto mode tests it itself, or the project is being cleared (board.ts nextMover)
  for (const status of ['queued', 'planning', 'implementing', 'resolving', 'merged', 'cancelled']) assert.equal(checkButton(tk({}, { status }), true), null, status)
  assert.equal(checkButton(tk({ state: 'fail' }, { status: 'resolving' }), true), null, 'sent back: its engineer has it')
})

test('out of date only once a newer open_pr names another commit; a ticket from before HQ kept the commit never is', () => {
  assert.equal(outOfDate({ finished_sha: 'aaaaaaa1' }, base), false)
  assert.equal(outOfDate({ finished_sha: 'ccccccc3' }, base), true)
  assert.equal(outOfDate({ finished_sha: null }, { ...base, finished_sha: null }), false)
  assert.equal(outOfDate({}, { ...base, finished_sha: null }), false)
})

test('Send to engineer: only a failure with something to send, once, and only while the results are about its code', () => {
  const send = { kind: 'fix' as const, test: 'npm test', output: 'x', earlier: '' }
  assert.equal(canSend({ finished_sha: 'aaaaaaa1' }, { ...base, state: 'fail', send }), true)
  assert.equal(canSend({ finished_sha: 'aaaaaaa1' }, { ...base, state: 'fail', send, sent_at: 5 }), false)
  assert.equal(canSend({ finished_sha: 'ccccccc3' }, { ...base, state: 'fail', send }), false)
  assert.equal(canSend({ finished_sha: 'aaaaaaa1' }, { ...base, state: 'error', send }), false) // main already failed: not the engineer's to fix
  assert.equal(canSend({ finished_sha: 'aaaaaaa1' }, { ...base, state: 'fail' }), false)
})

test('a merge records the check as its test only for the very commits it passed on, the ticket\'s and main\'s', () => {
  assert.deepEqual(testedFor(base, 'aaaaaaa1', 'bbbbbbb2'), { ...base.tested, on: 'main', at: 66_000 })
  assert.equal(testedFor(base, 'ddddddd4', 'bbbbbbb2'), null) // a commit on the branch since
  assert.equal(testedFor(base, 'aaaaaaa1', 'eeeeeee5'), null) // main moved since (another merge)
  assert.equal(testedFor({ ...base, state: 'fail' }, 'aaaaaaa1', 'bbbbbbb2'), null)
  assert.equal(testedFor({ ...base, tested: undefined }, 'aaaaaaa1', 'bbbbbbb2'), null) // passed with no tests run (the app and the tester only)
  assert.equal(testedFor(null, 'aaaaaaa1', 'bbbbbbb2'), null)
})

test('the results: each check in order, the ones not reached say why, and the heading and facts in words', () => {
  const going: HqCheck = { ...base, state: 'running', now: 'look', ended_at: undefined, steps: [{ kind: 'tests', state: 'pass', words: 'passed' }] }
  assert.deepEqual(allSteps(going).map((s) => s.state), ['pass', 'waiting', 'running', 'waiting', 'waiting'])
  assert.match(checkHeadline(going), /opening the app/)
  assert.doesNotMatch(checkFacts(going), /took/) // its clock is on the page
  const failed: HqCheck = { ...base, state: 'fail', steps: [{ kind: 'tests', state: 'pass', words: '' }, { kind: 'criteria', state: 'fail', words: '' }] }
  assert.deepEqual(allSteps(failed).map((s) => [s.kind, s.state]), [['tests', 'pass'], ['criteria', 'fail'], ['look', 'not_run'], ['read', 'not_run'], ['ui', 'not_run']])
  assert.match(allSteps(failed)[2]!.words, /an earlier check failed/)
  assert.equal(checkHeadline(failed), 'Tests for its criteria failed')
  assert.match(allSteps({ ...base, state: 'stopped', why: 'you stopped it', steps: [] })[0]!.words, /stopped/)
  assert.equal(checkHeadline({ ...base, state: 'stopped', why: 'you stopped it' }), 'Stopped: you stopped it')
  assert.equal(checkFacts({ ...base, cost_usd: 0.162, read_tokens: 4200 }), 'aaaaaaa merged into main (bbbbbbb) · took 1 min 5 s · UI tester $0.16 · reader 4k tokens')
  assert.equal(checkOf({ hq_check: 'not json' }), null); assert.equal(checkOf({ hq_check: '{"state":"pass"}' }), null); assert.equal(checkOf({}), null)
})

// Bug 373: on the live run eight named tests "never ran" (they had run and passed: Bug 372), and the box showed the same red ✗ as a failed test.
const UNSEEN: Partial<HqCheck> = { state: 'fail', send: { kind: 'fix', test: 'npm test', unproven: true, missing: 8, earlier: '', output: "The tests that didn't run:\n- A1: …" },
  steps: [{ kind: 'tests', state: 'pass', words: '`npm test` passed' }, { kind: 'criteria', state: 'fail', words: '', lines: [{ text: 'A1: …', tone: 'bad' }, { text: 'A2: …', tone: 'bad' },
    { text: 'A3: …', tone: 'ok' }] }] }
test('Bug 373: tests that passed with named ones unseen never look like a failed test: amber, in their own words, on the button and in the results', () => {
  const unseen = { ...base, ...UNSEEN } as HqCheck, failed = { ...base, state: 'fail', send: { kind: 'fix', test: 'npm test', output: '✖ adds two', earlier: '' } } as HqCheck
  assert.equal(unseenOnly(unseen), true); assert.equal(unseenCount(unseen), 8); assert.equal(checkTone(unseen), 'amber')
  const b = checkButton(tk(UNSEEN), true)!
  assert.deepEqual([b.label, b.tone, b.start], ['View results ⚠', 'amber', false])
  assert.match(b.tip, /The tests passed when HQ tested T-01, and none failed, but 8 tests named for its criteria weren't seen running/)
  assert.equal(checkHeadline(unseen), "The tests passed, but 8 tests named for its criteria weren't seen running")
  assert.match(allSteps(unseen)[2]!.words, /an earlier check didn't pass/) // not "failed": nothing did
  assert.equal(canSend({ finished_sha: 'aaaaaaa1' }, unseen), true) // it can still go to the engineer
  // what it must not catch: a failed test, findings from the app, the reader or the tester, conflicts, and a check that couldn't finish stay as they were
  assert.equal(unseenOnly(failed), false); assert.equal(unseenCount(failed), 0); assert.equal(checkTone(failed), 'red')
  assert.deepEqual([checkButton(tk(failed), true)!.label, checkButton(tk(failed), true)!.tone], ['View results ✗', 'red'])
  const fixOf = (more: object) => ({ kind: 'fix' as const, test: 'x', output: '', earlier: '', ...more })
  for (const send of [{ kind: 'conflicts' as const }, fixOf({ look: true }), fixOf({ review: true })]) {
    assert.equal(unseenOnly({ ...base, state: 'fail', send }), false); assert.equal(checkTone({ ...base, state: 'fail', send }), 'red')
  }
  assert.equal(unseenOnly({ ...base, state: 'error', send: UNSEEN.send }), false, 'only a check that ended on it')
  assert.deepEqual([checkTone(base), checkTone({ ...base, state: 'error' }), checkTone({ ...base, state: 'stopped' }), checkTone({ ...base, state: 'running' })], ['green', 'amber', 'amber', 'plain'])
  // finished again since: out of date comes first, as for any result
  assert.deepEqual(checkButton(tk(UNSEEN, { finished_sha: 'ccccccc3' }), true)!.label, 'Results out of date')
  // a check kept before HQ counted them: counted from the step's lines; and the words for one, some and many
  assert.equal(unseenCount({ ...unseen, send: { ...unseen.send!, missing: undefined } as HqCheck['send'] }), 2)
  assert.equal(unseenWords(1), "1 test named for its criteria wasn't seen running"); assert.equal(unseenWords(0), "some tests named for its criteria weren't seen running")
})

test('Bug 373: Test again keeps the check before it: the last few, without a passing run\'s output, and the one sent to the engineer outlives the rest', () => {
  const c = (n: number, more: Partial<HqCheck> = {}): HqCheck => ({ ...base, id: `check-${n}`, started_at: n * 1000, ...more })
  assert.deepEqual(pastWith([], null), [])
  const one = pastWith([], c(1)); assert.equal(one.length, 1); assert.equal(one[0]!.id, 'check-1')
  assert.equal(one[0]!.tested, undefined, 'only the latest check can be a merge\'s test, so its 4,000 characters of output go')
  assert.deepEqual(pastWith(one, c(2, { state: 'stopped', why: 'you stopped it', steps: [] })).map((x) => x.id), ['check-1'], 'stopped before anything ran: nothing to keep')
  assert.deepEqual(pastWith(one, c(2, { state: 'running' })).map((x) => x.id), ['check-1'], 'never one still under way')
  assert.deepEqual(pastWith(one, c(2, { state: 'stopped', why: 'you stopped it' })).map((x) => x.id), ['check-1', 'check-2'], 'stopped part-way: what it had said is kept')
  // over the limit the oldest goes, but not the last one sent to the engineer while another can go
  let past = [c(1, { ...UNSEEN, sent_at: 5 })]
  for (let n = 2; n <= 8; n++) past = pastWith(past, c(n), 3)
  assert.deepEqual(past.map((x) => x.id), ['check-1', 'check-7', 'check-8'])
  past = pastWith(past, c(9, { state: 'fail', sent_at: 9 }), 3); assert.deepEqual(past.map((x) => x.id), ['check-7', 'check-8', 'check-9'], 'a newer sent one takes its place')
  // read back: newest first, the latest on top; a record HQ can't read is no check
  const t = { hq_check: JSON.stringify(c(10)), hq_checks: JSON.stringify(past) }
  assert.deepEqual(checksOf(t).map((x) => x.id), ['check-10', 'check-9', 'check-8', 'check-7'])
  assert.deepEqual(pastChecks({ hq_checks: 'not json' }), []); assert.deepEqual(pastChecks({ hq_checks: '[{"state":"pass"},null,7]' }), []); assert.deepEqual(pastChecks({}), [])
  assert.deepEqual(checksOf({ hq_check: null, hq_checks: null }), [])
})

test('Bug 373: what the engineer changed, in words', () => {
  assert.equal(changedWords([]), 'changed no files'); assert.equal(changedWords(['package.json']), 'changed 1 file: package.json')
  assert.equal(changedWords(['a.js', 'b.js', 'c.js']), 'changed 3 files: a.js, b.js, c.js'); assert.equal(changedWords(['a.js', 'b.js'], 9), 'changed 11 files: a.js, b.js and 9 more')
})

// Bug 411: every named test HQ didn't see run is in a folder its test command runs nothing in. That is the command's gap: nothing goes to the engineer.
test('Bug 411: a check that ended on tests where the command runs nothing says so, stays amber, and has nothing to send the engineer', () => {
  const gap = { ...base, ...UNSEEN, send: { ...UNSEEN.send!, missing: 2, outside: 2 } } as HqCheck
  assert.equal(commandGap(gap), true); assert.equal(canSend({ finished_sha: 'aaaaaaa1' }, gap), false)
  assert.equal(checkHeadline(gap), "The tests passed, but HQ's test command doesn't run the folder the tests named for its criteria are in")
  assert.equal(checkHeadline({ ...gap, send: { ...gap.send!, missing: 1, outside: 1 } } as HqCheck),
    "The tests passed, but HQ's test command doesn't run the folder a test named for its criteria is in")
  assert.equal(checkTone(gap), 'amber'); assert.equal(unseenOnly(gap), true)
  const b = checkButton(tk({ ...UNSEEN, send: gap.send }), true)!
  assert.deepEqual([b.label, b.tone, b.start], ['View results ⚠', 'amber', false])
  assert.match(b.tip, /but HQ's test command doesn't run the folder the tests named for its criteria are in\. Click for which\. Its engineer can't change the test command/)
  assert.doesNotMatch(b.tip, /send it to its engineer/)
  // what it must not catch: some of them the engineer's to fix, none outside, a failed test
  const some = { ...gap, send: { ...gap.send!, missing: 3, outside: 2 } } as HqCheck, none = { ...base, ...UNSEEN } as HqCheck
  for (const c of [some, none]) { assert.equal(commandGap(c), false); assert.equal(canSend({ finished_sha: 'aaaaaaa1' }, c), true) }
  assert.equal(checkHeadline(some), "The tests passed, but 3 tests named for its criteria weren't seen running")
  assert.equal(commandGap({ ...base, state: 'fail', send: { kind: 'fix', test: 'x', output: '✖', earlier: '', outside: 1 } } as HqCheck), false)
  assert.equal(commandGap({ ...gap, state: 'error' } as HqCheck), false)
})

test('Bug 411: a check that waits for the project\'s test steps says so, on its button and in its heading', () => {
  const waiting = { ...base, state: 'running', prep: 'Claude is working out how to test this project first (once, a few minutes)' } as HqCheck
  assert.equal(checkHeadline(waiting), 'Testing… Claude is working out how to test this project first (once, a few minutes)')
  assert.match(checkButton(tk(waiting), true)!.tip, /^HQ is testing T-01: Claude is working out how to test this project first \(once, a few minutes\)\. Click to watch it or stop it\.$/)
  assert.equal(checkHeadline({ ...waiting, prep: undefined, now: 'tests' } as HqCheck), 'Testing… running the tests') // and nothing else changes
})

test('Bug 401: sent to its engineer and finished again since: the button says the fix is back and invites the next round, not a grey "out of date"', () => {
  const sent: Partial<HqCheck> = { state: 'fail', sent_at: 5_000, round: 1, back: { at: 9_000, sha: 'ccccccc3', files: ['a.js', 'b.js'], note: 'fixed it' } }
  const b = checkButton(tk(sent, { finished_sha: 'ccccccc3' }), true)!
  assert.deepEqual([b.label, b.tone, b.start], ['Fix is back · test again', 'sky', false]) // opens the results: what it did, and Test again
  assert.equal(b.tip, "You sent round 1 of HQ's test to T-01's engineer, and it has finished the ticket again (it changed 2 files). Click to read what it did, "
    + 'then test it again: round 2.')
  assert.equal(fixBack(tk(sent, { finished_sha: 'ccccccc3' }), checkOf(tk(sent))), true)
  // a conflicts send keeps no record of what came back, but its engineer is back all the same
  const conflicts = checkButton(tk({ ...sent, back: undefined }, { finished_sha: 'ccccccc3' }), true)!
  assert.equal(conflicts.label, 'Fix is back · test again'); assert.doesNotMatch(conflicts.tip, /changed/)
  // what it must not catch: not sent (plain out of date), sent and not back yet (its engineer has it: no button), sent and not finished again, auto mode
  assert.deepEqual(checkButton(tk({ state: 'fail' }, { finished_sha: 'ccccccc3' }), true)!.label, 'Results out of date')
  assert.equal(checkButton(tk(sent, { status: 'resolving' }), true), null)
  assert.equal(fixBack({ status: 'resolving', finished_sha: 'ccccccc3' }, { ...base, ...sent }), false)
  assert.deepEqual(checkButton(tk(sent), true)!.label, 'View results ✗', 'same commit: nothing new came back')
  assert.equal(checkButton(tk(sent, { finished_sha: 'ccccccc3' }), false), null)
  assert.equal(fixBack({ status: 'merged', finished_sha: 'ccccccc3' }, { ...base, ...sent }), false); assert.equal(fixBack({ status: 'pr_ready' }, null), false)
})

test('Bug 401: each check is a round, numbered from 1; the numbers never shift as old ones go, and checks from before keep their place', () => {
  const c = (n: number, more: Partial<HqCheck> = {}): HqCheck => ({ ...base, id: `check-${n}`, started_at: n * 1000, ...more })
  assert.equal(nextRound([]), 1)
  // checks kept before HQ numbered them: counted by their place, then numbered as the next one starts
  const old = { hq_check: JSON.stringify(c(3)), hq_checks: JSON.stringify([c(1), c(2)]) }
  assert.deepEqual(checksOf(old).map((x) => roundOf(old, x)), [3, 2, 1])
  let past = pastWith([c(1), c(2)], c(3)); assert.deepEqual(past.map((x) => x.round), [1, 2, 3]); assert.equal(nextRound(past), 4)
  // over the limit the oldest go; the rest keep their numbers, and the next one carries on
  for (let n = 4; n <= 8; n++) past = pastWith(past, c(n, { round: nextRound(past) }), 3)
  assert.deepEqual(past.map((x) => [x.id, x.round]), [['check-6', 6], ['check-7', 7], ['check-8', 8]]); assert.equal(nextRound(past), 9)
  const t = { hq_check: JSON.stringify(c(9, { round: 9 })), hq_checks: JSON.stringify(past) }
  assert.deepEqual(checksOf(t).map((x) => roundOf(t, x)), [9, 8, 7, 6])
  // what it must not catch: a check stopped before anything ran isn't kept, so the next one takes its number
  const kept = pastWith(past, c(9, { round: 9, state: 'stopped', steps: [] }), 3); assert.equal(nextRound(kept), 9)
})

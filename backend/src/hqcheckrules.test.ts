// "Have HQ test this": the button's words and colour as the ticket's check stands, when results are out of date, when Send to engineer is offered, and when
// a merge may record the check as its test. Pure (hqcheckrules.ts), so the page shows what these say.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allSteps, canSend, checkButton, checkFacts, checkHeadline, checkOf, outOfDate, testedFor, type HqCheck } from './hqcheckrules.ts'

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

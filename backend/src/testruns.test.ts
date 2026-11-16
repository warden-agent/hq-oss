// Bug 106 (frontend/src/testruns.ts): what the board says while HQ runs its own tests on a finished ticket, on main, or on a repair's test command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clock, runWords } from '../../frontend/src/testruns.ts'
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
test('Bug 106: each project sees its own runs, and a state from before this field is left as it is', () => {
  const s = { repos: [], features: [], tickets: [], agents: [], reviews: [], attention: [], messages: [] }
  const runs = [{ id: 'a', repo_id: 'r1' }, { id: 'b', repo_id: 'r2' }, { id: 'c', repo_id: 'r1' }]
  assert.deepEqual(forRepo({ ...s, testRuns: runs }, 'r1').testRuns.map((r) => r.id), ['a', 'c'])
  assert.deepEqual(forRepo({ ...s, testRuns: runs }, 'r3').testRuns, [])
  assert.equal('testRuns' in forRepo(s, 'r1'), false)
})

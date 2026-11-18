// Bug 161: the Agent tab of an exited agent still offered Stop and showed the context figure from its last session
// (frontend/src/usage.ts agentHeader). An exited agent has no live state: the line says why and when it ended instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentHeader } from '../../frontend/src/usage.ts'

const eng = { role: 'engineer', model_alias: 'sonnet', context_tokens: 61_000 }
const plain = (s: string) => s.replace(/ /g, ' ')

test('a running agent: Stop, and its context figure against its limit', () => {
  const h = agentHeader({ ...eng, status: 'working' }, 100_000, null)
  assert.equal(h.stop, true)
  assert.equal(plain(h.who), 'engineer · sonnet · context 61k / 100k')
})

test('an exited agent: no Stop, no context figure, and why and when it ended', () => {
  const h = agentHeader({ ...eng, status: 'exited' }, 100_000, 'stopped by you · 3:04 PM')
  assert.equal(h.stop, false)
  assert.equal(plain(h.who), 'engineer · sonnet · stopped by you · 3:04 PM')
  assert.doesNotMatch(h.who, /context|61k/)
})

test('an exited agent with nothing recorded about its end still drops the figure', () => {
  const h = agentHeader({ ...eng, status: 'exited', model_live: 'claude-sonnet-4-5' }, 100_000, null)
  assert.equal(h.stop, false)
  assert.equal(plain(h.who), 'engineer · claude-sonnet-4-5 · ended')
})

test('not every quiet agent is exited: idle, paused and blocked agents keep Stop and their figure', () => {
  for (const status of ['idle', 'paused', 'blocked', 'plan_review']) {
    const h = agentHeader({ ...eng, status }, 100_000, null)
    assert.equal(h.stop, true, status)
    assert.match(h.who, /context 61k \/ 100k/, status)
  }
})

test('no figure yet, or no limit for the role: nothing made up', () => {
  assert.equal(plain(agentHeader({ role: 'engineer', model_alias: 'haiku', status: 'working' }, 100_000, null).who), 'engineer · haiku')
  assert.equal(plain(agentHeader({ role: 'helper', model_alias: 'haiku', status: 'working', context_tokens: 12_400 }, null, null).who), 'helper · haiku · context 12k')
})

test('each "·" is glued to the word before it, so a wrapped line never starts with one', () => {
  const { who } = agentHeader({ ...eng, status: 'working' }, 100_000, null)
  assert.doesNotMatch(who, / ·/)
})

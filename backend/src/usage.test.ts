// Bug 128: the Agent tab's header names each usage figure, explains it on hover, and leaves it out when Claude Code sent no number (frontend/src/usage.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pauseAt, usageParts } from '../../frontend/src/usage.ts'

const pause = { five: 80, seven: 90 }
const texts = (a: Parameters<typeof usageParts>[0]) => usageParts(a, pause).map((p) => p.text)

test('no figure from Claude Code: nothing is shown, never a "?"', () => {
  assert.deepEqual(texts({ status: 'working' }), [])
  assert.deepEqual(texts({ status: 'working', five_hour_pct: null, seven_day_pct: null }), [])
})

test('the 5-hour figure is named in words and rounded', () => {
  assert.deepEqual(texts({ status: 'working', five_hour_pct: 41.6 }), ['5-hour usage 42%'])
})

test('0% is a real figure and is shown', () => {
  assert.deepEqual(texts({ status: 'idle', five_hour_pct: 0 }), ['5-hour usage 0%'])
})

test('the hover text says what the figure is and when HQ pauses launches', () => {
  const [p] = usageParts({ status: 'working', five_hour_pct: 12 }, { five: 70, seven: 90 })
  assert.match(p.tip, /5-hour usage limit/)
  assert.match(p.tip, /every agent/)
  assert.match(p.tip, /stops starting new agents at 70%/)
})

test('an exited agent shows no usage: its last figure is old', () => {
  assert.deepEqual(texts({ status: 'exited', five_hour_pct: 50 }), [])
})

test('junk in the field is left out, not shown as NaN%', () => {
  assert.deepEqual(texts({ status: 'working', five_hour_pct: Number.NaN }), [])
})

test('pause levels: the user setting wins, else HQ default, else the built-in number', () => {
  assert.deepEqual(pauseAt({ pause_five_hour_pct: 60 }, { pause_five_hour_pct: 80, pause_seven_day_pct: 90 }), { five: 60, seven: 90 })
  assert.deepEqual(pauseAt({}, { pause_five_hour_pct: 75, pause_seven_day_pct: 85 }), { five: 75, seven: 85 })
  assert.deepEqual(pauseAt({}, {}), { five: 80, seven: 90 })
})

test('the weekly figure shows too, after the 5-hour one; alone when it is the only one Claude Code sent', () => {
  assert.deepEqual(texts({ status: 'working', seven_day_pct: 5 }), ['weekly usage 5%'])
  assert.deepEqual(texts({ status: 'working', five_hour_pct: 30, seven_day_pct: 5 }), ['5-hour usage 30%', 'weekly usage 5%'])
  const [p] = usageParts({ status: 'working', seven_day_pct: 5 }, pause)
  assert.match(p.tip, /weekly \(7-day\) usage limit/)
  assert.match(p.tip, /stops starting new agents at 90%/)
})

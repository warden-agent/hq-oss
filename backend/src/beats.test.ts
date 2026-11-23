// src/beats.ts: counters for HQ's timed looks. Their use end to end is e2e/beats.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beat, beats } from './beats.ts'

test('a beat counts its own look and no other; what is read is a copy', () => {
  const from = beats(); assert.deepEqual(Object.keys(from).sort(), ['auto', 'finished', 'leftovers', 'merges', 'stuck'])
  beat('stuck'); beat('stuck'); beat('auto')
  assert.deepEqual(beats(), { ...from, stuck: from.stuck + 2, auto: from.auto + 1 })
  const read = beats(); read.stuck = 999; assert.equal(beats().stuck, from.stuck + 2, 'changing what was read changes nothing')
})

// How HQ cuts a line it types into an agent's terminal (Bug 110): Claude Code takes more than 800 characters arriving at once for a paste.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pieces } from './tmux.ts'

test('pieces: a line comes back whole, in order, no piece longer than asked', () => {
  const line = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
  const got = pieces(line, 250)
  assert.equal(got.join(''), line); assert.ok(got.length > 1); assert.ok(got.every((p) => p.length > 0 && p.length <= 250))
  assert.deepEqual(pieces('short', 250), ['short']); assert.deepEqual(pieces('', 250), [])
  assert.deepEqual(pieces('abcdef', 2), ['ab', 'cd', 'ef']); assert.deepEqual(pieces('abcde', 2), ['ab', 'cd', 'e'])
})
test('pieces: a character made of two halves (an emoji) is never cut in the middle', () => {
  const line = 'ab🙂cd🙂🙂ef'
  for (const max of [1, 2, 3, 4, 5]) {
    const got = pieces(line, max); assert.equal(got.join(''), line, `max ${max}`)
    for (const p of got) assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(p), `max ${max}: "${p}" starts or ends with half a character`)
  }
  assert.deepEqual(pieces('🙂🙂', 1), ['🙂', '🙂']) // one whole character is the least a piece can hold
})

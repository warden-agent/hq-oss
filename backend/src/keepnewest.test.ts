// The board's cache of measured text widths (frontend/src/board.ts) keeps its newest entries only: a tab left open for days
// would otherwise hold every line an agent ever showed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepNewest } from '../../frontend/src/api.ts'

test('a full cache drops its oldest entry for a new one, and nothing before it is full', () => {
  const cache = new Map<string, number>()
  for (const [i, k] of ['a', 'b', 'c'].entries()) assert.equal(keepNewest(cache, k, i, 3), i)
  assert.deepEqual([...cache.keys()], ['a', 'b', 'c'])
  keepNewest(cache, 'd', 3, 3); assert.deepEqual([...cache], [['b', 1], ['c', 2], ['d', 3]])
})
test('a text measured again after it was dropped is new again, and one already there takes no extra room', () => {
  const cache = new Map<string, number>([['a', 0], ['b', 1], ['c', 2]])
  keepNewest(cache, 'b', 9, 3); assert.deepEqual([...cache], [['a', 0], ['b', 9], ['c', 2]])
  keepNewest(cache, 'd', 3, 3); keepNewest(cache, 'a', 0, 3); assert.deepEqual([...cache.keys()], ['c', 'd', 'a'])
})

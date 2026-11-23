// Beats (src/beats.ts): each of HQ's timed looks counts up when it ends, GET /api/beats shows the counts behind the page token, and hq.beats waits
// for a look to have run, where a test used to sleep and hope it had.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, type Hq } from './harness.ts'

const NAMES = ['auto', 'stuck', 'finished', 'leftovers'] as const // the looks on a clock a test can speed up
let hq: Hq, slow: Hq
before(async () => {
  hq = await startHq({ env: { HQ_AUTO_TICK_MS: '150', HQ_STUCK_TICK_S: '0.15', HQ_FINISHED_TICK_S: '0.15', HQ_LEFTOVER_TICK_S: '0.3' } })
  slow = await startHq() // every loop on its own clock, a minute
})
after(async () => { await hq?.stop(); await slow?.stop() })
const counts = async (h: Hq = hq): Promise<Record<string, number>> => (await h.api('beats')).json

test('each timed look counts up when it ends, and hq.beats returns once it has ended that many more times', async () => {
  assert.deepEqual(Object.keys(await counts()).sort(), [...NAMES, 'merges'].sort())
  for (const name of NAMES) {
    const from = (await counts())[name]!; await hq.beats(name, 2)
    assert.ok((await counts())[name]! >= from + 2, `${name}: ${from} then ${(await counts())[name]}`)
  }
})

test('a look that has not run is waited for, and the wait says which when it runs out', async () => {
  const from = await counts(slow)
  await assert.rejects(slow.beats('stuck', 1, { ms: 400 }), /timed out waiting for HQ's stuck look to end 1 more time \(it had ended 0 times\)/)
  await assert.rejects(slow.beats('finished', 2, { ms: 400 }), /HQ's finished look to end 2 more times/)
  assert.deepEqual({ stuck: (await counts(slow)).stuck, finished: (await counts(slow)).finished }, { stuck: from.stuck, finished: from.finished }, 'nothing beat by being asked')
})

test('the counts are behind the page token and can only be read', async () => {
  const url = `http://127.0.0.1:${hq.ports.ui}/api/beats`
  assert.equal((await fetch(url)).status, 401)
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer wrong' } })).status, 401)
  const from = await counts(); const post = await hq.api('beats', {}); assert.notEqual(post.status, 200) // a POST is a change, and there is none to make
  assert.ok((await counts()).auto! >= from.auto!)
  assert.equal((await hq.api('state')).json.beats, undefined, 'the page is not sent them')
})

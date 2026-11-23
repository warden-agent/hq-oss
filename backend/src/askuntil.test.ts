// A box's first question to HQ (frontend/src/api.ts): it keeps asking while nothing answers, and stops at any answer, because a refusal won't change by asking again.
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { askUntilAnswered } from '../../frontend/src/api.ts'

const real = globalThis.fetch
afterEach(() => { globalThis.fetch = real })
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const say = (replies: (() => Response)[]) => {
  let n = 0; globalThis.fetch = (async () => { const r = replies[n++]; if (!r) throw new Error('asked too often'); return r() }) as typeof fetch; return () => n
}
const down = () => { throw new TypeError('fetch failed') }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Polls until `fn` holds: for what the asking gets to in its own time (these were sleeps of 40 to 60 ms, which a busy machine overran). */
async function until(what: string, fn: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !fn();) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 2)) }
}
const watch = () => {
  const log: unknown[] = []
  return { log, on: { away: (is: boolean) => { log.push(is ? 'away' : 'here') }, answer: (r: any) => { log.push(r) }, refused: (e: Error) => { log.push(`refused ${e.message}`) } } }
}

test('Bug 64: it asks again while nothing answers, says so, and stops at the answer', async () => {
  const asked = say([down, down, () => ok({ found: 'npm test' })]), { log, on } = watch()
  askUntilAnswered('x', on, 5); await until('the answer', () => log.length >= 4)
  await wait(30) // limit: it asked again every 5 ms while nothing answered; six of those go by, and it must not ask once more
  assert.deepEqual(log, ['away', 'away', 'here', { found: 'npm test' }]); assert.equal(asked(), 3)
})

test('a refusal is final: one request, and no "away"', async () => {
  const asked = say([() => new Response('{"error":"no"}', { status: 500 })]), { log, on } = watch()
  askUntilAnswered('x', on, 5); await until('the refusal', () => log.length >= 2)
  await wait(30) // limit: asking again would come 5 ms later; six of those go by
  assert.deepEqual(log, ['here', 'refused {"error":"no"}']); assert.equal(asked(), 1)
})

test('stopping it ends the asking, and an answer that comes later is dropped', async () => {
  let release: (r: Response) => void = () => {}; const slow = new Promise<Response>((r) => { release = r })
  globalThis.fetch = (() => slow) as typeof fetch
  const { log, on } = watch(), stop = askUntilAnswered('x', on, 5); stop(); release(ok({ late: true }))
  await wait(20) // real-time: the late answer's body is read over a few turns of the loop, and nothing shows when a dropped one is done with
  assert.deepEqual(log, [])
  const asked = say([down, down, down]), second = watch(), stop2 = askUntilAnswered('x', second.on, 20)
  await until('it to have asked twice', () => asked() >= 2); stop2(); const n = asked()
  await wait(60) // limit: it asked every 20 ms; three of those go by with nothing more asked
  assert.equal(asked(), n)
})

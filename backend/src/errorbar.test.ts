// The red bars under the top bar (frontend/src/api.ts showError, ui.tsx ErrorBar): the same words twice are one bar (Bug 267), and a bar goes once
// its request works or HQ answers again (Bug 278), or once what it was about has gone or come right (Bug 305; a feature too, Bug 353). Bars with
// words only, or from another request, stay until their ×.
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { api, clearErrors, onError, outdatedBar, showError, withError, type ErrMsg, type State } from '../../frontend/src/api.ts'

const real = globalThis.fetch
afterEach(() => { globalThis.fetch = real; onError(null) })
/** The bar list as ErrorBar keeps it. */
const bars = () => {
  let list: ErrMsg[] = [], n = 0
  onError({ add: (m) => { list = withError(list, { ...m, id: ++n }) }, clear: (gone) => { list = list.filter((m) => !gone(m)) } })
  return () => list.map((m) => [m.text, m.from ?? null, !!m.away])
}
const answer = (status: number, body: unknown) => { globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch }
const down = () => { globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch }
const fail = (p: Promise<unknown>) => p.then(() => assert.fail('it should have failed'), (e: Error) => showError(e))

test('Bug 267: the same refusal twice is one bar, the newest; different words are bars of their own, at most three', async () => {
  const seen = bars(), no = { error: "GitHub wouldn't open the PR for T1. Create PR ↗ on its box opens GitHub's own form, filled in." }
  answer(409, no); await fail(api('tickets/t1/make-pr', {})); await fail(api('tickets/t1/make-pr', {}))
  assert.deepEqual(seen(), [[no.error, 'tickets/t1/make-pr', false]])
  showError('one'); showError('two'); showError('three'); showError('two')
  assert.deepEqual(seen().map((m) => m[0]), ['one', 'three', 'two'])
  assert.deepEqual(withError([{ id: 1, text: 'a' }], { id: 2, text: 'a', from: 'x' }), [{ id: 2, text: 'a', from: 'x' }]) // the newer one's request
})

test('Bug 278: a bar goes once its request works; another request\'s bar and a bar with words only stay', async () => {
  const seen = bars()
  answer(500, { error: "EISDIR: illegal operation on a directory, read" }); await fail(api('previews/r1/start', { ticket: null }))
  await fail(api('repos/r1/sync', {})); showError("Couldn't stop demo's app: no")
  answer(200, { ok: true }); await api('previews/r1/start', {}) // Start worked this time (the body doesn't matter: Back to main is a start too)
  assert.deepEqual(seen(), [['EISDIR: illegal operation on a directory, read', 'repos/r1/sync', false], ["Couldn't stop demo's app: no", null, false]])
  answer(200, { found: true }); await api('repos/r1/around', {}) // must not catch: any other request working
  assert.equal(seen().length, 2)
})

test('Bug 278: "Can\'t reach HQ" goes once HQ answers anything, a refusal too, or the page reconnects; the refusal\'s own bar stays', async () => {
  const seen = bars()
  down(); await fail(api('tickets/t1/merge', {}))
  assert.deepEqual(seen(), [["Can't reach HQ. It may be restarting.", 'tickets/t1/merge', true]])
  answer(409, { error: 'no' }); await fail(api('tickets/t2/merge', {})) // HQ answered, if only to say no: it is there again
  assert.deepEqual(seen().map((m) => m[0]), ['no'])
  down(); await fail(api('tickets/t1/merge', {})); answer(200, {}); await api('state')
  assert.deepEqual(seen().map((m) => m[0]), ['no'])
  down(); await fail(api('tickets/t1/merge', {})); clearErrors((m) => !!m.away) // App.tsx's WebSocket open
  assert.deepEqual(seen().map((m) => m[0]), ['no'])
})

/** HQ's whole state as the page keeps it, with only what outdatedBar reads. */
const hqState = (o: Partial<State> = {}): State => ({ repos: [{ id: 'r1' }, { id: 'r2' }], features: [], tickets: [{ id: 't1', status: 'implementing' }, { id: 't2', status: 'queued' }],
  agents: [], messages: [], reviews: [], attention: [], asks: [], settings: {}, defaults: { concurrency_cap: 2 }, held: 0, ports: {},
  previews: [{ id: 'r1', status: 'stopped' }, { id: 'r2', status: 'running' }], ...o })
const bar = (text: string, from?: string): ErrMsg => ({ id: 1, text, ...(from ? { from } : {}) })
/** The bars that outlive the change from `before` to `now`, by their words. */
const left = (list: ErrMsg[], before: State | null, now: State) => list.filter((m) => !outdatedBar(m, before, now)).map((m) => m.text)

test("Bug 305: a bar about a ticket, review, question, notice, project or agent goes with it (a Clear, a Remove); the rest stay", () => {
  const was = hqState({ reviews: [{ id: 'v1' }], asks: [{ id: 'k1' }], attention: [{ id: 'n1' }], agents: [{ id: 'a 1', role: 'tpm', status: 'idle' }] })
  const list = [bar('make-pr refused', 'tickets/t1/make-pr'), bar('merge refused', 'tickets/t2/merge'), bar('answer refused', 'reviews/v1/answer'),
    bar('ask refused', 'asks/k1/answer'), bar('resolve refused', 'attention/n1/resolve'), bar('stop refused', 'agents/a%201/stop'),
    bar('sync refused', 'repos/r2/sync'), bar('pick refused', 'repos/pick'), bar('limit refused', 'settings'), bar('words only')]
  assert.deepEqual(left(list, was, was), list.map((m) => m.text)) // nothing changed: every bar stays
  const cleared = { ...was, tickets: [was.tickets[1]], reviews: [], asks: [], attention: [], agents: [] } // r1's board cleared, t2 still there
  assert.deepEqual(left(list, was, cleared), ['merge refused', 'sync refused', 'pick refused', 'limit refused', 'words only'])
  const removed = { ...cleared, repos: [{ id: 'r1' }], previews: [was.previews[0]] }, still = list.filter((m) => !outdatedBar(m, was, cleared))
  assert.deepEqual(left(still, cleared, removed), ['merge refused', 'pick refused', 'limit refused', 'words only'])
  // must not catch: a row the page hasn't had yet (a project just added, whose app row comes with the next snapshot)
  assert.deepEqual(left([bar('no row yet', 'previews/r3/start')], hqState(), hqState()), ['no row yet'])
  assert.deepEqual(left([bar('first state', 'tickets/t9/launch')], null, hqState()), ['first state'])
})

test('Bug 353: a refused ✕ on a feature (during a Clear) goes when the Clear takes the feature; while the feature is there, it stays', () => {
  const was = hqState({ features: [{ id: 'f1', status: 'active' }, { id: 'f2', status: 'active' }] })
  const clearing = 'demo is being cleared; wait until it\'s done.', list = [bar(clearing, 'features/f1/cancel'), bar('f2 refused', 'features/f2/cancel')]
  assert.deepEqual(left(list, was, { ...was }), [clearing, 'f2 refused']) // the Clear still going: both features on the board
  assert.deepEqual(left(list, was, { ...was, features: [was.features[1]] }), ['f2 refused']) // f1 cleared with its board, f2 still there
  assert.deepEqual(left(list, was, { ...was, features: [], tickets: [] }), [])
  // must not catch: a feature the page hasn't had yet
  assert.deepEqual(left([bar('no row yet', 'features/f9/cancel')], was, was), ['no row yet'])
})

test("Bug 305: a bar from starting a project's app goes once that app reaches running, whoever started it; its other bars stay", () => {
  const ports = 'ports 5840–5849 are all in use', stopped = hqState(), starting = hqState({ previews: [{ id: 'r1', status: 'starting' }, stopped.previews[1]] })
  const up = hqState({ previews: [{ id: 'r1', status: 'running' }, stopped.previews[1]] })
  const list = [bar(ports, 'previews/r1/start'), bar('approve refused', 'previews/r1/approve'), bar('port refused', 'previews/r1/free-port'),
    bar('setup refused', 'previews/r1/setup'), bar('stop refused', 'previews/r1/stop'), bar('command refused', 'previews/r1/command'),
    bar('r2 start refused', 'previews/r2/start')]
  assert.deepEqual(left(list, stopped, starting), list.map((m) => m.text)) // starting isn't running yet
  assert.deepEqual(left(list, starting, up), ['stop refused', 'command refused', 'r2 start refused'])
  // must not catch: an app already running when its start failed (Try it on a ticket, refused) stays running: nothing came right
  assert.deepEqual(left([bar('switch refused', 'previews/r2/start')], stopped, stopped), ['switch refused'])
  assert.deepEqual(left([bar(ports, 'previews/r1/start')], up, up), [ports])
})

test('Bug 305: "Parallel limit reached" goes once a slot is free (the limit raised, an engineer done); the usage pause stays', () => {
  const eng = (id: string, ticket: string) => ({ id, role: 'engineer', status: 'working', ticket_id: ticket })
  const full = hqState({ settings: { concurrency_cap: 2 }, agents: [eng('e1', 't1'), eng('e2', 't2')] })
  const list = [bar('Parallel limit reached (2/2)', 'tickets/t3/launch'), bar('Weekly usage at 91%', 'tickets/t3/launch')]
  assert.deepEqual(left(list, full, { ...full, agents: [...full.agents] }), list.map((m) => m.text))
  assert.deepEqual(left(list, full, { ...full, settings: { concurrency_cap: 3 } }), ['Weekly usage at 91%'])
  assert.deepEqual(left(list, full, { ...full, tickets: [full.tickets[0], { id: 't2', status: 'pr_ready' }] }), ['Weekly usage at 91%']) // finished: no slot
  assert.deepEqual(left(list, full, { ...full, agents: [full.agents[0], { ...full.agents[1], status: 'exited' }] }), ['Weekly usage at 91%'])
  // must not catch: the page's state lagging behind HQ (a slot looked free as the refusal came, and the launch that took it shows next)
  const lagging = { ...full, agents: [full.agents[0]] }
  assert.deepEqual(left(list, lagging, full), list.map((m) => m.text))
  assert.deepEqual(left(list, lagging, lagging), list.map((m) => m.text))
})

test('showError with no bar on screen writes the words to the console', () => {
  const logged: unknown[] = [], was = console.error; console.error = (...a: unknown[]) => { logged.push(a.join(' ')) }
  try { showError(new TypeError('fetch failed')); showError('plain') } finally { console.error = was }
  assert.deepEqual(logged, ["Can't reach HQ. It may be restarting.", 'plain'])
})

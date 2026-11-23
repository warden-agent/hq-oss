// Bug 145: a restarted backend still counts the builds and test runs that held a turn before it, and keeps the line's order; nothing it reads back holds a
// turn for good. Each test writes what the last backend left in the database, then reads it back the way a start does.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-heavyback-')))
process.env.HQ_HOME = path.join(tmp, 'hq')
// How long a place or turn read back is kept for its hook to ask again: 3 s here (half a minute for real). It has to be well over the 1 s time limit
// one test gives a command, and over what the lines between a read-back and a hook asking again can take on a busy machine (154 ms at most in
// 300 runs in Docker beside 28 busy loops; it was 500 ms here until Bug 318).
process.env.HQ_TURN_CLAIM_MS = '3000'
const { migrate, now, q, run, setSetting } = await import('./db.ts'); migrate()
const { gateBash, laneMoved, readBackTurns, release, startTurns, turns, withTurn } = await import('./heavy.ts')
const { emit } = await import('./events.ts')
const { getAgent } = await import('./agents.ts')
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** What an action set off has run: a turn is handed on at once, and whoever waited hears through a promise (this was a 20 ms sleep). */
const settled = () => new Promise((r) => setImmediate(r))
/** Polls until the turns are as `fn` says, for what one of HQ's own limits does when it passes. It was a sleep sized against that limit (0.25 s
 *  for one of 0.15 s, with the next change 0.5 s later). */
async function until(what: string, fn: () => boolean, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; !fn();) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(turns())}`); await new Promise((r) => setTimeout(r, 5)) }
}
const agent = (id: string, status = 'working') =>
  run("INSERT INTO agents(id, role, model_alias, token_hash, status, started_at, display_name) VALUES (?, 'engineer', 'sonnet', 'x', ?, 1, ?)", id, status, `eng ${id}`)
/** A turn the last backend kept: running when `started` is given, else waiting. */
const kept = (agentId: string, use: string, asked: number, started: number | null = null, until: number | null = null) =>
  run('INSERT INTO turns(id, agent_id, who, what, lane, asked_at, started_at, until) VALUES (?,?,?,?,?,?,?,?)', `${agentId}:${use}`, agentId, `eng ${agentId}`, 'tests', 'main',
    asked, started, until)
const rows = () => q<{ id: string; started_at: number | null }>('SELECT id, started_at FROM turns ORDER BY asked_at').map((r) => [r.id, r.started_at !== null])
const conn = () => new EventEmitter() as unknown as http.ServerResponse
/** The hook of a command that was there before the restart asks again: as hooks.ts does, the lane moves first, then the gate. True: it waits. */
const askAgain = (id: string, use: string, answer: () => void) => {
  laneMoved(id, 'main', use)
  return gateBash(getAgent(id)!, { use, command: 'npm test', timeout: undefined, background: false, lane: 'main', plan: false, activity: 'Running: npm test' }, conn(), answer)
}
const ended = (agentId: string, use: string) => emit({ agentId, source: 'hook', kind: 'hook.PostToolUse:Bash', payload: { use } })

test('the run going before the restart still holds its turn; those that waited keep their order however their hooks ask again', async () => {
  setSetting('heavy_at_once', 1)
  const t0 = now()
  for (const a of ['a', 'c', 'd', 'e', 'g']) agent(a)
  agent('b', 'exited')
  kept('a', 'uA', t0 - 9000, t0 - 8000, t0 + 60_000) // running, its agent still there
  kept('b', 'uB', t0 - 9500, t0 - 9500, t0 + 60_000) // running, but its agent ended while HQ was down
  kept('c', 'uC', t0 - 9900, t0 - 9900, t0 - 1) // running, but its own time limit has passed
  kept('x', 'uX', t0 - 9000, t0 - 9000, t0 + 60_000) // an agent HQ no longer has
  kept('d', 'uD', t0 - 5000); kept('e', 'uE', t0 - 3000); kept('g', 'uG', t0 - 1000) // waiting, in this order
  startTurns() // a start reads back what the last backend kept
  assert.deepEqual(turns(), { running: ['eng a'], waiting: ['eng d', 'eng e', 'eng g'] })
  const back = q<{ payload: string }>("SELECT payload FROM events WHERE kind = 'turns.read_back'").map((e) => JSON.parse(e.payload))
  assert.deepEqual(back, [{ running: ['eng a'], waiting: ['eng d', 'eng e', 'eng g'], dropped: ['eng c', 'eng b', 'eng x'] }])
  assert.deepEqual(rows(), [['a:uA', true], ['d:uD', false], ['e:uE', false], ['g:uG', false]])

  // e's hook asks first: it waits, in its old place, behind a's run and d
  let eGot = 0, dGot = 0
  assert.equal(askAgain('e', 'uE', () => eGot++), true); assert.deepEqual(turns(), { running: ['eng a'], waiting: ['eng d', 'eng e', 'eng g'] })
  // a's run ends: the turn is d's, kept for its hook to ask again; e still waits
  ended('a', 'uA'); await settled(); assert.deepEqual(turns(), { running: ['eng d'], waiting: ['eng e', 'eng g'] }); assert.equal(eGot, 0)
  assert.equal(askAgain('d', 'uD', () => dGot++), false); assert.deepEqual(turns().running, ['eng d']) // d's hook: answered at once, it has the turn
  // g's hook never asks again: its place goes after HQ_TURN_CLAIM_MS (3 s here); d, now running for real, keeps its turn
  await until("g's place to go", () => !turns().waiting.includes('eng g')); assert.deepEqual(turns(), { running: ['eng d'], waiting: ['eng e'] }); assert.equal(eGot, 0)
  ended('d', 'uD'); await settled(); assert.equal(eGot, 1); assert.deepEqual(turns(), { running: ['eng e'], waiting: [] })
  assert.deepEqual(rows(), [['e:uE', true]]) // what a further restart would read back
  ended('e', 'uE'); assert.deepEqual(rows(), [])
})

test('nothing read back holds a turn for good: its time limit, its agent moving on or going, a hook that never asks again', async () => {
  setSetting('heavy_at_once', 1)
  const t0 = now()
  for (const a of ['r', 'p', 'm', 'n', 'l']) agent(a)
  // r's own time limit is a second away when HQ reads the turns back, counted from the line before. Bug 318: it was 150 ms counted from t0, and
  // on a busy machine the inserts between took longer than that (up to 195 ms in 300 runs in Docker beside 28 busy loops, over 150 ms in 2 of
  // them, and those 2 failed): r's limit had passed before the read-back, and p had the turn already.
  kept('p', 'uP', t0 - 4000); kept('r', 'uR', t0 - 5000, t0 - 5000, now() + 1000)
  readBackTurns(); assert.deepEqual(turns(), { running: ['eng r'], waiting: ['eng p'] })
  await until("r's time limit to pass", () => !turns().running.includes('eng r'))
  assert.deepEqual(turns(), { running: ['eng p'], waiting: [] }) // r's time limit passed with no end heard: p's turn, kept for its hook…
  await until("p's kept turn to go", () => !turns().running.includes('eng p')); assert.deepEqual(turns(), { running: [], waiting: [] }) // …which never asked again
  assert.deepEqual(rows(), [])

  kept('m', 'uM', t0 - 3000, t0 - 3000, t0 + 60_000); kept('n', 'uN', t0 - 2000, t0 - 2000, t0 + 60_000); setSetting('heavy_at_once', 3)
  kept('l', 'uL', t0 - 1000)
  readBackTurns(); assert.deepEqual(turns(), { running: ['eng m', 'eng n', 'eng l'], waiting: [] })
  laneMoved('m', 'main', 'uOther'); assert.deepEqual(turns().running, ['eng n', 'eng l']) // m started its next tool: that run is over
  emit({ agentId: 'n', source: 'hook', kind: 'hook.Stop', payload: {} }); assert.deepEqual(turns().running, ['eng l']) // n's turn ended
  emit({ agentId: 'l', source: 'system', kind: 'agent.lost', payload: {} }); assert.deepEqual(turns().running, []) // l went
  assert.deepEqual(rows(), [])
  // a turn read back for a command that asks again in a helper's lane is the helper's own: the main lane moving on doesn't free it
  kept('m', 'uH', t0, t0, t0 + 60_000); run("UPDATE turns SET lane = 'helper-1' WHERE id = 'm:uH'"); readBackTurns()
  laneMoved('m', 'main', 'uNext'); assert.deepEqual(turns().running, ['eng m']); release('m:uH'); assert.deepEqual(rows(), [])
})

test('Bug 186: after a restart the boxes say again what runs and who waits for it; a run gone to the background is left alone', async () => {
  setSetting('heavy_at_once', 1)
  const { bus } = await import('./events.ts'), t0 = now(), said = new Map<string, unknown>()
  const seen = (p: { entity: string; id: string; patch?: Record<string, unknown> }) => { if (p.entity === 'agent' && p.patch && 'activity' in p.patch) said.set(p.id, p.patch.activity) }
  bus.on('patch', seen)
  for (const a of ['s1', 's2', 's3', 's4']) agent(a)
  // s1's tests run: the last backend saw them start without a wait, so the line its box showed is on the row
  assert.equal(gateBash(getAgent('s1')!, { use: 'v1', command: 'npm test -- --silent', timeout: undefined, background: false, lane: 'main', plan: false,
    activity: 'Running: npm test -- --silent' }, conn(), () => {}), false)
  assert.equal(q<{ activity: string }>("SELECT activity FROM turns WHERE id = 's1:v1'")[0]!.activity, 'Running: npm test -- --silent')
  release('s1:v1'); said.clear()
  kept('s1', 'v1', t0 - 9000, t0 - 9000, t0 + 60_000); run("UPDATE turns SET activity = 'Running: npm test -- --silent' WHERE id = 's1:v1'")
  kept('s2', 'v2', t0 - 8000); run("UPDATE turns SET what = 'build' WHERE id = 's2:v2'") // waits to build
  kept('s3', 'v3', t0 - 7000, t0 - 7000, t0 + 60_000); run("UPDATE turns SET lane = 'bg:task9', activity = 'Running: npm test' WHERE id = 's3:v3'")
  setSetting('heavy_at_once', 2); readBackTurns()
  assert.deepEqual(turns(), { running: ['eng s1', 'eng s3'], waiting: ['eng s2'] })
  assert.deepEqual(Object.fromEntries(said), { s1: 'Running: npm test -- --silent', s2: 'Waiting its turn to build behind eng s1 and eng s3' }) // Bug 289: behind whom
  // a row kept before the column existed: the box still says what kind of run it is
  for (const id of ['s1:v1', 's2:v2', 's3:v3']) release(id)
  assert.deepEqual(turns(), { running: [], waiting: [] })
  run('DELETE FROM turns'); said.clear(); kept('s4', 'v4', t0 - 1000, t0 - 1000, t0 + 60_000); readBackTurns()
  assert.deepEqual(Object.fromEntries(said), { s4: 'Running tests' })
  release('s4:v4'); bus.off('patch', seen); assert.deepEqual(rows(), [])
})

/** HQ's own run as the last backend kept it (Bug 312): by its project's folder and name, with no agent. */
const keptHq = (who: string, asked: number, started: number | null = null) =>
  run('INSERT INTO turns(id, agent_id, who, what, lane, asked_at, started_at, until) VALUES (?,?,?,?,?,?,?,?)', `hq:/r312:${who}`, '', who, 'tests', 'main', asked, started, null)

test('Bug 312: HQ\'s own run keeps its place in the line across a restart, ahead of the engineers who asked after it; one never started again goes', async () => {
  setSetting('heavy_at_once', 1); run('DELETE FROM turns')
  const t0 = now(), said = new Map<string, unknown>(), { bus } = await import('./events.ts')
  const seen = (p: { entity: string; id: string; patch?: Record<string, unknown> }) => { if (p.entity === 'agent' && p.patch && 'activity' in p.patch) said.set(p.id, p.patch.activity) }
  bus.on('patch', seen)
  for (const a of ['h2', 'h3']) agent(a)
  kept('h2', 'g2', t0 - 9000, t0 - 9000, t0 + 60_000) // eng h2's npm test held the turn
  keptHq("HQ's test of T-01", t0 - 5000); kept('h3', 'g3', t0 - 3000) // then HQ's test of T-01 waited, then eng h3
  readBackTurns(); assert.deepEqual(turns(), { running: ['eng h2'], waiting: ["HQ's test of T-01", 'eng h3'] })
  let h3Got = 0; assert.equal(askAgain('h3', 'g3', () => h3Got++), true) // h3's hook asks again first: still behind HQ's test
  assert.deepEqual(turns().waiting, ["HQ's test of T-01", 'eng h3'])
  // auto mode starts the same test again: it takes its old place, not the end of the line
  const behind: string[][] = []; let ran = false, done!: () => void
  const hq = withTurn("HQ's test of T-01", 'tests', () => { ran = true; return new Promise<void>((r) => { done = r }) }, (b) => behind.push(b), { place: '/r312', ticket: null })
  await settled(); assert.deepEqual(turns(), { running: ['eng h2'], waiting: ["HQ's test of T-01", 'eng h3'] }); assert.deepEqual(behind, [['eng h2']])
  ended('h2', 'g2'); await settled(); assert.equal(ran, true); assert.equal(h3Got, 0)
  assert.deepEqual(turns(), { running: ["HQ's test of T-01"], waiting: ['eng h3'] }); assert.equal(said.get('h3'), "Waiting its turn to run tests behind HQ's test of T-01")
  assert.deepEqual(rows(), [["hq:/r312:HQ's test of T-01", true], ['h3:g3', false]]) // what a further restart would read back
  done(); await hq; await settled(); assert.equal(h3Got, 1); assert.deepEqual(turns(), { running: ['eng h3'], waiting: [] }); ended('h3', 'g3')
  assert.deepEqual(rows(), [])

  // HQ's test was running when HQ went: the restart ended it, and when HQ starts it again it goes first; HQ's look that never comes back loses its place
  for (const a of ['h4', 'h5']) agent(a)
  keptHq("HQ's test of T-02", t0 - 8000, t0 - 7000); kept('h4', 'g4', t0 - 6000); keptHq("HQ's look at T-03", t0 - 5500); kept('h5', 'g5', t0 - 5000)
  readBackTurns(); assert.deepEqual(turns(), { running: ["HQ's test of T-02"], waiting: ['eng h4', "HQ's look at T-03", 'eng h5'] }) // held for HQ to start it again
  let ran2 = false
  await withTurn("HQ's test of T-02", 'tests', async () => { ran2 = true }, () => assert.fail('it had the turn already'), { place: '/r312' }); assert.equal(ran2, true)
  assert.deepEqual(turns(), { running: ['eng h4'], waiting: ["HQ's look at T-03", 'eng h5'] }) // h4's kept turn, for its hook
  release('h4:g4'); assert.deepEqual(turns(), { running: ["HQ's look at T-03"], waiting: ['eng h5'] })
  let h5Got = 0; assert.equal(askAgain('h5', 'g5', () => h5Got++), true) // h5's hook asks again: it waits behind the look's kept turn…
  await until("the look's kept turn to go", () => h5Got === 1) // …which HQ never starts again: gone after HQ_TURN_CLAIM_MS, and h5 runs
  assert.deepEqual(turns(), { running: ['eng h5'], waiting: [] }); ended('h5', 'g5'); assert.deepEqual(rows(), [])
  // two runs of the same name at once (never seen, but possible): the second isn't kept, and neither takes the other's turn
  let first!: () => void; const a = withTurn('HQ twin', 'tests', () => new Promise<void>((r) => { first = r }), undefined, { place: '/r312' })
  await settled(); const b = withTurn('HQ twin', 'tests', async () => 2, undefined, { place: '/r312' }); await settled()
  assert.deepEqual(turns(), { running: ['HQ twin'], waiting: ['HQ twin'] }); assert.deepEqual(rows(), [['hq:/r312:HQ twin', true]])
  first(); await a; assert.equal(await b, 2); assert.deepEqual(turns(), { running: [], waiting: [] }); assert.deepEqual(rows(), [])
  bus.off('patch', seen)
})

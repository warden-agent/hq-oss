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
process.env.HQ_HOME = path.join(tmp, 'hq'); process.env.HQ_TURN_CLAIM_MS = '500'
const { migrate, now, q, run, setSetting } = await import('./db.ts'); migrate()
const { gateBash, laneMoved, readBackTurns, release, startTurns, turns } = await import('./heavy.ts')
const { emit } = await import('./events.ts')
const { getAgent } = await import('./agents.ts')
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
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
  ended('a', 'uA'); await tick(); assert.deepEqual(turns(), { running: ['eng d'], waiting: ['eng e', 'eng g'] }); assert.equal(eGot, 0)
  assert.equal(askAgain('d', 'uD', () => dGot++), false); assert.deepEqual(turns().running, ['eng d']) // d's hook: answered at once, it has the turn
  // g's hook never asks again: its place goes after HQ_TURN_CLAIM_MS (500 ms here); d, now running for real, keeps its turn
  await tick(700); assert.deepEqual(turns(), { running: ['eng d'], waiting: ['eng e'] }); assert.equal(eGot, 0)
  ended('d', 'uD'); await tick(); assert.equal(eGot, 1); assert.deepEqual(turns(), { running: ['eng e'], waiting: [] })
  assert.deepEqual(rows(), [['e:uE', true]]) // what a further restart would read back
  ended('e', 'uE'); assert.deepEqual(rows(), [])
})

test('nothing read back holds a turn for good: its time limit, its agent moving on or going, a hook that never asks again', async () => {
  setSetting('heavy_at_once', 1)
  const t0 = now()
  for (const a of ['r', 'p', 'm', 'n', 'l']) agent(a)
  kept('r', 'uR', t0 - 5000, t0 - 5000, t0 + 150); kept('p', 'uP', t0 - 4000)
  readBackTurns(); assert.deepEqual(turns(), { running: ['eng r'], waiting: ['eng p'] })
  await tick(250); assert.deepEqual(turns(), { running: ['eng p'], waiting: [] }) // r's time limit passed with no end heard: p's turn, kept for its hook…
  await tick(500); assert.deepEqual(turns(), { running: [], waiting: [] }) // …which never asked again
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
  assert.deepEqual(Object.fromEntries(said), { s1: 'Running: npm test -- --silent', s2: 'Waiting its turn to build' })
  // a row kept before the column existed: the box still says what kind of run it is
  for (const id of ['s1:v1', 's2:v2', 's3:v3']) release(id)
  assert.deepEqual(turns(), { running: [], waiting: [] })
  run('DELETE FROM turns'); said.clear(); kept('s4', 'v4', t0 - 1000, t0 - 1000, t0 + 60_000); readBackTurns()
  assert.deepEqual(Object.fromEntries(said), { s4: 'Running tests' })
  release('s4:v4'); bus.off('patch', seen); assert.deepEqual(rows(), [])
})

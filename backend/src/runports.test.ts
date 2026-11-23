// Bug 273: HQ's own test runs get a port block of their own from the engineers' window, never one an engineer or another run holds or something listens on,
// and give it back when they end; an engineer launched meanwhile skips it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-runports-'))
const { migrate, run } = await import('./db.ts')
migrate()
const { runBases, runEnv, runPorts, slotBasesNow } = await import('./runports.ts')
const { nextWorkerSlot, releaseSlot } = await import('./slots.ts')
const B = slotBasesNow(), free = async () => false
const agent = (id: string) => run("INSERT INTO agents(id, role, model_alias, token_hash, status, started_at) VALUES (?, 'engineer', 'opus', ?, 'working', ?)", id, id, Date.now())

test('a test run gets PORT, HQ_PORT_BASE and a database name of its own from the window, and gives the block back', async () => {
  const a = await runPorts(free); assert.ok(a)
  assert.equal(a.base, B[0]); assert.deepEqual(a.env, { PORT: String(B[0]), HQ_PORT_BASE: String(B[0]), DB_NAME: `hq_test_${B[0]}` })
  assert.notEqual(a.env.PORT, '3000')
  const b = await runPorts(free); assert.equal(b?.base, B[1], 'a second run at once (heavy_at_once above 1) gets another block')
  assert.deepEqual(runBases().sort(), [B[0], B[1]])
  a.done(); a.done(); assert.deepEqual(runBases(), [B[1]], 'given back once; a second done does nothing')
  b!.done(); assert.deepEqual(runBases(), [])
  assert.deepEqual(runEnv(12340), { PORT: '12340', HQ_PORT_BASE: '12340', DB_NAME: 'hq_test_12340' })
})

test('runs and engineers never share a block; a block something listens on is skipped; none left gives null', async () => {
  agent('eng-1'); const e = await nextWorkerSlot('eng-1', free); assert.equal(e.env.HQ_PORT_BASE, String(B[0]))
  const r = await runPorts(free); assert.equal(r?.base, B[1], 'the engineer\'s block is skipped')
  agent('eng-2'); const e2 = await nextWorkerSlot('eng-2', free); assert.equal(e2.env.HQ_PORT_BASE, String(B[2]), 'the run\'s block is skipped by a new engineer')
  const busy = async (p: number) => p === B[3]! + 4 // another HQ's server, the user's app
  const r2 = await runPorts(busy); assert.equal(r2?.base, B[4])
  // two runs asking at once never get the same block, though both found it free
  const [x, y] = await Promise.all([runPorts(free), runPorts(free)]); assert.ok(x && y); assert.notEqual(x.base, y.base)
  r!.done(); r2!.done(); x.done(); y.done(); releaseSlot('eng-1'); releaseSlot('eng-2')
  assert.equal(await runPorts(async () => true), null, 'every port busy: no block, nothing held'); assert.deepEqual(runBases(), [])
  assert.equal(await runPorts(free, []), null)
})

// Bug 215: a Stop (or a restart) of the app that a backend restart cuts short. The app's supervisor ends it and exits with code 0; the next backend
// used to read that ended run as a crash ("crashed · stopped with code 0", Restart and "Ask Claude to fix it" offered, no preview.stopped). Now HQ
// keeps on the row that it is ending the run before it signals anything, and the next backend finishes the job: a Stop reads as stopped, a
// restart starts the app again.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startHq, sh, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { for (const p of helpers('')) try { process.kill(p, 'SIGKILL') } catch { /* gone */ } await hq?.stop() })

const TAG = `hq215x${process.pid}`
const ps = () => execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).split('\n').map((l) => l.trim())
/** The pids of app `n`'s helper (of any app with ''), by the tag on its command line. */
const helpers = (n: number | ''): number[] => ps().filter((l) => l.includes(` helper-${TAG}-${n}`)).map((l) => Number(l.split(/\s+/)[0]))
/** The app's supervisor, while it runs. */
const supervisor = (id: string): number | null => {
  const l = ps().find((x) => x.includes('supervise.mjs') && x.includes(`/previews/${id}/`)); return l ? Number(l.split(/\s+/)[0]) : null
}
const preview = async (id: string): Promise<any> => (await hq.state()).previews.find((x: any) => x.id === id)
const events = async (kind: string): Promise<any[]> =>
  (await hq.api('events?limit=300')).json.filter((x: any) => x.kind === kind).map((x: any) => JSON.parse(x.payload))

let apps = 0
/** An app whose server starts one helper. `slow`: it takes 1.5 s to go after SIGTERM, so a stop lasts long enough to cut short; `stubborn`: it
 *  ignores SIGTERM, so the supervisor takes its whole 5 s grace and is still there when the backend comes back. */
async function launch(kind: 'slow' | 'stubborn'): Promise<{ id: string; n: number; name: string }> {
  const n = ++apps, name = `cut-${n}`, dir = hq.repo(name), node = JSON.stringify(process.execPath)
  const code = kind === 'slow' ? "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1500))" : "for (const s of ['SIGTERM','SIGHUP','SIGINT']) process.on(s, () => {})"
  fs.writeFileSync(path.join(dir, 'server.js'), ["const { spawn } = require('child_process')",
    `spawn(${node}, ['-e', ${JSON.stringify(`${code};setInterval(()=>{},1e6)`)}, '--', 'helper-${TAG}-${n}'], { stdio: 'ignore' })`,
    "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT)"].join('\n') + '\n')
  sh(dir, 'commit', '-qam', 'helper')
  const repo = (await hq.api('repos', { path: dir })).json
  await hq.api(`previews/${repo.id}/command`, { command: 'npm start' })
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
  await waitFor('the app', async () => (await preview(repo.id)).status === 'running', 20_000)
  await waitFor('its helper', () => helpers(n).length === 1)
  return { id: repo.id, n, name }
}
/** Asks for `what` (stop or start) and takes the backend down once HQ has begun ending the run; the call itself never answers. */
async function cutShort(id: string, what: 'stop' | 'start', stopping: string): Promise<void> {
  const call = hq.api(`previews/${id}/${what}`, {}).catch(() => null)
  await waitFor(`HQ to begin ending the run (${stopping})`, async () => (await preview(id)).stopping === stopping)
  await hq.down(); await call
}

test('a Stop cut short by a backend restart reads as stopped once HQ is back, not crashed', async () => {
  const { id, n, name } = await launch('slow')
  await cutShort(id, 'stop', 'stop')
  await waitFor('the supervisor to end the app (its pane dead, code 0)', () => supervisor(id) === null, 15_000)
  await hq.up()
  const p = await preview(id)
  assert.equal(p.status, 'stopped', JSON.stringify(p)); assert.equal(p.detail, null); assert.equal(p.stopping, null)
  assert.deepEqual(helpers(n), [], 'the helper is gone')
  assert.ok((await events('preview.stopped')).some((e) => e.repo === name && e.after_restart === true), 'a preview.stopped that says it was finished after the restart')
  assert.ok(!(await events('preview.crashed')).some((e) => e.repo === id), 'no preview.crashed')
})

test('a Stop whose supervisor is still ending the app when HQ comes back is finished, helper and all', async () => {
  const { id, n, name } = await launch('stubborn')
  await cutShort(id, 'stop', 'stop')
  await hq.up()
  const p = await preview(id)
  assert.equal(p.status, 'stopped', JSON.stringify(p)); assert.equal(p.stopping, null)
  assert.equal(supervisor(id), null, 'the supervisor is gone')
  await waitFor('the helper that ignores SIGTERM to be gone', () => !helpers(n).length, 15_000)
  assert.ok((await events('preview.stopped')).some((e) => e.repo === name && e.after_restart === true))
  assert.ok(!(await events('preview.crashed')).some((e) => e.repo === id), 'no preview.crashed')
})

test('a restart cut short by a backend restart starts the app again once HQ is back', async () => {
  const { id, n } = await launch('slow'), before = (await preview(id)).started_at
  const [old] = helpers(n)
  await cutShort(id, 'start', 'restart')
  await waitFor('the old run to end', () => supervisor(id) === null, 15_000)
  await hq.up()
  const p = await waitFor('the app to run again', async () => { const x = await preview(id); return x.status === 'running' && x.started_at > before ? x : null }, 20_000)
  assert.equal(p.stopping, null)
  assert.ok(!(await events('preview.crashed')).some((e) => e.repo === id), 'no preview.crashed')
  const now = await waitFor('the new run\'s helper', () => { const h = helpers(n).filter((x) => x !== old); return h.length ? h : null })
  assert.ok(!helpers(n).includes(old!), 'the old run\'s helper is gone'); assert.equal(now.length, 1)
  assert.equal((await hq.api(`previews/${id}/stop`, {})).status, 200)
})

test('a plain Stop with HQ up all along leaves no mark behind', async () => {
  const { id, name } = await launch('slow')
  assert.equal((await hq.api(`previews/${id}/stop`, {})).status, 200)
  const p = await preview(id); assert.equal(p.status, 'stopped'); assert.equal(p.detail, null); assert.equal(p.stopping, null)
  const e = (await events('preview.stopped')).find((x) => x.repo === name); assert.ok(e); assert.equal(e.after_restart, undefined)
})

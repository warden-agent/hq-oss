// Bug 77 end to end (see harness.ts): Stop means everything the app started is gone, on main too, where HQ can't go by the
// folder (the user's own programs work there). An app here starts one helper of each kind that used to outlive it: one that
// ignores the signals, one slow to shut down, one in a session of its own (Node's `detached`), a daemon whose parent has
// already gone, and a shell job in a process group of its own. A program of the user's in the same folder is never touched.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { startHq, sh, waitFor, type Hq } from './harness.ts'

let hq: Hq
const extra: number[] = []
before(async () => { hq = await startHq() })
after(async () => { for (const p of [...extra, ...KINDS.flatMap((k) => tagged(k))]) try { process.kill(p, 'SIGKILL') } catch { /* gone */ } await hq?.stop() })

const KINDS = ['stubborn', 'slow', 'detached', 'daemon', 'jobctl'] as const
const TAG = `hq77x${process.pid}`
let apps = 0
/** The pids of the helpers of `kind` (of app `n`, or of any) still running, found by the tag on their command line. */
const tagged = (kind: string, n: number | '' = ''): number[] => execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).split('\n').map((l) => l.trim())
  .filter((l) => l.includes(` ${kind}-${TAG}-${n}`) && !l.includes('set -m')).map((l) => Number(l.split(/\s+/)[0]))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const IDLE = 'setInterval(()=>{},1e6)'
/** server.js: answers on $PORT and starts the helpers named in `kinds`. `dies`: the page exits by itself after that many ms. */
function app(kinds: readonly string[], dies = 0): { dir: string; n: number } {
  const n = ++apps, dir = hq.repo(`stop-${n}`), node = JSON.stringify(process.execPath), tag = (k: string) => `${k}-${TAG}-${n}`
  const start: Record<string, string> = {
    stubborn: `spawn(${node}, ['-e', "for (const s of ['SIGTERM','SIGHUP','SIGINT']) process.on(s, () => {});${IDLE}", '--', '${tag('stubborn')}'], { stdio: 'ignore' })`,
    slow: `spawn(${node}, ['-e', "process.on('SIGHUP', () => {});process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1500));${IDLE}", '--', '${tag('slow')}'],
      { stdio: 'ignore' })`,
    detached: `spawn(${node}, ['-e', '${IDLE}', '--', '${tag('detached')}'], { stdio: 'ignore', detached: true }).unref()`,
    daemon: `spawn(${node}, ['-e', "require('child_process').spawn(process.execPath, ['-e', '${IDLE}', '--', '${tag('daemon')}'], { stdio: 'ignore', detached: true }).unref()"], { stdio: 'ignore', detached: true }).unref()`,
    jobctl: `spawn('/bin/bash', ['-c', "set -m; ${process.execPath} -e '${IDLE}' -- ${tag('jobctl')} & wait"], { stdio: 'ignore' })`,
  }
  fs.writeFileSync(path.join(dir, 'server.js'), ["const { spawn } = require('child_process')", ...kinds.map((k) => start[k]!),
    "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT)", dies ? `setTimeout(() => process.exit(3), ${dies})` : ''].join('\n') + '\n')
  sh(dir, 'commit', '-qam', 'helpers'); return { dir, n }
}
async function launch(dir: string): Promise<{ id: string; port: number }> {
  const repo = (await hq.api('repos', { path: dir })).json
  await hq.api(`previews/${repo.id}/command`, { command: 'npm start' })
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
  return waitFor('the app', async () => { const p = (await hq.state()).previews.find((x: any) => x.id === repo.id); return p.status === 'running' ? { id: repo.id, port: p.port } : null }, 20_000)
}
/** A program of the user's own in `cwd`: no terminal, no parent, a group of its own, and nothing to do with any app HQ started. */
function users(cwd: string): number {
  const p = spawn(process.execPath, ['-e', IDLE, '--', `users-${TAG}-`], { cwd, detached: true, stdio: 'ignore' }); p.unref(); extra.push(p.pid!); return p.pid!
}
const helpers = async (n: number, kinds: readonly string[]) => waitFor('the helpers', () => { const ps = kinds.map((k) => tagged(k, n)); return ps.every((x) => x.length === 1) ? ps.flat() : null })
const left = (n: number, kinds: readonly string[]) => kinds.filter((k) => tagged(k, n).length)

test('Stop on main stops everything the app started, and nothing else in the project folder', async () => {
  const { dir, n } = app(KINDS), mine = users(dir)
  const { id, port } = await launch(dir); await helpers(n, KINDS)
  const [stubborn] = tagged('stubborn', n), [daemon] = tagged('daemon', n)
  assert.equal((await hq.api(`previews/${id}/stop`, {})).status, 200)
  assert.deepEqual(left(n, KINDS), [], 'still running when Stop came back')
  assert.equal(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false), false, 'the page is gone')
  assert.ok(alive(mine), "the user's own program in the project folder")
  assert.ok(!(await hq.state()).attention.some((a: any) => /^leftovers_/.test(a.kind)), 'no alert when it worked')
  // the Events tab says what it took: what ran outside the app's own group, what had to be killed, and what had no parent left
  const events = (await hq.api('events?limit=200')).json, payload = (kind: string) => JSON.parse(events.find((e: any) => e.kind === kind)?.payload ?? '{}')
  const stopped = payload('preview.stopped'); assert.ok(stopped.outside >= 2, JSON.stringify(stopped)); assert.deepEqual(stopped.killed, [stubborn])
  assert.ok(payload('procs.leftovers_stopped').stopped?.some((x: any) => x.pids.includes(daemon) && x.folder === path.basename(dir)), JSON.stringify(payload('procs.leftovers_stopped')))
})

test('an app that stops by itself takes what it started with it', async () => {
  const { dir, n } = app(KINDS, 4000), mine = users(dir)
  const { id } = await launch(dir); await helpers(n, KINDS)
  await waitFor('HQ to see it stopped', async () => (await hq.state()).previews.find((x: any) => x.id === id).status === 'crashed', 15_000)
  await waitFor('every helper to be gone', () => !left(n, KINDS).length, 15_000).catch(() => assert.deepEqual(left(n, KINDS), [], 'still running after the app stopped'))
  assert.ok(alive(mine), "the user's own program in the project folder")
})

test('a restart (a merge, a new command) leaves nothing of the old run, and the new run is whole', async () => {
  const { dir, n } = app(['detached', 'daemon', 'stubborn'])
  const { id } = await launch(dir); const old = await helpers(n, ['detached', 'daemon', 'stubborn'])
  assert.equal((await hq.api(`previews/${id}/start`, {})).status, 200)
  await waitFor('the old helpers to be gone', () => old.every((p) => !alive(p)), 15_000)
  const now = await helpers(n, ['detached', 'daemon', 'stubborn'])
  const other = await launch(app(['daemon']).dir); assert.equal((await hq.api(`previews/${other.id}/stop`, {})).status, 200) // another app's Stop looks for leftovers everywhere
  assert.ok(now.every(alive), 'the running app keeps its own helpers'); assert.equal((await hq.api(`previews/${id}/stop`, {})).status, 200)
  assert.ok(now.every((p) => !alive(p)), 'the new helpers went with it')
})

test('what an app left while HQ was down goes when HQ starts again; a running app is picked up whole', async () => {
  const a = app(['detached', 'daemon']), b = app(['detached', 'daemon'])
  const gone = await launch(a.dir), kept = await launch(b.dir)
  const lost = await helpers(a.n, ['detached', 'daemon']), stay = await helpers(b.n, ['detached', 'daemon'])
  hq.tmux('kill-session', '-t', `hq-preview-${gone.id}`) // its terminal goes with nobody stopping it (the tmux session was killed by hand)
  await hq.restart()
  await waitFor('the lost app\'s helpers to be gone', () => lost.every((p) => !alive(p)), 20_000)
  assert.ok(stay.every(alive), 'the app that still runs keeps its helpers')
  assert.equal((await hq.api(`previews/${kept.id}/stop`, {})).status, 200)
  await waitFor('its helpers to go with it', () => stay.every((p) => !alive(p)), 15_000)
})

test('an app whose supervisor is killed reads as stopped, and what it left is stopped', async () => {
  const { dir, n } = app(KINDS), mine = users(dir)
  const { id } = await launch(dir); await helpers(n, KINDS)
  const sup = Number(execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).split('\n').find((l) => l.includes('supervise.mjs') && l.includes(`/previews/${id}/`))?.trim().split(/\s+/)[0])
  assert.ok(sup > 1); process.kill(sup, 'SIGKILL') // nothing of HQ's is left to end the app
  const p = await waitFor('HQ to see it stopped', async () => { const x = (await hq.state()).previews.find((y: any) => y.id === id); return x.status === 'crashed' ? x : null }, 15_000)
  assert.match(p.detail, /137/)
  await waitFor('every helper to be gone', () => !left(n, KINDS).length, 20_000).catch(() => assert.deepEqual(left(n, KINDS), [], 'still running after the app was killed'))
  assert.ok(alive(mine), "the user's own program in the project folder")
})

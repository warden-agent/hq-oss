// Bug 182: the Events entry of a Stop (preview.stopped) says so when the supervisor couldn't report what it stopped. When HQ's limit
// (HQ_PREVIEW_STOP_MS) runs out before the supervisor's own 5 s grace does, HQ kills it: `forced`. When the supervisor can't run
// `ps`, it only tells its own process group to stop: `no_ps`. Either way every program the app started is still stopped.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startHq, sh, waitFor, type Hq } from './harness.ts'

let hq: Hq
// A `ps` that fails only for the supervisor's own look (the one asking for lstart=) while NOPS exists; every other ps is the real one
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq182-')), NOPS = path.join(bin, 'nops')
fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/bash\ncase "$*" in *lstart=*) [ -e '${NOPS}' ] && exit 1 ;; esac\nexec /bin/ps "$@"\n`, { mode: 0o755 })
// 3 s: shorter than the supervisor's 5 s grace, so a helper that ignores SIGTERM makes HQ kill the supervisor
before(async () => { hq = await startHq({ env: { HQ_PREVIEW_STOP_MS: '3000', PATH: `${bin}:${process.env.PATH}` } }) })
after(async () => { for (const p of stubborn('')) try { process.kill(p, 'SIGKILL') } catch { /* gone */ } await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })

const TAG = `hq182x${process.pid}`
/** The pids of app `n`'s helper that ignores the stop signals (of any app with ''), found by the tag on its command line. */
const stubborn = (n: number | ''): number[] => execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).split('\n').map((l) => l.trim())
  .filter((l) => l.includes(` stubborn-${TAG}-${n}`)).map((l) => Number(l.split(/\s+/)[0]))
let apps = 0
/** Launches an app whose server starts one helper that ignores SIGTERM, SIGHUP and SIGINT; returns its id, number and helper's pid. */
async function launch(): Promise<{ id: string; n: number; helper: number }> {
  const n = ++apps, dir = hq.repo(`forced-${n}`), node = JSON.stringify(process.execPath)
  fs.writeFileSync(path.join(dir, 'server.js'), ["const { spawn } = require('child_process')",
    `spawn(${node}, ['-e', "for (const s of ['SIGTERM','SIGHUP','SIGINT']) process.on(s, () => {});setInterval(()=>{},1e6)", '--', 'stubborn-${TAG}-${n}'], { stdio: 'ignore' })`,
    "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT)"].join('\n') + '\n')
  sh(dir, 'commit', '-qam', 'helper')
  const repo = (await hq.api('repos', { path: dir })).json
  await hq.api(`previews/${repo.id}/command`, { command: 'npm start' })
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
  await waitFor('the app', async () => (await hq.state()).previews.find((x: any) => x.id === repo.id).status === 'running', 20_000)
  const [helper] = await waitFor('the helper', () => { const p = stubborn(n); return p.length === 1 ? p : null })
  return { id: repo.id, n, helper: helper! }
}
/** preview.stopped of the repo named `forced-<n>`, as the Events API gives it. */
async function stoppedEntry(n: number): Promise<Record<string, any>> {
  const e = (await hq.api('events?limit=200')).json.find((x: any) => x.kind === 'preview.stopped' && JSON.parse(x.payload).repo === `forced-${n}`)
  assert.ok(e, 'a preview.stopped entry'); return JSON.parse(e.payload)
}

test('Stop: when HQ has to kill the supervisor, the Events entry says it was forced, and the helper is gone', async () => {
  fs.rmSync(NOPS, { force: true })
  const { id, n } = await launch()
  assert.equal((await hq.api(`previews/${id}/stop`, {})).status, 200)
  assert.deepEqual(stubborn(n), [], 'the helper that ignores SIGTERM is still running')
  const e = await stoppedEntry(n)
  assert.equal(e.forced, true, JSON.stringify(e)); assert.equal(e.no_ps, undefined, JSON.stringify(e))
})

test('Stop: a supervisor that can\'t run ps still reports, the entry says so (not forced), and the helper is gone', async () => {
  fs.writeFileSync(NOPS, '')
  try {
    const { id, n, helper } = await launch()
    assert.equal((await hq.api(`previews/${id}/stop`, {})).status, 200)
    assert.deepEqual(stubborn(n), [], 'the helper that ignores SIGTERM is still running')
    const e = await stoppedEntry(n)
    assert.equal(e.no_ps, true, JSON.stringify(e)); assert.equal(e.forced, undefined, JSON.stringify(e))
    // what the supervisor couldn't reach went by the run's mark (leftovers.ts), and that has its own entry
    const swept = JSON.parse((await hq.api('events?limit=200')).json.find((x: any) => x.kind === 'procs.leftovers_stopped')?.payload ?? '{}')
    assert.ok(swept.stopped?.some((x: any) => x.pids.includes(helper)), JSON.stringify(swept))
  } finally { fs.rmSync(NOPS, { force: true }) }
})

// Bug 363: the Launch helper's test ports skipped only ports something already listened on, not one HQ had just given an app that hadn't bound it
// yet (Bug 354's claims). With the preview range nearly full the helper's $PORT was that app's port: its test server took it, and the app's pane
// showed the helper's project (or the app crashed with EADDRINUSE when it got round to listening).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
const squat: http.Server[] = []
before(async () => { hq = await startHq() })
after(async () => { for (const s of squat) s.close(); await hq?.stop() })

const preview = async (repoId: string) => (await hq.state()).previews.find((p: any) => p.id === repoId)
/** Other programs on these ports, so the range is nearly full. */
const hold = (ports: number[]) => Promise.all(ports.map((p) => new Promise<void>((resolve) => {
  const s = http.createServer((q, r) => r.end('someone else')); squat.push(s); s.listen(p, '127.0.0.1', () => resolve())
})))

test('Bug 363: a Launch helper never gets the port of an app that is still starting; a stopped app\'s port is the helper\'s again', async () => {
  const [lo, hi] = hq.env.HQ_PREVIEW_PORTS!.split('-').map(Number) as [number, number]
  await hold(Array.from({ length: hi - 2 - lo }, (_, i) => lo + i)) // three ports left: hi-2, hi-1, hi
  // An app that listens only once data/go exists (a dev server still compiling)
  const dir = hq.repo('b363app'), go = path.join(dir, 'data', 'go')
  fs.writeFileSync(path.join(dir, 'server.js'), `const fs = require('fs'), at = ${JSON.stringify(go)}
const up = () => fs.existsSync(at) ? require('http').createServer((q, s) => s.end('b363app')).listen(process.env.PORT) : setTimeout(up, 100)
up()\n`)
  sh(dir, 'commit', '-qam', 'listen when told')
  const a = (await hq.api('repos', { path: dir })).json.id
  assert.equal((await hq.api(`previews/${a}/command`, { command: 'npm start' })).status, 200)
  const dir2 = hq.repo('b363new'); fs.rmSync(path.join(dir2, 'package.json')); sh(dir2, 'commit', '-qam', 'nothing to guess from')
  const b = (await hq.api('repos', { path: dir2 })).json.id

  const ra = await hq.api(`previews/${a}/start`, {}); assert.equal(ra.status, 200, JSON.stringify(ra.json))
  assert.equal(ra.json.port, hi - 2); assert.equal((await preview(a)).status, 'starting')
  const rb = await hq.api(`previews/${b}/start`, {}); assert.equal(rb.status, 200, JSON.stringify(rb.json))
  assert.equal(rb.json.helper_state, 'working')
  assert.deepEqual(rb.json.helper_ports, [hi - 1, hi], 'the helper leaves the starting app its port') // before: [hi-2, hi-1, hi], $PORT = the app's

  // The app listens: its pane shows its own page
  fs.mkdirSync(path.dirname(go), { recursive: true }); fs.writeFileSync(go, '')
  const up = await waitFor('the app running', async () => { const x = await preview(a); return x.status === 'running' ? x : null }, 30_000)
  assert.equal(up.port, hi - 2); assert.equal(await (await fetch(up.url)).text(), 'b363app')
  assert.equal((await hq.api(`previews/${b}/dismiss`, {})).status, 200)

  // What it must not catch: a stopped app's port is free again for the next helper
  assert.equal((await hq.api(`previews/${a}/stop`, {})).status, 200)
  const again = (await hq.api(`previews/${b}/start`, {})).json
  assert.deepEqual(again.helper_ports, [hi - 2, hi - 1, hi])
  assert.equal((await hq.api(`previews/${b}/dismiss`, {})).status, 200)

  // The only free ports are a starting app's: no helper, and the pane says why
  fs.rmSync(go); await hold([hi - 1, hi])
  const ra2 = await hq.api(`previews/${a}/start`, {}); assert.equal(ra2.json.port, hi - 2)
  const full = await hq.api(`previews/${b}/start`, {}); assert.equal(full.status, 409)
  assert.match(full.json.error, new RegExp(`Claude needs a free port in HQ's preview ports ${lo}–${hi} to try b363new, and they are all in use`))
  assert.equal((await preview(b)).helper_agent_id, null)
  assert.equal((await hq.api(`previews/${a}/stop`, {})).status, 200)
})

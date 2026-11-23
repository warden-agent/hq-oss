// Bug 354: two apps started close together got the same preview port. HQ skipped only ports something already listened on, not one it had just
// handed to another app that hadn't bound it yet, so both were given the bottom port and the slower one crashed with EADDRINUSE.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

const preview = async (repoId: string) => (await hq.state()).previews.find((p: any) => p.id === repoId)
const page = async (url: string) => (await fetch(url)).text()
/** A repo whose `npm start` serves its own name `delay` ms after it starts (a dev server that takes a moment to listen). */
async function app(name: string, delay: number): Promise<string> {
  const dir = hq.repo(name)
  fs.writeFileSync(path.join(dir, 'server.js'), `setTimeout(() => require('http').createServer((q, s) => s.end(${JSON.stringify(name)})).listen(process.env.PORT), ${delay})\n`)
  sh(dir, 'commit', '-qam', 'listen late')
  const repo = (await hq.api('repos', { path: dir })).json
  assert.equal((await hq.api(`previews/${repo.id}/command`, { command: 'npm start' })).status, 200)
  return repo.id
}
const running = (id: string) => waitFor(`${id} running`, async () => { const x = await preview(id); return x.status === 'running' ? x : null }, 30_000)
const stopAll = (ids: string[]) => Promise.all(ids.map((id) => hq.api(`previews/${id}/stop`, {})))

test('Bug 354: apps started at the same moment each get a port of their own, and every page is its own app', async () => {
  const ids = await Promise.all(['b354a', 'b354b', 'b354c'].map((n) => app(n, 1500)))
  const rs = await Promise.all(ids.map((id) => hq.api(`previews/${id}/start`, {})))
  for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.json))
  const ports = rs.map((r) => r.json.port as number)
  assert.equal(new Set(ports).size, 3, `ports given: ${ports}`)
  const ups = await Promise.all(ids.map(running))
  assert.deepEqual(await Promise.all(ups.map((u) => page(u.url))), ['b354a', 'b354b', 'b354c'])
  assert.deepEqual(ups.map((u) => u.port), ports)
  await stopAll(ids)
})

test('Bug 354: a start while another app is still starting (not listening yet) skips that app\'s port', async () => {
  const [a, b] = await Promise.all([app('b354d', 4000), app('b354e', 0)])
  const ra = await hq.api(`previews/${a}/start`, {}); assert.equal(ra.status, 200, JSON.stringify(ra.json))
  assert.equal((await preview(a!)).status, 'starting')
  const rb = await hq.api(`previews/${b}/start`, {}); assert.equal(rb.status, 200, JSON.stringify(rb.json))
  assert.notEqual(rb.json.port, ra.json.port)
  const ups = await Promise.all([running(a!), running(b!)])
  assert.deepEqual(await Promise.all(ups.map((u) => page(u.url))), ['b354d', 'b354e'])
  // A stopped app's port is free again for the next start
  await stopAll([a!])
  const rc = await hq.api(`previews/${a}/start`, {}); assert.equal(rc.json.port, ra.json.port)
  await running(a!); await stopAll([a!, b!])
})

test('Bug 354: restarting either of two apps, one still starting, keeps each on its own port', async () => {
  const [a, b] = await Promise.all([app('b354f', 0), app('b354g', 5000)])
  const ra = await hq.api(`previews/${a}/start`, {}); await running(a!)
  const rb = await hq.api(`previews/${b}/start`, {}); assert.notEqual(rb.json.port, ra.json.port)
  const [ra2, rb2] = await Promise.all([hq.api(`previews/${a}/start`, {}), hq.api(`previews/${b}/start`, {})]) // b restarts before it ever listened
  assert.deepEqual([ra2.json.port, rb2.json.port], [ra.json.port, rb.json.port])
  const ups = await Promise.all([running(a!), running(b!)])
  assert.deepEqual(await Promise.all(ups.map((u) => page(u.url))), ['b354f', 'b354g'])
  await stopAll([a!, b!])
})

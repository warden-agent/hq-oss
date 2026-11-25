// Bug 362: two projects whose start steps hard-wire the same port, started a moment apart. Bug 354's claims kept HQ from handing one free port to two
// apps, but a fixed port only had the "something listens there" check: the first app hadn't bound it yet, so both started and the second ended with
// EADDRINUSE. Now a fixed port another app here was given counts as taken too, and the refused start names that app.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

const preview = async (repoId: string) => (await hq.state()).previews.find((p: any) => p.id === repoId)
const page = async (url: string) => (await fetch(url)).text()
const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
})
/** A repo whose OK'd start steps run `node server.js` on the fixed `port`; it serves its own name `delay` ms after it starts. */
async function app(name: string, port: number, delay: number): Promise<{ id: string; name: string }> {
  const dir = hq.repo(name)
  fs.writeFileSync(path.join(dir, 'server.js'), `setTimeout(() => require('http').createServer((q, s) => s.end(${JSON.stringify(name)})).listen(${port}), ${delay})\n`)
  sh(dir, 'commit', '-qam', 'listen late on a fixed port')
  const repo = (await hq.api('repos', { path: dir })).json
  const recipe = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port }], show: 'app', worktree_files: [], notes: `Port ${port} is hard-wired.` }
  const db = hq.db() // the start steps as the Launch helper saves them once the user has OK'd them
  try { db.prepare("INSERT OR REPLACE INTO previews(id, recipe, status, updated_at) VALUES (?, ?, 'stopped', 1)").run(repo.id, JSON.stringify(recipe)) } finally { db.close() }
  return { id: repo.id, name }
}
const running = (id: string) => waitFor(`${id} running`, async () => { const x = await preview(id); return x.status === 'running' ? x : null }, 30_000)
const re = (s: string) => s.replace(/[.()]/g, '\\$&')

test('Bug 362: two apps with the same fixed port started together: one runs, the other is refused and names the first', async () => {
  const port = await freePort(), [a, b] = await Promise.all([app('b362a', port, 2000), app('b362b', port, 2000)])
  const rs = await Promise.all([a!, b!].map((x) => hq.api(`previews/${x.id}/start`, {})))
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs.map((r) => r.json)))
  const won = rs[0]!.status === 200 ? a! : b!, lost = won === a ? b! : a!, refused = rs.find((r) => r.status === 409)!.json.error
  const says = `Can't start ${lost.name}: port ${port} (app) is being used by ${won.name}'s app. Stop ${won.name}'s app, then start ${lost.name} again.`
  assert.equal(refused, says)
  let p = await preview(lost.id); assert.equal(p.status, 'stopped'); assert.equal(p.detail, says); assert.equal(p.port_holders, null) // the plain Start button stays
  const up = await running(won.id); assert.equal(await page(up.url), won.name)
  assert.equal((await preview(lost.id)).status, 'stopped') // never started, so it never crashed

  // Once the first listens, a start of the other names its program as any held port does (Bug 42), with the button that stops it
  const again = await hq.api(`previews/${lost.id}/start`, {}); assert.equal(again.status, 409)
  assert.match(again.json.error, new RegExp(`^Can't start ${lost.name}: port ${port} \\(app\\) is being used by ${won.name} \\(node, pid \\d+\\)\\. Stop it here, then Launch\\.$`))
  p = await preview(lost.id); assert.deepEqual(p.port_holders.map((h: any) => [h.kind, h.name, h.port]), [['repo', won.name, port]])

  // Stopped, the port is free again for the other
  assert.equal((await hq.api(`previews/${won.id}/stop`, {})).status, 200)
  const next = await hq.api(`previews/${lost.id}/start`, {}); assert.equal(next.status, 200, JSON.stringify(next.json))
  assert.equal(await page((await running(lost.id)).url), lost.name)
  await hq.api(`previews/${lost.id}/stop`, {})
})

test('Bug 362: a fixed port is refused while the other app is still starting, and a restart of that app keeps it', async () => {
  const port = await freePort(), [a, b] = await Promise.all([app('b362c', port, 4000), app('b362d', port, 0)])
  assert.equal((await hq.api(`previews/${a!.id}/start`, {})).status, 200); assert.equal((await preview(a!.id)).status, 'starting')
  const rb = await hq.api(`previews/${b!.id}/start`, {}); assert.equal(rb.status, 409)
  assert.match(rb.json.error, new RegExp(re(`port ${port} (app) is being used by b362c's app. Stop b362c's app, then start b362d again.`)))
  const ra = await hq.api(`previews/${a!.id}/start`, {}); assert.equal(ra.status, 200, JSON.stringify(ra.json)) // its own port is never in its way
  assert.equal(await page((await running(a!.id)).url), 'b362c')
  await hq.api(`previews/${a!.id}/stop`, {})
})

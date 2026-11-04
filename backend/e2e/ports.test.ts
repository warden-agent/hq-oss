// Bug 44: the preview never shows another program as the app. Each test HQ hands out its own ports (two HQs sharing a range
// picked the same free port before either app was up), and when another program listens on the app's port too (one on IPv6
// and one on 127.0.0.1 can share it, and localhost may reach either), HQ stops the app and names that program instead.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
const kids: ChildProcess[] = []
before(async () => { hq = await startHq() })
after(async () => { for (const k of kids) { try { process.kill(-k.pid!, 'SIGKILL') } catch { /* gone */ } } await hq?.stop() })

const preview = async (repoId: string) => (await hq.state()).previews.find((p: any) => p.id === repoId)
const page = async (url: string) => (await fetch(url)).text()
/** Another program on `port`, IPv6 loopback only. */
function squatter(port: number): ChildProcess {
  const k = spawn(process.execPath, ['-e', `require('http').createServer((q, s) => s.end('squatter')).listen(${port}, '::1')`], { detached: true, stdio: 'ignore' })
  kids.push(k); return k
}
const answers = (port: number) => waitFor('the squatter', async () => (await fetch(`http://[::1]:${port}/`).catch(() => null))?.ok)
/** A repo whose `npm start` serves `body` on 127.0.0.1 after `delay` ms. */
function app(name: string, body: string, delay: number): string {
  const dir = hq.repo(name)
  fs.writeFileSync(path.join(dir, 'server.js'), `setTimeout(() => require('http').createServer((q, s) => s.end(${JSON.stringify(body)})).listen(process.env.PORT, '127.0.0.1'), ${delay})\n`)
  sh(dir, 'commit', '-qam', 'listen on 127.0.0.1'); return dir
}

test('Bug 44: this HQ hands out ports of its own, not 3090-3099', () => {
  const [lo, hi] = hq.env.HQ_PREVIEW_PORTS!.split('-').map(Number)
  assert.equal(hi! - lo!, 9); assert.ok(lo! > 3099 || hi! < 3090, `${lo}-${hi}`)
})

test('Bug 44: a program that takes the port on IPv6 while the app starts is named, never shown', async () => {
  const repo = (await hq.api('repos', { path: app('race', 'ours', 2500) })).json
  await hq.api(`previews/${repo.id}/command`, { command: 'npm start' })
  let r = await hq.api(`previews/${repo.id}/start`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  const port: number = r.json.port, other = squatter(port); await answers(port) // in the 2.5 s before the app listens
  const p = await waitFor('the clash', async () => { const x = await preview(repo.id); return x.port_holders?.length ? x : null }, 20_000)
  assert.equal(p.status, 'stopped'); assert.equal(p.url, null)
  assert.deepEqual(p.port_holders.map((x: any) => [x.pid, x.port, x.part, x.cmd]), [[other.pid, port, 'app', 'node']])
  assert.match(p.detail, new RegExp(`^Can't show race: port ${port} \\(app\\) is being used by node .* as well, so the page could be that program instead of race\\. Stop it here, then Launch\\.$`))
  const events = (await hq.api('events?limit=50')).json
  assert.ok(!events.some((e: any) => e.kind === 'preview.running'), 'never shown as running')
  assert.ok(events.some((e: any) => e.kind === 'preview.error' && JSON.parse(e.payload).error === p.detail))

  // Stop it and Launch: the squatter goes and the page is the app's own
  r = await hq.api(`previews/${repo.id}/free-port`, { pids: [other.pid] }); assert.equal(r.status, 200, JSON.stringify(r.json))
  const up = await waitFor('the app', async () => { const x = await preview(repo.id); return x.status === 'running' ? x : null }, 20_000)
  assert.equal(await page(up.url), 'ours')
  await hq.api(`previews/${repo.id}/stop`, {})
})

test('Bug 44: a port something holds on IPv6 alone is skipped when HQ picks one', async () => {
  const lo = Number(hq.env.HQ_PREVIEW_PORTS!.split('-')[0]); squatter(lo); await answers(lo)
  const repo = (await hq.api('repos', { path: app('v6', 'v6 app', 0) })).json
  await hq.api(`previews/${repo.id}/command`, { command: 'npm start' })
  const r = await hq.api(`previews/${repo.id}/start`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.notEqual(r.json.port, lo)
  const up = await waitFor('the app', async () => { const x = await preview(repo.id); return x.status === 'running' ? x : null }, 20_000)
  assert.equal(await page(up.url), 'v6 app')
})

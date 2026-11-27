// Bug 409: an app whose start steps hard-wire a port Node's fetch refuses (6000, 6665–6669, 5060, 10080: the browsers' "bad port" list) answered (curl
// got its page), but HQ's probe was a fetch, which throws "bad port" without trying, so the preview stayed "starting…" for good. The probe is node:http now.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'
import { BAD_PORTS } from '../src/badports.ts'
import { portBusy } from '../src/apprun.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

const preview = async (repoId: string) => (await hq.state()).previews.find((p: any) => p.id === repoId)
/** The page at a URL, read with node:http (fetch refuses these ports too). */
const page = (url: string): Promise<string> => new Promise((resolve, reject) => {
  http.get(url, (res) => { let s = ''; res.on('data', (d) => { s += d }); res.on('end', () => resolve(s)) }).on('error', reject)
})

test('Bug 409: an app hard-wired to a port fetch refuses goes "running", and the pane says browsers won\'t open it', async () => {
  let port = 0 // the first one above 1023 that nothing on this machine holds (other programs may hold 6000, say)
  for (const p of BAD_PORTS) if (p > 1023 && !(await portBusy(p))) { port = p; break }
  assert.ok(port, 'every bad port above 1023 is in use here')
  const name = 'b409a', dir = hq.repo(name)
  fs.writeFileSync(path.join(dir, 'server.js'), `require('http').createServer((q, s) => s.end(${JSON.stringify(name)})).listen(${port})\n`)
  sh(dir, 'commit', '-qam', 'listen on a fixed port browsers refuse')
  const repo = (await hq.api('repos', { path: dir })).json
  const recipe = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port }], show: 'app', worktree_files: [], notes: `Port ${port} is hard-wired.` }
  const db = hq.db() // the start steps as the Launch helper saves them once the user has OK'd them
  try { db.prepare("INSERT OR REPLACE INTO previews(id, recipe, status, updated_at) VALUES (?, ?, 'stopped', 1)").run(repo.id, JSON.stringify(recipe)) } finally { db.close() }
  const r = await hq.api(`previews/${repo.id}/start`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  const up = await waitFor(`${name} running`, async () => { const x = await preview(repo.id); return x.status === 'running' ? x : null }, 30_000)
  assert.equal(up.url, `http://localhost:${port}/`); assert.equal(up.port, port)
  assert.equal(await page(up.url), name)
  assert.match(up.detail, new RegExp(`^Browsers won't open port ${port} \\(they block it as unsafe\\)`)) // why its frame and ↗ show nothing
  assert.equal((await hq.api(`previews/${repo.id}/stop`, {})).status, 200)
})

test('Bug 409: an app on a port HQ hands out has no such note (must not catch)', async () => {
  const name = 'b409b', dir = hq.repo(name)
  fs.writeFileSync(path.join(dir, 'server.js'), `require('http').createServer((q, s) => s.end(${JSON.stringify(name)})).listen(Number(process.env.PORT))\n`)
  sh(dir, 'commit', '-qam', 'listen on PORT')
  const repo = (await hq.api('repos', { path: dir })).json
  const recipe = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port: 'auto' }], show: 'app', worktree_files: [], notes: '' }
  const db = hq.db()
  try { db.prepare("INSERT OR REPLACE INTO previews(id, recipe, status, updated_at) VALUES (?, ?, 'stopped', 1)").run(repo.id, JSON.stringify(recipe)) } finally { db.close() }
  const r = await hq.api(`previews/${repo.id}/start`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  const up = await waitFor(`${name} running`, async () => { const x = await preview(repo.id); return x.status === 'running' ? x : null }, 30_000)
  assert.equal(await page(up.url), name); assert.equal(up.detail, null)
  assert.equal((await hq.api(`previews/${repo.id}/stop`, {})).status, 200)
})

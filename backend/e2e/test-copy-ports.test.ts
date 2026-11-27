// Bug 410: HQ's own test copy of project A's app (its look, here) runs on A's fixed port, and project B's start steps hard-wire the same port. The copy
// may not listen yet (installing, starting), so the port looked free and B's preview started on it, then read "running" off the copy's page. Now a port
// a test copy was given counts as taken for every project's preview start until that test's checkout is gone, and the refused start says whose test it
// is. macOS only: on Linux a test run has a network of its own (bubblewrap), so its copy never holds a port of the machine's.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'
import { checkOf } from '../src/hqcheckrules.ts'

const mac = process.platform === 'darwin'
let hq: Hq
// HQ_LOOK_RUNNER: no browser here; the look runs fake-look.mjs in the same sandbox and checkout, after HQ has settled the copy's ports
before(async () => { if (mac) hq = await startHq({ env: { HQ_LOOK_RUNNER: path.join(import.meta.dirname, 'fake-look.mjs'), HQ_UITEST_BROWSER_EXE: '/usr/bin/false' } }) })
after(async () => { await hq?.stop() })

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
})
const preview = async (repoId: string) => (await hq.state()).previews.find((p: any) => p.id === repoId)
const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
/** A project whose OK'd start steps run `node server.js` on the fixed `port` (it serves its own name), with `npm test` and one passing test. */
async function project(name: string, port: number): Promise<{ id: string; name: string; dir: string }> {
  const dir = hq.repo(name)
  const files = { 'server.js': `require('http').createServer((q, s) => s.end(${JSON.stringify(name)})).listen(${port})\n`,
    'package.json': JSON.stringify({ name, private: true, scripts: { test: 'node --test' } }), 'test/ok.test.js': "require('node:test').test('ok', () => {})\n" }
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text) }
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'an app on a fixed port')
  const repo = (await hq.api('repos', { path: dir })).json
  const recipe = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port }], show: 'app', worktree_files: [], notes: `Port ${port} is hard-wired.` }
  const db = hq.db() // the start steps as the Launch helper saves them once the user has OK'd them
  try { db.prepare("INSERT OR REPLACE INTO previews(id, recipe, status, updated_at) VALUES (?, ?, 'stopped', 1)").run(repo.id, JSON.stringify(recipe)) } finally { db.close() }
  return { id: repo.id, name, dir }
}
/** A finished ticket on `p` whose commit holds the look where it is (fake-look.mjs waits for a file `go` in its checkout). */
async function finished(p: { id: string; dir: string }): Promise<any> {
  const f = (await hq.api('features', { repoId: p.id, title: 'Held look', request: 'A change to look at' })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'A change', size: 'S', spec: 'A change.' })).json, eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  const wt = path.join(p.dir, '.claude', 'worktrees', t.key)
  fs.writeFileSync(path.join(wt, 'look.json'), JSON.stringify({ wait: 'go' })); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', t.title)
  await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: `toolu_${eng.id}_1` })
  await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(eng.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone', feature_map_unchanged: true }); assert.equal(r.isError, false, r.text)
  await waitFor(`${t.key} finished`, async () => (await tk(t))?.status === 'pr_ready')
  return t
}
/** The test checkout whose look (fake-look.mjs) is running now: by then HQ has settled the copy's ports. */
const looking = (dir: string) => waitFor('HQ\'s look to be under way', () => {
  const at = path.join(dir, '.claude', 'worktrees'), lines = execFileSync('ps', ['-axww', '-o', 'args='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('fake-look.mjs'))
  const wts = fs.existsSync(at) ? fs.readdirSync(at).filter((d) => d.startsWith('hq-test-')).map((d) => path.join(at, d)) : []
  return wts.find((w) => lines.some((l) => l.includes(w))) ?? null
}, 60_000)

test('Bug 410: a port HQ\'s test copy of one project was given is taken for every project\'s preview, and named as HQ\'s test, until that test ends', { skip: !mac }, async () => {
  const port = await freePort(), a = await project('b410a', port), b = await project('b410b', port), t = await finished(a)
  assert.equal((await hq.api(`tickets/${t.id}/check`, {})).status, 200)
  const wt = await looking(a.dir)
  // the copy doesn't listen on the port (the look's stand-in starts no app), so only HQ's own record of what it was given keeps B off it
  const says = (x: { name: string }) => `Can't start ${x.name}: port ${port} (app) is being used by HQ's own test of b410a's app. HQ's test ends by itself: start ${x.name} again once it has.`
  for (const x of [b, a]) { // another project's preview, and the tested project's own
    const r = await hq.api(`previews/${x.id}/start`, {}); assert.equal(r.status, 409, JSON.stringify(r.json)); assert.equal(r.json.error, says(x))
    const p = await preview(x.id); assert.deepEqual([p.status, p.detail, p.port_holders, p.url], ['stopped', says(x), null, null]) // no "Stop it…" for HQ's own test
  }
  fs.writeFileSync(path.join(wt, 'go'), '')
  const c = await waitFor('the check to end', async () => { const x = checkOf((await tk(t)) ?? {}); return x && x.state !== 'running' ? x : null }, 60_000)
  assert.equal(c.state, 'pass', JSON.stringify(c))
  await waitFor('its checkout gone', () => !fs.existsSync(wt))
  // the test is over: the port is free again, and B's preview runs its own app
  const r = await hq.api(`previews/${b.id}/start`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  const up = await waitFor('b410b running', async () => { const x = await preview(b.id); return x.status === 'running' ? x : null }, 30_000)
  assert.equal(await (await fetch(up.url)).text(), 'b410b')
  await hq.api(`previews/${b.id}/stop`, {})
})

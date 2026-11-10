// Try it before merging (Bug 22), end to end with fake agents (see harness.ts): the preview runs a finished ticket's worktree
// with a copy of main's data, Back to main returns to main, and merging the tried ticket puts the preview back on main (now with
// the ticket in it) while the merged worktree is still removed.
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
/** The preview restarted (a new start time), answers, and serves `text`. */
const serving = (repoId: string, after: number, text: string) => waitFor(`the preview to serve ${text.trim()}`, async () => {
  const p = await preview(repoId); if (p?.status !== 'running' || (p.started_at ?? 0) <= after) return null
  return (await page(p.url).catch(() => '')) === text ? p : null
}, 20_000)

test('Bug 22: Try it runs a finished ticket with main\'s data; Back to main; merging it ends the try', async () => {
  const dir = hq.repo('try')
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'try', request: 'Build try' })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  fs.mkdirSync(path.join(dir, 'data')); fs.writeFileSync(path.join(dir, 'data', 'stock.json'), '["apples"]') // the user's own data (git-ignored)
  await hq.api(`previews/${repo.id}/command`, { command: 'npm start' }) // the user's own command: no Launch helper, no OK
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
  let p = await serving(repo.id, 0, 'v1\n')
  const t1 = (await hq.api('tickets', { featureId: f.id, title: 'Version two', size: 'S', spec: 'v2.' })).json
  assert.match((await hq.api(`previews/${repo.id}/start`, { ticket: t1.id })).json.error, /can't be tried: only a finished ticket/) // not built yet
  const errs = (await hq.api('events?limit=50')).json.filter((e: any) => e.kind === 'preview.error').map((e: any) => JSON.parse(e.payload))
  assert.deepEqual(errs.map((p: any) => [p.ticket, /can't be tried/.test(p.error)]), [[t1.key, true]]) // Bug 39: the refused start is on record
  const eng = (await hq.api(`tickets/${t1.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  const wt = path.join(dir, '.claude', 'worktrees', t1.key)
  fs.writeFileSync(path.join(wt, 'version.txt'), 'v2\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'v2')
  fs.mkdirSync(path.join(wt, 'data')); fs.writeFileSync(path.join(wt, 'data', 'stock.json'), '["test item"]') // the engineer's test data
  assert.equal((await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'v2' })).isError, false)
  assert.equal((await hq.mcp(eng.id, 'open_pr', { title: 'v2', body: 'v2\n\n## Deviations from approved plan\nNone' })).isError, false)

  // Try it: the ticket's code, the user's data
  const r = await hq.api(`previews/${repo.id}/start`, { ticket: t1.id }); assert.equal(r.status, 200, JSON.stringify(r.json))
  p = await serving(repo.id, p.started_at, 'v2\n')
  assert.equal(p.ticket_id, t1.id); assert.equal(p.path, wt); assert.match(p.branch, /^hq\/try\/T-01-/)
  assert.equal(fs.readFileSync(path.join(wt, 'data', 'stock.json'), 'utf8'), '["apples"]')
  assert.equal(sh(wt, 'status', '--porcelain'), '') // ignored: nothing new for the engineer to commit
  // Back to main
  assert.equal((await hq.api(`previews/${repo.id}/start`, { ticket: null })).status, 200)
  p = await serving(repo.id, p.started_at, 'v1\n'); assert.equal(p.ticket_id, null); assert.equal(p.path, dir)
  // Try again, then merge: back on main, which now has v2, and the worktree goes as usual
  await hq.api(`previews/${repo.id}/start`, { ticket: t1.id }); p = await serving(repo.id, p.started_at, 'v2\n')
  const m = await hq.api(`tickets/${t1.id}/merge`, {}); assert.equal(m.status, 200, JSON.stringify(m.json))
  p = await waitFor('the preview back on main', async () => {
    const x = await preview(repo.id); return x.ticket_id === null && x.status === 'running' && m.json.sha.startsWith(x.head) ? x : null
  }, 20_000)
  assert.equal(await page(p.url), 'v2\n'); assert.equal(p.path, dir)
  await waitFor('the merged worktree to go', () => !fs.existsSync(wt))
  assert.equal(fs.readFileSync(path.join(dir, 'data', 'stock.json'), 'utf8'), '["apples"]')
})

/** The mod hands the helper its next batch and Claude Code submits it. */
async function nextBatch(agentId: string): Promise<string> {
  const b = await waitFor('a batch for the helper', async () => (await hq.modNext(agentId)).batch)
  await hq.modEvent(agentId, { kind: 'batch_received', id: b.id }); await hq.hook(agentId, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
  return b.text
}

test('Bug 46: Try it on a new project with no start steps: Claude works them out from the ticket, OK runs the ticket, main uses them after the merge', async () => {
  const dir = hq.repo('fresh')
  for (const f of ['package.json', 'server.js', 'version.txt']) fs.rmSync(path.join(dir, f))
  sh(dir, 'commit', '-qam', 'a new project: nothing to run on main yet')
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'hello', request: 'A hello page' })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t1 = (await hq.api('tickets', { featureId: f.id, title: 'Hello page', size: 'S', spec: 'A page that says hello.' })).json
  const eng = (await hq.api(`tickets/${t1.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  const wt = path.join(dir, '.claude', 'worktrees', t1.key)
  fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ name: 'fresh', private: true, scripts: { start: 'node server.js' } }))
  fs.writeFileSync(path.join(wt, 'server.js'), "require('http').createServer((q, s) => s.end('hello page\\n')).listen(process.env.PORT)\n")
  sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'hello page')
  assert.equal((await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'hello' })).isError, false)
  assert.equal((await hq.mcp(eng.id, 'open_pr', { title: 'hello', body: 'hello\n\n## Deviations from approved plan\nNone' })).isError, false)

  // Try it: no 409; a helper starts on the ticket's code (main is empty)
  const r = await hq.api(`previews/${repo.id}/start`, { ticket: t1.id }); assert.equal(r.status, 200, JSON.stringify(r.json))
  const h = r.json.helper_agent_id; assert.match(h, /^launch-/)
  assert.equal(r.json.helper_ticket_id, t1.id); assert.equal(r.json.helper_ticket_key, t1.key)
  assert.ok(fs.existsSync(path.join(r.json.helper_worktree, 'server.js')), "the helper sees the ticket's files")
  const errs = (await hq.api('events?limit=100')).json.filter((e: any) => e.kind === 'preview.error' && JSON.parse(e.payload).repo === 'fresh')
  assert.deepEqual(errs, []) // a hand-over, not a failure
  await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching'))
  const brief = await nextBatch(h)
  assert.match(brief, new RegExp(`ticket ${t1.key}'s version \\("Hello page"\\)`)); assert.match(brief, /`npm start`/)

  // Its steps, the user's OK: the ticket runs
  const steps = { parts: [{ name: 'app', dir: '.', run: 'npm start', port: 'auto' }], show: 'app', worktree_files: [], notes: '' }
  assert.equal((await hq.mcp(h, 'save_launch', steps)).isError, false)
  assert.equal((await preview(repo.id)).helper_ticket_key, t1.key) // the OK card says "from T…'s version"
  assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  let p = await serving(repo.id, 0, 'hello page\n')
  assert.equal(p.ticket_id, t1.id); assert.equal(p.path, wt)
  const heard = new RegExp(`Real run on ${t1.key}'s version: the page answered`)
  await waitFor('the helper to hear how it went', async () => (await hq.state()).messages.find((m: any) => m.to_id === h && heard.test(m.body)))
  assert.equal((await hq.mcp(h, 'launch_ok')).isError, false)
  p = await waitFor('the helper to go', async () => { const x = await preview(repo.id); return x.helper_agent_id === null ? x : null })
  assert.equal(p.helper_ticket_id, null); assert.equal(p.ticket_id, t1.id); assert.equal(p.status, 'running')

  // Merged: main has the app now and runs with the same steps
  const m = await hq.api(`tickets/${t1.id}/merge`, {}); assert.equal(m.status, 200, JSON.stringify(m.json))
  p = await waitFor('the preview on main', async () => {
    const x = await preview(repo.id); return x.ticket_id === null && x.status === 'running' && m.json.sha.startsWith(x.head) ? x : null
  }, 20_000)
  assert.equal(await page(p.url), 'hello page\n'); assert.equal(p.path, dir); assert.equal(p.recipe.parts[0].run, 'npm start')
})

test('Bug 67: Try it on a main with no files at all still gets a helper: the ticket has them', async () => {
  const parent = path.join(hq.root, 'new-projects'); fs.mkdirSync(parent, { recursive: true })
  const repo = (await hq.api('repos/new', { name: 'truly empty', parent, github: false })).json; assert.equal(repo.empty, 1)
  const f = (await hq.api('features', { repoId: repo.id, title: 'hello', request: 'A hello page' })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Hello page', size: 'S', spec: 'A page.' })).json, eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  const wt = path.join(repo.path, '.claude', 'worktrees', t.key)
  fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ name: 'empty', private: true, scripts: { start: 'node server.js' } }))
  fs.writeFileSync(path.join(wt, 'server.js'), "require('http').createServer((q, s) => s.end('hello\\n')).listen(process.env.PORT)\n")
  sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'hello page')
  assert.equal((await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'hello' })).isError, false)
  assert.equal((await hq.mcp(eng.id, 'open_pr', { title: 'hello', body: 'hello\n\n## Deviations from approved plan\nNone' })).isError, false)
  const r = await hq.api(`previews/${repo.id}/start`, { ticket: t.id }); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.match(r.json.helper_agent_id, /^launch-/); assert.equal(r.json.helper_ticket_id, t.id); assert.ok(fs.existsSync(path.join(r.json.helper_worktree, 'server.js')))
  await hq.api(`previews/${repo.id}/dismiss`, {})
})

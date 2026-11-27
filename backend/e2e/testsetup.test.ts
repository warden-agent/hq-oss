// The test setup helper end to end (testsetup.ts, Tester & Checker Part 3; Bug 417), with a fake Claude (see harness.ts): the tests act as the helper and
// press what a user presses. Asked from the preview's ⚙, a helper starts in a throwaway worktree with localhost only; it saves a setup, HQ checks it for
// real (seed, start, open the page, reset, open it again: the browser's stand-in is fake-scenario.mjs, under the real recorder and sandbox) and messages it
// what happened; a setup that passes is saved, the user hears so, and the session and its worktree end. A Stop by the user, from the pane or the Agent tab,
// ends it as the user's own act; a helper that ends by itself still says so.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_SCENARIO_RUNNER: path.join(import.meta.dirname, 'fake-scenario.mjs'), HQ_LOOK_RUNNER: path.join(import.meta.dirname, 'fake-look.mjs') } }) })
after(async () => { await hq?.stop() })

/** Like many small apps: reads its data once, at start, from data/ (git-ignored). */
const SERVER = `const http=require('http'),fs=require('fs');const items=JSON.parse(fs.readFileSync('data/items.json','utf8'));
http.createServer((q,r)=>{ if(q.url==='/'){r.writeHead(200,{'content-type':'text/html'});return r.end('<h1>Larder</h1><p>'+items.length+' items</p>')}
 r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify(items))}).listen(process.env.PORT,'127.0.0.1')\n`
const SEED = `mkdir -p data && printf '[{"id":"s1","name":"rice"}]' > data/items.json`
const GOOD = { start: [{ part: 'app', run: 'node server.js' }], snapshot: ['data'], seed: SEED, endpoints: [{ method: 'GET', path: '/api/items', kind: 'instant' }], notes: '' }
const MINE = JSON.stringify([{ id: 'mine', name: 'the user\'s own' }])

/** A project whose app keeps its data in data/, with the user's own start command (⚙), so HQ knows how to start it. */
async function project(name: string) {
  const dir = hq.repo(name)
  fs.writeFileSync(path.join(dir, 'server.js'), SERVER); sh(dir, 'commit', '-qam', 'the app')
  fs.mkdirSync(path.join(dir, 'data')); fs.writeFileSync(path.join(dir, 'data', 'items.json'), MINE) // the user's own data, never HQ's to touch
  const repo = (await hq.api('repos', { path: dir })).json
  assert.equal((await hq.api(`previews/${repo.id}/command`, { command: 'node server.js' })).status, 200)
  return { dir, repo }
}
type P = Awaited<ReturnType<typeof project>>
const setup = async (p: P) => (await hq.state()).previews.find((x: any) => x.id === p.repo.id)?.test_setup
const ask = async (p: P, action?: string) => assert.equal((await hq.api(`previews/${p.repo.id}/test-setup`, action ? { action } : {})).status, 200)
/** The helper HQ started for this project, once it is running. */
const helper = (p: P, not: string[] = []) => waitFor('a test setup helper', async () => { const id = (await setup(p))?.helper_agent_id
  return id && !not.includes(id) ? (await hq.state()).agents.find((a: any) => a.id === id && a.status === 'working') : null }, 30_000)
/** The mod hands the helper its next batch and Claude Code submits it. */
async function nextBatch(agentId: string): Promise<string> {
  const b = await waitFor('a batch for the helper', async () => (await hq.modNext(agentId)).batch, 60_000)
  await hq.modEvent(agentId, { kind: 'batch_received', id: b.id }); await hq.hook(agentId, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
  return b.text
}
const over = (p: P) => waitFor('the helper to be over', async () => { const s = await setup(p); return s && !s.working ? s : null }, 30_000)
const leftovers = (p: P) => { const d = path.join(p.dir, '.claude', 'worktrees'); return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.startsWith('testsetup-')) : [] }
/** The helper's worktree and branch are gone, and the agent has exited (HQ removes them as the job ends, just after the page hears it is over). */
const gone = async (p: P, id: string) => {
  await waitFor('the helper\'s worktree and branch to go', () => leftovers(p).length === 0 && sh(p.dir, 'branch', '--list', 'hq-testsetup/*') === '')
  await waitFor('the helper to exit', async () => (await hq.state()).agents.find((a: any) => a.id === id)?.status === 'exited')
}
const lines = async (id: string): Promise<string[]> => ((await hq.api(`agents/${id}/events`)).json.events as any[]).map((e) => e.text)
/** Its Events tab has this line (the job's end is logged as its worktree goes, just after the page hears it is over). */
const said = (id: string, line: string) => waitFor(`"${line}" in its Events tab`, async () => (await lines(id)).includes(line))
const notices = async (kind: string) => (await hq.state()).attention.filter((a: any) => a.kind === kind && !a.resolved_at)

test('Bug 417: the test setup helper\'s session: localhost only, a save refused at once, one HQ\'s check fails, one that passes; HQ saves it and ends the session', async () => {
  const p = await project('b417set')
  await ask(p)
  const h = await helper(p)
  // localhost only, as its instructions say for this job (the Launch and test steps helpers also reach the package registries)
  const net = JSON.parse(fs.readFileSync(path.join(hq.hqHome, 'agents', h.id, 'settings.json'), 'utf8')).sandbox.network.allowedDomains
  assert.deepEqual(net, ['127.0.0.1', 'localhost', '[::1]'])
  const role = fs.readFileSync(path.join(import.meta.dirname, '..', 'roles', 'launcher.prompt.md'), 'utf8')
  assert.match(role, /\. For the test setup it reaches localhost only: nothing can be downloaded/)
  const first = await nextBatch(h.id)
  assert.match(first, /^Project: b417set\. Your job this time is the TEST SETUP \(the "Test setup" section of your instructions\), not the start steps\.\n\n/)
  assert.match(first, /The start steps HQ uses for the live preview \(the parts your setup must cover, by name\):\n[^]*"name": "app"[^]*"run": "node server\.js"/)
  assert.equal((await setup(p)).state, 'working')
  const wt = path.join(p.dir, '.claude', 'worktrees', leftovers(p)[0]!); assert.ok(fs.existsSync(path.join(wt, 'server.js')), 'a worktree of main')

  // a setup HQ can't run is refused at once, and doesn't count as a save
  const bad = await hq.mcp(h.id, 'save_test_setup', { ...GOOD, start: [{ part: 'web', run: 'node server.js' }] })
  assert.equal(bad.isError, true); assert.match(bad.text, /^Not saved: start: "web" isn't a part of the start steps \(app\)\. Fix it and call save_test_setup again\.$/)

  // a seed that writes nothing: HQ runs it for real and sends back what's wrong; nothing is kept
  const empty = await hq.mcp(h.id, 'save_test_setup', { ...GOOD, seed: 'true' })
  assert.equal(empty.isError, false, empty.text); assert.match(empty.text, /^Saved\. HQ now runs it for real in its own sandbox/)
  assert.equal((await setup(p)).state, 'checking')
  assert.equal((await hq.mcp(h.id, 'save_test_setup', GOOD)).isError, true) // not while HQ checks the last one
  const failed = await nextBatch(h.id)
  assert.match(failed, /^\[fyi\] from HQ \[msg [\w-]+\]: HQ's check of your test setup failed: [^]*seed command wrote none of data[^]*\n\nFix it and call save_test_setup again\.$/)
  let s = await setup(p); assert.equal(s.setup, null); assert.equal(s.state, 'working'); assert.equal(s.working, true)

  // a setup that works: HQ's check passes, the setup is saved, the user hears so, and the session ends
  assert.equal((await hq.mcp(h.id, 'save_test_setup', GOOD)).isError, false)
  const passed = await nextBatch(h.id)
  assert.match(passed, /^\[fyi\] from HQ \[msg [\w-]+\]: HQ's check passed: .+\. HQ saved your setup and ends your session now; do nothing else\.$/)
  s = await over(p)
  assert.deepEqual(s.setup, GOOD); assert.equal(s.by, 'Claude (test setup)'); assert.equal(s.checked.ok, true); assert.equal(s.seen, false); assert.equal(s.state, null)
  const good = await notices(`repo_testsetup_ok:${p.repo.id}`)
  assert.equal(good.length, 1); assert.equal(good[0].detail, 'b417set: Claude worked out how HQ tests the app (production start, a clean seed, resets). See it under ⚙ in the preview.')
  await gone(p, h.id)
  await said(h.id, 'Done with the test setup')
  assert.equal(fs.readFileSync(path.join(p.dir, 'data', 'items.json'), 'utf8'), MINE) // HQ's check ran in its own checkout
  assert.equal(sh(p.dir, 'status', '--porcelain'), '')
  await ask(p, 'dismiss'); assert.equal((await setup(p)).seen, true) // "Got it"
})

test('Bug 417: the user\'s Stop, from the pane or the Agent tab, ends the helper as theirs (no "Claude stopped" banner, its Events tab says so); one that quits by itself says it did', async () => {
  const p = await project('b417stop')
  // the Agent tab's Stop
  await ask(p); const h1 = await helper(p); await nextBatch(h1.id)
  assert.equal((await hq.api(`agents/${h1.id}/stop`, {})).status, 200)
  let s = await over(p); assert.equal(s.state, null); assert.equal(s.note, null) // was: failed, "Claude stopped before it finished."
  await gone(p, h1.id)
  await said(h1.id, 'You stopped it'); await said(h1.id, 'Done with the test setup: you stopped Claude before it finished')
  assert.equal((await notices(`repo_testsetup:${p.repo.id}`)).length, 0)
  // the pane's own Stop Claude: the same end
  await ask(p); const h2 = await helper(p, [h1.id]); await nextBatch(h2.id)
  await ask(p, 'dismiss')
  s = await over(p); assert.equal(s.state, null); assert.equal(s.note, null); await gone(p, h2.id)
  await said(h2.id, 'Done with the test setup: you stopped Claude before it finished')
  // what the rule must not catch: a helper whose session ends by itself
  await ask(p); const h3 = await helper(p, [h1.id, h2.id]); await nextBatch(h3.id)
  await hq.hook(h3.id, { hook_event_name: 'SessionEnd', reason: 'other' })
  s = await over(p); assert.equal(s.state, 'failed'); assert.equal(s.note, 'Claude stopped before it finished.')
  await said(h3.id, 'Done with the test setup, with no setup that works: Claude stopped before it finished.'); await gone(p, h3.id)
})

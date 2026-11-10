// Remove from HQ (Bug 66), end to end with fake agents (see harness.ts): what's running in the project stops at once, with no handoff notes, another project carries on, the
// folder stays as it was, a test run in flight dies with nothing to follow it, and adding the folder back makes a new project whose tickets can't land on the old work.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
beforeEach(async () => { hq = await startHq({ env: { HQ_AUTO_SOON_MS: '100', HQ_AUTO_TICK_MS: '500', HQ_REMOVE_SETTLE_MS: '3000' } }) })
afterEach(async () => { await hq?.stop() })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const answers = (port: number) => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)
const running = (mark: string) => execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').some((l) => l.startsWith(mark))

async function project(name: string, tests = false) {
  const dir = hq.repo(name)
  if (tests) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true, scripts: { start: 'node server.js', test: 'node --test' } }))
    fs.mkdirSync(path.join(dir, 'test')); fs.writeFileSync(path.join(dir, 'test', 'ok.test.js'), "require('node:test').test('ok',()=>{})\n"); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
  }
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f, tpm }
}
const ticket = async (f: any, title: string) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
const engineer = (t: any) => waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
const folder = (d: string) => ({ status: sh(d, 'status', '--porcelain'), log: sh(d, 'log', '--all', '--format=%H'), branches: sh(d, 'branch', '-a'), worktrees: sh(d, 'worktree', 'list') })

test('Bug 66: everything running in the project stops with no note, another project carries on, and the folder stays as it was', async () => {
  const a = await project('going'), b = await project('staying')
  await hq.api(`previews/${a.repo.id}/command`, { command: 'npm start' }); assert.equal((await hq.api(`previews/${a.repo.id}/start`, {})).status, 200)
  const port = await waitFor('the app', async () => { const p = (await hq.state()).previews.find((x: any) => x.id === a.repo.id); return p.status === 'running' ? p.port : null }, 20_000)
  const t = await ticket(a.f, 'Half done'), e = (await hq.api(`tickets/${t.id}/launch`, {})).json;
  await waitFor('the engineer', async () => (await hq.state()).agents.find((x: any) => x.id === e.id && x.status === 'working'))
  const wt = path.join(a.dir, '.claude', 'worktrees', t.key); fs.writeFileSync(path.join(wt, 'half.txt'), 'not committed\n')
  const before = folder(a.dir), wtBefore = sh(wt, 'status',
    '--porcelain'), sessions = (hq.tmux('ls', '-F', '#S').match(/\S+/g) ?? []).filter((s) => s.includes(e.id) || s.includes(a.tpm.id) || s.includes(a.repo.id))
  assert.equal(sessions.length, 3) // the TPM, the engineer and the app
  const r = await hq.api(`repos/${a.repo.id}/remove`, { landing: b.repo.id }); assert.equal(r.status, 200, JSON.stringify(r.json))
  const s = await hq.state()
  assert.equal(s.repos.some((x: any) => x.id === a.repo.id), false); assert.equal(s.previews.some((x: any) => x.id === a.repo.id), false);
  assert.equal(s.agents.some((x: any) => x.repo_id === a.repo.id), false)
  assert.equal(s.agents.find((x: any) => x.id === b.tpm.id).status, 'working')
  assert.deepEqual((hq.tmux('ls', '-F', '#S').match(/\S+/g) ?? []).filter((x) => sessions.includes(x)), [])
  assert.equal(await answers(port), false)
  assert.deepEqual(folder(a.dir), before); assert.equal(sh(wt, 'status', '--porcelain'), wtBefore)
  assert.equal(s.attention.some((x: any) => x.kind === `project_removed:${b.repo.id}` && /Its folder wasn't touched/.test(x.detail)), true)
  const events = (await hq.api('events?limit=500')).json as any[]
  assert.equal(events.some((x) => /^fresh_start/.test(x.kind)), false, 'nobody was asked for a note')
  await wait(1500); assert.equal((await hq.state()).repos.some((x: any) => x.id === a.repo.id), false) // nothing brings it back
  assert.equal(fs.existsSync(path.join(hq.hqHome, 'workspaces', `repo-${a.repo.id}`)), false); assert.equal(fs.existsSync(path.join(hq.hqHome, 'previews', a.repo.id)), false)
})

test('Bug 66: a test run in flight dies with it, nothing follows from it, and the freed slot goes to another project', async () => {
  const MARK = `sleep 59.${process.pid}`, a = await project('testing', true), b = await project('waiting', true) // no other file's: they run at once
  await hq.api('settings', { key: 'concurrency_cap', value: 1 })
  assert.equal((await hq.api(`repos/${a.repo.id}/test-cmd`, { cmd: MARK })).status, 200); assert.equal((await hq.api(`repos/${a.repo.id}/auto`, { on: true })).status, 200)
  const t = await ticket(a.f, 'Thing'); await hq.hook(a.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Split done.' }); const e = await engineer(t)
  await hq.hook(e.id, exitPlanMode('Plan')); const wt = path.join(a.dir, '.claude', 'worktrees', t.key); fs.writeFileSync(path.join(wt, 'thing.txt'), 'x\n'); sh(wt, 'add', '.');
  sh(wt, 'commit', '-qm', 'thing')
  await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' });
  assert.equal((await hq.mcp(e.id, 'open_pr', { title: 'Thing', body: 'Thing.\n\n## Deviations from approved plan\nNone' })).isError, false)
  await waitFor('the test run', () => running(MARK), 15_000)
  const tb = await ticket(b.f, 'Next'), head = sh(a.dir, 'rev-parse', 'main')
  const r = await hq.api(`repos/${a.repo.id}/remove`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  await waitFor('the test run to end', () => !running(MARK), 4000); await wait(1500); assert.equal(running(MARK), false)
  assert.equal(sh(a.dir, 'rev-parse', 'main'), head, 'nothing merged'); assert.equal((await hq.state()).repos.some((x: any) => x.id === a.repo.id), false)
  assert.deepEqual(fs.readdirSync(path.join(a.dir, '.claude', 'worktrees')).filter((d) => d.startsWith('hq-test-')), []) // HQ's own scratch
  assert.equal((await hq.api(`tickets/${tb.id}/launch`, {})).status, 200) // the slot it held is free
})

test('Bug 66: a Launch helper\'s scratch worktree goes, an engineer\'s stays, and the folder can be added back as a new project', async () => {
  const a = await project('again'); fs.rmSync(path.join(a.dir, 'package.json')); sh(a.dir, 'add', '-A'); sh(a.dir, 'commit', '-qm', 'no start script')
  const t = await ticket(a.f, 'Old work'), e = (await hq.api(`tickets/${t.id}/launch`, {})).json;
  await waitFor('the engineer', async () => (await hq.state()).agents.find((x: any) => x.id === e.id && x.status === 'working'))
  const wt = path.join(a.dir, '.claude', 'worktrees', t.key), old = (await hq.state()).tickets.find((x: any) => x.id === t.id).branch; fs.writeFileSync(path.join(wt, 'old.txt'), 'kept\n')
  const h = (await hq.api(`previews/${a.repo.id}/start`, {})).json; assert.match(h.helper_agent_id, /^launch-/); const scratch = h.helper_worktree
  assert.equal((await hq.api(`repos/${a.repo.id}/remove`, {})).status, 200)
  assert.equal(fs.existsSync(scratch), false); assert.equal(fs.existsSync(path.join(wt, 'old.txt')), true); assert.ok(sh(a.dir, 'branch', '--list', old))
  const back = (await hq.api('repos', { path: a.dir })).json; assert.notEqual(back.id, a.repo.id)
  const s = await hq.state(); assert.equal(s.features.some((f: any) => f.repo_id === back.id), false); assert.equal(s.tickets.some((x: any) => x.id === t.id), false)
  assert.ok(back.next_ticket > Number(/\d+/.exec(t.key)![0]), `${back.next_ticket} is past ${t.key}`)
  const f = (await hq.api('features', { repoId: back.id, title: 'again', request: 'Start over' })).json, t2 = await ticket(f, 'New work')
  assert.notEqual(t2.key, t.key); const e2 = (await hq.api(`tickets/${t2.id}/launch`, {})).json; assert.match(e2.id, /^eng-/, JSON.stringify(e2))
  assert.equal(fs.readFileSync(path.join(wt, 'old.txt'), 'utf8'), 'kept\n')
})

test('Bug 66: while a project is on its way out nothing new starts there; the last one leaves HQ empty, and that works', async () => {
  const a = await project('last'); assert.equal((await hq.api(`repos/${a.repo.id}/remove`, {})).status, 200)
  const s = await hq.state(); assert.deepEqual(s.repos, []); assert.equal((await hq.api(`repos/${a.repo.id}/message`, { body: 'hi' })).status, 409)
  assert.equal((await hq.api(`repos/${a.repo.id}/remove`, {})).status, 409)
})

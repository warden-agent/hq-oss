// Bug 76 end to end (see harness.ts): builds and full test runs take turns across the machine. An engineer's command is held at its PreToolUse hook (what
// Claude Code waits for before it starts a command) until the one running ends; its box says it's waiting; small commands never wait; HQ's own test of a
// finished ticket waits in the same line; and nothing waits for good.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, pendingAfter, type Hq } from './harness.ts'

let hq: Hq
before(async () => {
  hq = await startHq({ env: { HQ_TURN_WAIT_S: '6', HQ_AUTO_SOON_MS: '100', HQ_AUTO_TICK_MS: '500' } }); await hq.api('settings', { key: 'concurrency_cap', value: 20 })
})
after(async () => { await hq?.stop() })

async function project(name: string) {
  const dir = hq.repo(name)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true, scripts: { start: 'node server.js', test: 'node --test' } }))
  fs.mkdirSync(path.join(dir, 'test')); fs.writeFileSync(path.join(dir, 'test', 'ok.test.js'), "require('node:test').test('ok',()=>{})\n"); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f, tpm }
}
async function engineer(name: string) {
  const p = await project(name), t = (await hq.api('tickets', { featureId: p.f.id, title: 'One', size: 'S', spec: 'One.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id)?.status === 'working')
  return { ...p, t, eng }
}
let uses = 0
/** One Bash command of an agent, as Claude Code's hooks tell it: `begin` resolves when HQ answers the PreToolUse hook (that is when the command starts). */
function bash(agentId: string, command: string, input: Record<string, unknown> = {}) {
  const use = `toolu_${++uses}`, body = { tool_name: 'Bash', tool_use_id: use, tool_input: { command, ...input } }, stop = new AbortController()
  const begin = hq.hook(agentId, { hook_event_name: 'PreToolUse', ...body }, stop.signal).catch(() => 'dropped')
  return { begin, end: () => hq.hook(agentId, { hook_event_name: 'PostToolUse', ...body }), drop: () => stop.abort() }
}
const agent = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
const events = async (kind: string) => ((await hq.api('events?limit=300')).json as any[]).filter((e) => e.kind === kind).map((e) => ({ agent: e.agent_id, ...JSON.parse(e.payload) })).reverse()

test('two engineers run their tests: the second waits its turn, its box says so, and it starts when the first ends', async () => {
  const a = await engineer('turn-a'), b = await engineer('turn-b')
  const first = bash(a.eng.id, 'npm test'); assert.deepEqual(await first.begin, {}) // nobody running: it starts at once
  const second = bash(b.eng.id, 'cd web && npm run build'); assert.ok(await pendingAfter(second.begin, 1500), 'held while the first runs')
  assert.equal((await agent(b.eng.id)).activity, 'Waiting its turn to build'); assert.equal((await agent(b.eng.id)).status, 'working')
  // small commands never wait, nor does a server started in the background (here helpers of the two engineers run them: an agent itself runs one tool at a time)
  const helper = (id: string, tool_input: Record<string, unknown>) =>
    hq.hook(id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `toolu_h${++uses}`, tool_input, agent_id: `helper-of-${id}` })
  assert.deepEqual(await helper(b.eng.id, { command: 'git status' }), {}); assert.deepEqual(await helper(a.eng.id, { command: 'npm run dev', run_in_background: true }), {})
  assert.ok(await pendingAfter(second.begin, 300), 'still held')
  await first.end(); assert.deepEqual(await second.begin, {}); assert.equal((await agent(b.eng.id)).activity, 'Running: cd web && npm run build')
  await second.end()
  const waited = await events('turns.waiting'), started = await events('turns.started')
  assert.deepEqual(waited.map((e) => [e.agent, e.what, e.behind]), [[b.eng.id, 'build', [`eng ${a.t.key}`]]]); assert.equal(started.length, 1); assert.ok(started[0]!.waitedS >= 1)
  assert.ok(!(await hq.state()).attention.some((x: any) => x.kind === 'stuck'), 'waiting is not being stuck')
  const third = bash(a.eng.id, 'npm test'); assert.deepEqual(await third.begin, {}); await third.end() // the turn came back
  // A command Claude Code refuses (a deny rule) fires its first hook and no other: HQ never hears it end. The engineer's next tool says it's over.
  const refused = bash(a.eng.id, 'npm test && git push'); assert.deepEqual(await refused.begin, {})
  const next = bash(b.eng.id, 'npm test'); assert.ok(await pendingAfter(next.begin, 1000))
  await hq.hook(a.eng.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_read', tool_input: { file_path: 'a' } }); assert.deepEqual(await next.begin, {})
  await next.end()
})

test('the limit is the user\'s to raise; one that stops waiting loses its place; and nobody waits for good', async () => {
  const a = await engineer('turn-c'), b = await engineer('turn-d'), c = await engineer('turn-e')
  const first = bash(a.eng.id, 'npm test'); await first.begin
  const second = bash(b.eng.id, 'npm test'), third = bash(c.eng.id, 'pytest -q'); assert.ok(await pendingAfter(third.begin, 1000))
  second.drop(); assert.equal(await second.begin, 'dropped') // the user pressed Esc, or the engineer was stopped
  assert.equal((await hq.api('settings', { key: 'heavy_at_once', value: 2 })).status, 200); assert.deepEqual(await third.begin, {}) // room for two now
  const fourth = bash(b.eng.id, 'npm test'); assert.ok(await pendingAfter(fourth.begin, 1000))
  await hq.hook(c.eng.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' }); assert.deepEqual(await fourth.begin, {}) // c's turn ended: its command has too
  const fifth = bash(c.eng.id, 'npm test'); assert.ok(await pendingAfter(fifth.begin, 3000)) // a's and b's never end (their hooks are lost)…
  assert.deepEqual(await fifth.begin, {}); const late = (await events('turns.started')).at(-1)! // …so after HQ_TURN_WAIT_S it goes ahead anyway
  assert.equal(late.late, true); assert.ok(late.waitedS >= 5, JSON.stringify(late))
  assert.equal((await hq.api('settings', { key: 'heavy_at_once', value: 0 })).status, 400)
  for (const x of [a, b, c]) await hq.api(`agents/${x.eng.id}/stop`, {}) // gone: what they held comes back
  await hq.api('settings', { key: 'heavy_at_once', value: 1 })
})

test('HQ\'s own test of a finished ticket waits in the same line as an engineer\'s test run', async () => {
  const busy = await engineer('turn-f'), p = await project('turn-g')
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  const t = (await hq.api('tickets', { featureId: p.f.id, title: 'Thing', size: 'S', spec: 'Thing.' })).json
  await hq.hook(p.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Split done.' })
  const e = await waitFor('its engineer', async () => (await hq.state()).agents.find((x: any) => x.role === 'engineer' && x.ticket_id === t.id && x.status === 'working'))
  await waitFor("HQ's test of main as the run starts", async () => (await events('auto.main_checked')).length > 0, 60_000) // the first heavy thing this project does
  const theirs = bash(busy.eng.id, 'npm test'); assert.deepEqual(await theirs.begin, {}) // another project's engineer is running its tests
  await hq.hook(e.id, exitPlanMode('Plan')); const wt = path.join(p.dir, '.claude', 'worktrees', t.key)
  fs.writeFileSync(path.join(wt, 'thing.txt'), 'x\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'thing')
  await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  assert.equal((await hq.mcp(e.id, 'open_pr', { title: 'Thing', body: 'Thing.\n\n## Deviations from approved plan\nNone' })).isError, false)
  const waiting = await waitFor("HQ's test to wait", async () => (await events('turns.waiting')).find((x) => x.who === `HQ's test of ${t.key}`), 20_000)
  assert.deepEqual(waiting.behind, [`eng ${busy.t.key}`])
  await new Promise((r) => setTimeout(r, 2000)); assert.notEqual((await hq.state()).tickets.find((x: any) => x.id === t.id).status, 'merged') // not tested yet, so not merged
  await theirs.end()
  await waitFor('the ticket to be tested and merged', async () => (await hq.state()).tickets.find((x: any) => x.id === t.id).status === 'merged', 60_000)
})

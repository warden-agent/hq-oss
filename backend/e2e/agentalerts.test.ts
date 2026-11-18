// Bugs 153 and 165 end to end (see harness.ts): every alert about what one agent is doing right now (a frozen run, idle with work left,
// memory filling up, the mod not connected, a dialog, a usage-limit pause, TPM memory full) ends when that agent ends, whichever way: Stop,
// its Claude Code session ending, its terminal going by itself. One left open on an agent that has ended goes on the next look. Alerts about
// something that happened (a report of being blocked, the agent's own exit) stay. The tests act as the agents (fake Claude Code).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
const pids: number[] = []
before(async () => {
  hq = await startHq({ env: { HQ_STUCK_TICK_S: '1' } })
  await hq.api('settings', { key: 'concurrency_cap', value: 20 }); await hq.api('settings', { key: 'bg_stall_min', value: 0.1 }) // 6 s
})
after(async () => { for (const p of pids) try { process.kill(-p, 'SIGKILL') } catch { /* gone */ } await hq?.stop() })

const agentOf = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
/** The agent's open alerts, by kind. */
const open = async (id: string): Promise<string[]> => (await hq.state()).attention.filter((a: any) => a.agent_id === id && !a.resolved_at).map((a: any) => a.kind).sort()
const has = (id: string, kind: string) => async () => (await open(id)).includes(kind)
function sql(text: string, ...args: (string | number)[]): void {
  const db = new DatabaseSync(path.join(hq.hqHome, 'hq.sqlite')); try { db.prepare(text).run(...args) } finally { db.close() }
}
/** As if it had started two minutes ago and its mod never reported in: the stuck loop's next look raises "Agent not connected". */
async function modMissing(id: string): Promise<void> {
  sql('UPDATE agents SET mod_seen_at = NULL, started_at = started_at - 120000 WHERE id = ?', id)
  await waitFor('the mod_missing alert', has(id, 'mod_missing'), 10_000)
}
const memoryHigh = (id: string) => hq.modEvent(id, { kind: 'session.measure', usage: { context: { tokens: 120_000, percent: 60 } } }) // engineers: 100k
async function engineer(name: string) {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await agentOf(eng.id))?.status === 'working')
  return { repo, eng, t }
}

test('Bug 153: a frozen run, a memory warning and a missing mod end with the engineer\'s Claude Code session; its blocked report stays', async () => {
  const { eng } = await engineer('session-end')
  // a test run Claude Code moved to the background that then does nothing (bgruns.test.ts): "Run frozen"
  await hq.hook(eng.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npm test', timeout: 600000 } })
  pids.push(await hq.spawn(eng.id, 'exec node -e "setInterval(() => {}, 1e9)"'))
  await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npm test', timeout: 600000 },
    tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bt1x', timedOutAfterMs: 600000 } })
  await waitFor('the frozen run alert', has(eng.id, 'bg_stalled'), 30_000)
  await memoryHigh(eng.id); await modMissing(eng.id)
  assert.equal((await hq.mcp(eng.id, 'report_blocked', { reason: 'I need the API key' })).isError, false)
  assert.deepEqual(await open(eng.id), ['bg_stalled', 'blocked', 'context_high', 'mod_missing'])
  await hq.hook(eng.id, { hook_event_name: 'SessionEnd', reason: 'other' })
  assert.equal((await agentOf(eng.id)).status, 'exited')
  assert.deepEqual(await open(eng.id), ['blocked', 'engineer_exited'], 'what it was doing is over; what happened still needs the user')
})

test('Bug 153: an idle-with-work-left notice, a memory warning and a missing mod end when the user stops the engineer', async () => {
  const { eng } = await engineer('stop')
  const launch = (await hq.modNext(eng.id)).batch; await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: launch.text })
  await hq.hook(eng.id, { hook_event_name: 'Stop', last_assistant_message: 'I will wait.' })
  await memoryHigh(eng.id); await modMissing(eng.id)
  await hq.api('settings', { key: 'stuck_idle_min', value: 0.05 }) // 3 s
  try { await waitFor('the idle engineer alert', has(eng.id, 'engineer_idle'), 20_000) } finally { await hq.api('settings', { key: 'stuck_idle_min', value: 45 }) }
  assert.deepEqual(await open(eng.id), ['context_high', 'engineer_idle', 'mod_missing'])
  assert.equal((await hq.api(`agents/${eng.id}/stop`, {})).status, 200)
  assert.deepEqual(await open(eng.id), [])
})

test('Bug 153: a dialog and a usage-limit pause end when the engineer\'s terminal goes by itself (lost)', async () => {
  const { eng } = await engineer('lost')
  await hq.hook(eng.id, { hook_event_name: 'Notification', notification_type: 'quota_auto_resume_stale', message: 'Usage limit reached' })
  await hq.hook(eng.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  assert.deepEqual(await open(eng.id), ['dialog', 'usage_limit'])
  hq.tmux('kill-session', '-t', eng.tmux_session)
  await waitFor('it to be lost', async () => (await agentOf(eng.id)).status === 'exited', 15_000)
  assert.deepEqual(await open(eng.id), ['agent_exited'])
})

test('Bug 165: a stopped TPM\'s "not connected" and "memory full" alerts end with it and never show on the TPM that takes its place', async () => {
  const repo = (await hq.api('repos', { path: hq.repo('tpm') })).json
  const first = (await hq.api(`repos/${repo.id}/message`, { body: 'hello' })).json.agent
  await waitFor('the TPM', async () => (await agentOf(first.id))?.status === 'working')
  await modMissing(first.id)
  const r = await hq.hook(first.id, { hook_event_name: 'PreCompact', trigger: 'auto' }); assert.equal(r.decision, 'block')
  assert.deepEqual(await open(first.id), ['mod_missing', 'tpm_rotate'])
  assert.equal((await hq.api(`agents/${first.id}/stop`, {})).status, 200)
  assert.deepEqual(await open(first.id), [])
  const next = (await hq.api(`repos/${repo.id}/message`, { body: 'hello again' })).json.agent
  assert.notEqual(next.id, first.id); assert.equal(next.display_name, first.display_name, 'the same name: an old alert would read as this one\'s')
  await waitFor('the new TPM', async () => (await agentOf(next.id))?.status === 'working')
  await hq.modEvent(next.id, { kind: 'session.start', hasToken: true }) // its mod reports in, as in the bug
  const tpmAlerts = (await hq.state()).attention.filter((a: any) => !a.resolved_at && [first.id, next.id].includes(a.agent_id)).map((a: any) => `${a.agent_id}:${a.kind}`)
  assert.deepEqual(tpmAlerts, [])
})

test('Bug 153: alerts left open on an agent that has already ended (saved before the fix) go on the next look; its other alerts stay', async () => {
  const { eng, t } = await engineer('old-rows')
  assert.equal((await hq.api(`agents/${eng.id}/stop`, {})).status, 200)
  const kinds = ['bg_stalled', 'engineer_idle', 'context_high', 'mod_missing', 'blocked']
  for (const kind of kinds) {
    sql('INSERT INTO needs_attention(id, agent_id, ticket_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', `att-old-${kind}`, eng.id, t.id, kind, `${eng.id}: ${kind}`, Date.now())
  }
  await waitFor('the old alerts to go', async () => {
    const db = new DatabaseSync(path.join(hq.hqHome, 'hq.sqlite'))
    try { return kinds.slice(0, 4).every((k) => db.prepare('SELECT resolved_at FROM needs_attention WHERE id = ?').get(`att-old-${k}`)?.resolved_at) } finally { db.close() }
  }, 10_000)
  const db = new DatabaseSync(path.join(hq.hqHome, 'hq.sqlite'))
  try { assert.equal(db.prepare("SELECT resolved_at FROM needs_attention WHERE id = 'att-old-blocked'").get()?.resolved_at, null, 'a report of being blocked stays') } finally { db.close() }
})

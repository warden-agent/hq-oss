// Bug 96 end to end (see harness.ts): a run an engineer waits on in the background that does nothing for `bg_stall_min` gets a "Run frozen" notice; Stop it
// ends the run's process group and tells the engineer what to run instead; on auto HQ does that itself. A run that is busy, a server, and a restart
// in the middle of a wait are each handled. The run is a real process, started as Claude Code starts a command: a child of the (fake) Claude Code in a
// process group of its own.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
const pids: number[] = []
before(async () => {
  hq = await startHq({ env: { HQ_STUCK_TICK_S: '1', HQ_IDLE_FIX_S: '2', HQ_FAKE_IDLE_SCREEN: '1' } })
  await hq.api('settings', { key: 'concurrency_cap', value: 20 }); await hq.api('settings', { key: 'bg_stall_min', value: 0.1 }) // 6 s
})
after(async () => { for (const p of pids) try { process.kill(-p, 'SIGKILL') } catch { /* gone */ } await hq?.stop() })

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const agentOf = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
const alerts = async (id: string, kind = 'bg_stalled') => (await hq.state()).attention.filter((a: any) => a.kind === kind && a.agent_id === id)
const alerted = async (id: string) => { const x = await alerts(id); return x.length ? x : null }
const events = async (kind: string) => (await hq.api('events?limit=500')).json.filter((e: any) => e.kind === kind)
async function engineer(name: string) {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await agentOf(eng.id))?.status === 'working')
  return { repo, eng, t }
}
let n = 0
/** What a real engineer did: a test run with a time limit, which Claude Code moved to the background when it ran out; then the agent ended its turn to wait. */
async function runTimesOut(id: string, real: string, command = 'npm run test-backend'): Promise<{ task: string; pid: number }> {
  const use = `toolu_${++n}`, task = `bt${n}x`
  await hq.hook(id, { hook_event_name: 'UserPromptSubmit', prompt: 'run the tests' })
  await hq.hook(id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: use, tool_input: { command, timeout: 600000 } })
  const pid = await hq.spawn(id, real); pids.push(pid)
  await hq.hook(id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: use, tool_input: { command, timeout: 600000 },
    tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: task, timedOutAfterMs: 600000 } })
  await hq.hook(id, { hook_event_name: 'Stop', last_assistant_message: 'The run is still going; I will read the result when it finishes.' })
  return { task, pid }
}
const FROZEN = 'exec node -e "setInterval(() => {}, 1e9)"', BUSY = 'exec node -e "for (;;) {}"'

test('a frozen run: a notice, the engineer stays working meanwhile, and Stop it ends the run and tells the engineer', async () => {
  const { eng, t } = await engineer('frozen')
  const { task, pid } = await runTimesOut(eng.id, FROZEN)
  let a = await agentOf(eng.id); assert.equal(a.status, 'working'); assert.equal(a.activity, 'Waiting on: npm run test-backend')
  const [al] = await waitFor('the frozen run notice', () => alerted(eng.id), 30_000)
  assert.match(al.detail, new RegExp(`^${t.key}'s engineer is waiting on \`npm run test-backend\`, which has done nothing \\(no CPU, no output\\) for \\d+ min\\.$`))
  assert.equal(al.ticket_id, t.id)
  a = await agentOf(eng.id); assert.equal(a.status, 'working', 'the screen check left it alone: it waits on the run')
  assert.equal((await alerts(eng.id, 'stuck')).length, 0, 'no "looks stuck" as well')
  const r = await hq.api(`agents/${eng.id}/stop-frozen-runs`, {}); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.stopped, [task])
  await waitFor('the run to be stopped', () => !alive(pid), 5000)
  assert.equal((await alerts(eng.id)).length, 0, 'the notice went')
  assert.equal((await hq.api(`agents/${eng.id}/stop-frozen-runs`, {})).status, 409, 'a second click finds nothing to stop')
  // Claude Code's "failed" notice wakes the engineer; after that turn it's idle, and HQ's message is on its way
  await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: `<task-notification>\n<task-id>${task}</task-id>\n<status>failed</status>\n</task-notification>` })
  await hq.hook(eng.id, { hook_event_name: 'Stop', last_assistant_message: 'It was stopped.' })
  const m = (await hq.state()).messages.find((x: any) => x.to_id === eng.id && x.from_id === 'hq'); assert.equal(m?.reason, 'fyi')
  assert.match(m.body, /did nothing for \d+ min \(no CPU, no output\), so HQ stopped it\. .*run only the test files for what you changed/s)
})

test('a busy run is never frozen; once its process ends unheard, the engineer goes back to idle', async () => {
  const { eng } = await engineer('busy')
  const { pid } = await runTimesOut(eng.id, BUSY)
  await new Promise((r) => setTimeout(r, 12_000)) // twice the frozen limit
  assert.equal((await alerts(eng.id)).length, 0); assert.equal((await agentOf(eng.id)).status, 'working')
  process.kill(-pid, 'SIGKILL') // and its notice never arrives
  await waitFor('the agent idle', async () => (await agentOf(eng.id)).status === 'idle', 20_000)
  assert.ok((await events('bg.ended')).some((e: any) => e.agent_id === eng.id && JSON.parse(e.payload).why === 'gone'))
})

test('a server started in the background on purpose is never watched, however quiet', async () => {
  const { eng } = await engineer('server')
  await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: 'start it' })
  await hq.hook(eng.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_srv', tool_input: { command: 'npm run dev', run_in_background: true } })
  pids.push(await hq.spawn(eng.id, FROZEN))
  await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_srv', tool_input: { command: 'npm run dev', run_in_background: true },
    tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bsrv' } })
  await hq.hook(eng.id, { hook_event_name: 'Stop', last_assistant_message: 'The dev server is up.' })
  assert.equal((await agentOf(eng.id)).status, 'idle')
  await new Promise((r) => setTimeout(r, 10_000)); assert.equal((await alerts(eng.id)).length, 0)
})

test('HQ restarts in the middle of the wait: it still knows the run, and still sees it freeze', async () => {
  const { eng } = await engineer('restart')
  const { pid } = await runTimesOut(eng.id, FROZEN)
  await hq.restart()
  assert.equal((await agentOf(eng.id)).status, 'working')
  await waitFor('the frozen run notice after the restart', () => alerted(eng.id), 30_000)
  assert.equal((await hq.api(`agents/${eng.id}/stop-frozen-runs`, {})).status, 200)
  await waitFor('the run to be stopped', () => !alive(pid), 5000)
})

test('on auto, HQ stops a frozen run itself', async () => {
  const { repo, eng } = await engineer('auto')
  const { pid } = await runTimesOut(eng.id, FROZEN)
  assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  const ev = await waitFor('HQ to stop it', async () => (await events('bg.stopped')).find((e: any) => e.agent_id === eng.id), 30_000)
  assert.equal(JSON.parse(ev.payload).by, 'auto'); assert.ok(!alive(pid))
  assert.equal((await alerts(eng.id)).length, 0)
})

test("Bug 96 gap 4: an engineer idle with its ticket unfinished and nothing on its way gets a notice (auto off); it goes when the engineer moves", async () => {
  const { eng, t } = await engineer('idle')
  const launch = (await hq.modNext(eng.id)).batch; await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: launch.text }) // it got its launch prompt
  await hq.hook(eng.id, { hook_event_name: 'Stop', last_assistant_message: 'I will wait for the results.' })
  assert.equal((await agentOf(eng.id)).status, 'idle')
  await hq.api('settings', { key: 'stuck_idle_min', value: 0.05 }) // 3 s
  try {
    const [al] = await waitFor('the idle engineer notice', async () => { const x = await alerts(eng.id, 'engineer_idle'); return x.length ? x : null }, 20_000)
    assert.match(al.detail, new RegExp(`^${t.key}'s engineer has been idle for \\d+ min while the ticket is still planning, with no message or run on its way\\.`))
    await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go on' })
    await waitFor('the notice to go', async () => !(await alerts(eng.id, 'engineer_idle')).length, 10_000)
  } finally { await hq.api('settings', { key: 'stuck_idle_min', value: 45 }) }
})

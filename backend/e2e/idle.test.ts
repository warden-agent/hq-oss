// Bug 25 end to end (see harness.ts): an agent whose turn has ended goes back to idle, even when a helper agent (a subagent or
// one of Claude Code's own background helpers) uses tools afterwards; and when a hook was missed, the stuck loop sees Claude
// Code's idle prompt on the screen and sets the agent idle.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_STUCK_TICK_S: '1', HQ_IDLE_FIX_S: '2', HQ_FAKE_IDLE_SCREEN: '1' } }) })
after(async () => { await hq?.stop() })

async function tpmOf(name: string): Promise<any> {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  return waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
}
const status = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id).status

test('Bug 25: a helper agent\'s tool use after the turn ended never leaves the agent "working"', async () => {
  const tpm = await tpmOf('helper')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
  await hq.hook(tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a' } })
  assert.equal(await status(tpm.id), 'working')
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  assert.equal(await status(tpm.id), 'idle')
  // what a real TPM's log showed: tool calls from a helper after Stop, then the helper stops
  await hq.hook(tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'mcp__hq__write_feature', tool_input: {}, agent_id: 'a73f17425d78f0183', agent_type: '' })
  assert.equal(await status(tpm.id), 'idle')
  await hq.hook(tpm.id, { hook_event_name: 'SubagentStop', agent_id: 'a73f17425d78f0183' })
  assert.equal(await status(tpm.id), 'idle')
  // a helper during a turn changes nothing either: the main loop is working, and stays so after the helper stops
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'again' })
  await hq.hook(tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, agent_id: 'add6644771695136d', agent_type: 'general-purpose' })
  await hq.hook(tpm.id, { hook_event_name: 'SubagentStop', agent_id: 'add6644771695136d' })
  assert.equal(await status(tpm.id), 'working')
})

test('Bug 25: a helper\'s hook without agent_id after Stop: its SubagentStop puts the agent back to idle', async () => {
  const tpm = await tpmOf('no-id')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  await hq.hook(tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })
  assert.equal(await status(tpm.id), 'working')
  await hq.hook(tpm.id, { hook_event_name: 'SubagentStop', agent_id: 'x' })
  assert.equal(await status(tpm.id), 'idle')
  // Bug 80: a prompt and its Stop often arrive in the same millisecond here; HQ must still know the turn has ended
  for (let i = 0; i < 30; i++) {
    await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: `hi ${i}` })
    await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    await hq.hook(tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })
    await hq.hook(tpm.id, { hook_event_name: 'SubagentStop', agent_id: 'x' })
    assert.equal(await status(tpm.id), 'idle', `round ${i}`)
  }
})

test('Bug 25: "working" with Claude Code\'s idle prompt on screen for a while becomes idle, and the stuck notice goes', async () => {
  const tpm = await tpmOf('missed-stop')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }) // and the Stop never arrives
  assert.equal(await status(tpm.id), 'working')
  await waitFor('the screen check to set it idle', async () => (await status(tpm.id)) === 'idle', 20_000)
  const s = await hq.state()
  assert.equal(s.attention.filter((a: any) => a.kind === 'stuck' && a.agent_id === tpm.id).length, 0)
})

// Bug 94: what a real TPM did on 2026-11-09: it started an Explore helper in the background ("Map code for new feature"), ended
// its turn, and the helper read code for two more minutes. HQ showed the TPM idle the whole time.
const agentOf = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
const startHelper = (id: string, helper: string, description: string) => [
  { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description, subagent_type: 'Explore', run_in_background: true } },
  { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description }, tool_response: { isAsync: true, status: 'async_launched', agentId: helper, description } },
].reduce((p, b) => p.then(() => hq.hook(id, b)), Promise.resolve() as Promise<unknown>)

test('Bug 94: a helper the agent started in the background keeps it "working" after its turn ends, until the helper stops', async () => {
  const tpm = await tpmOf('background-helper')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'Build three upgrades' })
  await startHelper(tpm.id, 'af82e179910574180', 'Map code for new feature')
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'The breakdown follows shortly.' })
  let a = await agentOf(tpm.id)
  assert.equal(a.status, 'working'); assert.equal(a.activity, 'Subagent: Map code for new feature')
  // the helper's own tool calls show under it, and Claude Code's own helpers still change nothing
  await hq.hook(tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/r/server/prometheus.js' }, agent_id: 'af82e179910574180' })
  a = await agentOf(tpm.id); assert.equal(a.status, 'working'); assert.equal(a.activity, 'Subagent: Map code for new feature · Reading server/prometheus.js')
  await hq.hook(tpm.id, { hook_event_name: 'SubagentStop', agent_id: 'a73f17425d78f0183' })
  assert.equal(await status(tpm.id), 'working')
  await hq.hook(tpm.id, { hook_event_name: 'SubagentStop', agent_id: 'af82e179910574180' })
  a = await agentOf(tpm.id); assert.equal(a.status, 'idle'); assert.equal(a.activity, null)
})

test('Bug 94: two background helpers: the agent is idle only when both are done; a helper\'s "done" notice also counts', async () => {
  const tpm = await tpmOf('two-helpers')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
  await startHelper(tpm.id, 'h1', 'Read the status pages')
  await startHelper(tpm.id, 'h2', 'Read the metrics')
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Reading.' })
  assert.equal((await agentOf(tpm.id)).activity, 'Subagent: Read the metrics (+1 more)')
  await hq.hook(tpm.id, { hook_event_name: 'SubagentStop', agent_id: 'h2' })
  const a = await agentOf(tpm.id); assert.equal(a.status, 'working'); assert.equal(a.activity, 'Subagent: Read the status pages')
  // h1's stop never arrives as a hook, but Claude Code tells the main loop it finished: a new turn, and after it the agent is idle
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>h1</task-id>\n<status>completed</status>' })
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  assert.equal(await status(tpm.id), 'idle')
})

test('Bug 94: a helper run in the foreground, or one that never started, keeps nothing working', async () => {
  const tpm = await tpmOf('foreground-helper')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
  await hq.hook(tpm.id, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'x' }, tool_response: { status: 'completed', agentId: 'fg1', content: [] } })
  await hq.hook(tpm.id, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'y' }, tool_response: 'Error: no such agent type' })
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  assert.equal(await status(tpm.id), 'idle')
})

// Bug 95: what a real engineer did on 2026-11-09: its test run hit the Bash tool's `timeout`, Claude Code moved it to the background (2.1.300 doesn't stop
// it), and the agent ended its turn to wait for it. HQ showed it idle the whole time.
const bashBg = (id: string, use: string, command: string, resp: Record<string, unknown>, input: Record<string, unknown> = {}) => [
  { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: use, tool_input: { command, ...input } },
  { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: use, tool_input: { command, ...input },
    tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, ...resp } },
].reduce((p, b) => p.then(() => hq.hook(id, b)), Promise.resolve() as Promise<unknown>)

test('Bug 95: a run that timed out into the background keeps the agent "working" after its turn ends, until its notice comes', async () => {
  const tpm = await tpmOf('timed-out-run')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'run the suite' })
  await bashBg(tpm.id, 'toolu_1', 'npm run test-backend 2>&1 | head -40', { backgroundTaskId: 'bbl4zmgzt', timedOutAfterMs: 600000 }, { timeout: 600000 })
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'The full backend run is still going. I am waiting for it to finish.' })
  const a = await agentOf(tpm.id); assert.equal(a.status, 'working'); assert.equal(a.activity, 'Waiting on: npm run test-backend 2>&1 | head -40')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>bbl4zmgzt</task-id>\n<status>completed</status>\n</task-notification>' })
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Tests pass.' })
  assert.equal(await status(tpm.id), 'idle')
})

test('Bug 95: a server started in the background on purpose keeps nothing working; a test run put there on purpose does', async () => {
  const tpm = await tpmOf('bg-server')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'start the app' })
  await bashBg(tpm.id, 'toolu_2', 'npm run dev', { backgroundTaskId: 'bq6vy2yub' }, { run_in_background: true })
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'The dev server is up.' })
  let a = await agentOf(tpm.id); assert.equal(a.status, 'idle'); assert.equal(a.activity, null)
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'run the tests' })
  await bashBg(tpm.id, 'toolu_3', 'npm test', { backgroundTaskId: 'bt3st' }, { run_in_background: true })
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Waiting for the tests.' })
  a = await agentOf(tpm.id); assert.equal(a.status, 'working'); assert.equal(a.activity, 'Waiting on: npm test')
  // no process HQ can find for it (a fake hook): on two looks in a row it's taken as ended, and the screen check sets the agent idle (Bug 25)
  await waitFor('the gone run to be dropped and the agent set idle', async () => (await status(tpm.id)) === 'idle', 20_000)
})

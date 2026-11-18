// Bug 232 end to end (see harness.ts): the helpers an agent started in the background (Bug 94) outlive a backend restart. Its box says again what it
// waits on, and a helper that ends after the restart while another still runs doesn't leave it idle. No idle screen here: the stuck loop's screen
// check would forget the helpers on its own.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_STUCK_TICK_S: '1' } }) })
after(async () => { await hq?.stop() })

const agentOf = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
async function tpmOf(name: string): Promise<any> {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  return waitFor('the TPM', async () => { const a = await agentOf(f.tpm_agent_id); return a?.status === 'working' ? a : null })
}
const startHelper = async (id: string, helper: string, description: string) => {
  await hq.hook(id, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description, subagent_type: 'Explore', run_in_background: true } })
  await hq.hook(id, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description },
    tool_response: { isAsync: true, status: 'async_launched', agentId: helper, description } })
}
const notice = (task: string) => `<task-notification>\n<task-id>${task}</task-id>\n<status>completed</status>\n</task-notification>`

test('Bug 232: after a restart HQ still knows the helpers an agent waits on, and which ones ended before it', async () => {
  const tpm = await tpmOf('helpers-restart'), mid = await tpmOf('helpers-mid')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'Build three upgrades' })
  await startHelper(tpm.id, 'h-done', 'Read the old notes') // ends before the restart, by its SubagentStop
  await startHelper(tpm.id, 'h-note', 'Read the settings page') // ends before the restart, by its notice
  await startHelper(tpm.id, 'h1', 'Map the status pages')
  await startHelper(tpm.id, 'h2', 'Map the metrics code')
  await hq.hook(tpm.id, { hook_event_name: 'SubagentStop', agent_id: 'h-done' })
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'The breakdown follows shortly.' })
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: notice('h-note') })
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'One read is done.' })
  assert.equal((await agentOf(tpm.id)).activity, 'Subagent: Map the metrics code (+1 more)')
  // one still in its turn when HQ went: its next hook says what it does
  await hq.hook(mid.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
  await startHelper(mid.id, 'm1', 'Read the code')
  await hq.restart()
  let a = await agentOf(tpm.id)
  assert.equal(a.status, 'working'); assert.equal(a.activity, 'Subagent: Map the metrics code (+1 more)', 'the line is back without a new hook, with only the two still running')
  assert.equal((await agentOf(mid.id)).activity ?? null, null, 'one still in its turn is not said to be waiting')
  // h2 ends: h1, started before the restart, still runs, so the agent is still working
  await hq.hook(tpm.id, { hook_event_name: 'SubagentStop', agent_id: 'h2' })
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: notice('h2') })
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Metrics mapped.' })
  a = await agentOf(tpm.id); assert.equal(a.status, 'working'); assert.equal(a.activity, 'Subagent: Map the status pages')
  // a second restart in between reads the ends logged since the first
  await hq.restart()
  a = await agentOf(tpm.id); assert.equal(a.status, 'working'); assert.equal(a.activity, 'Subagent: Map the status pages')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: notice('h1') })
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  a = await agentOf(tpm.id); assert.equal(a.status, 'idle'); assert.equal(a.activity ?? null, null)
  await hq.restart()
  a = await agentOf(tpm.id); assert.equal(a.status, 'idle'); assert.equal(a.activity ?? null, null, 'nothing comes back once all have ended')
})

test('Bug 232: a new session ends every helper; a restart brings none of them back', async () => {
  const tpm = await tpmOf('helpers-session')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
  await startHelper(tpm.id, 's1', 'Read the code')
  await hq.hook(tpm.id, { hook_event_name: 'SessionStart', source: 'clear' })
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hi again' })
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  assert.equal((await agentOf(tpm.id)).status, 'idle')
  await hq.restart()
  const a = await agentOf(tpm.id); assert.equal(a.status, 'idle'); assert.equal(a.activity ?? null, null)
})

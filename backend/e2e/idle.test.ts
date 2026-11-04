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
})

test('Bug 25: "working" with Claude Code\'s idle prompt on screen for a while becomes idle, and the stuck notice goes', async () => {
  const tpm = await tpmOf('missed-stop')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }) // and the Stop never arrives
  assert.equal(await status(tpm.id), 'working')
  await waitFor('the screen check to set it idle', async () => (await status(tpm.id)) === 'idle', 20_000)
  const s = await hq.state()
  assert.equal(s.attention.filter((a: any) => a.kind === 'stuck' && a.agent_id === tpm.id).length, 0)
})

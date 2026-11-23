// Bug 148 end to end (see harness.ts): Escape in an agent's terminal ends its turn with no Stop hook; its mod says so at once (`turn.complete`
// with `isAborted`). The agent is then idle, with no activity line, unless a helper or a run in the background of its own still goes (Bugs 94, 95).
// An interrupted engineer isn't taken for finished, and its idle time starts at the interrupt. The tests act as the agents and their mods.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
// A finished engineer stops 0.3 s after its turn ends here, and the stuck loop and the finished backstop look every second. The screen check that sets a
// quiet "working" agent idle (Bug 25) keeps its 3 minutes: these tests must see the interrupt do it, not that.
before(async () => {
  hq = await startHq({ env: { HQ_STUCK_TICK_S: '1', HQ_FINISHED_STOP_MS: '300', HQ_FINISHED_TICK_S: '0.25' } })
  await hq.api('settings', { key: 'concurrency_cap', value: 20 })
})
after(async () => { await hq?.stop() })

const agentOf = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
const seen = async (id: string) => { const a = await agentOf(id); return [a.status, a.activity ?? null, !!a.interrupted_at] }
/** What the mod sends when the agent's own turn ends (`helper`: a helper's turn, which has an agentId). */
const turnComplete = (id: string, aborted: boolean, helper: string | null = null) =>
  hq.modEvent(id, { kind: 'turn.complete', turnId: 't', agentId: helper, isAborted: aborted, durationMs: 9000, answer: '' })
const escape = (id: string) => turnComplete(id, true)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const db = <T,>(query: string, ...args: (string | number)[]): T[] => {
  const d = hq.db(); try { return d.prepare(query).all(...args) as T[] } finally { d.close() }
}

async function tpmOf(name: string): Promise<any> {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  return waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
}
async function engineerOf(name: string): Promise<{ dir: string; eng: any; t: any }> {
  const dir = hq.repo(name)
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await agentOf(eng.id))?.status === 'working')
  const launch = (await hq.modNext(eng.id)).batch; await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: launch.text }) // it got its launch prompt
  return { dir, eng, t }
}

test('Bug 148: Escape ends the turn at once: idle, no activity line; a later turn works and ends as usual', async () => {
  const tpm = await tpmOf('escape')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'Build a big thing' })
  await hq.hook(tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/r/.git/HEAD' } })
  assert.deepEqual(await seen(tpm.id), ['working', 'Reading .git/HEAD', false])
  // what must NOT move it: a helper's interrupted turn, and a turn.complete that isn't aborted for a turn the mod never said started (Bug 254 needs its
  // turn.start; a turn that ends normally sends its Stop hook first)
  await turnComplete(tpm.id, true, 'a73f17425d78f0183')
  assert.deepEqual(await seen(tpm.id), ['working', 'Reading .git/HEAD', false])
  await turnComplete(tpm.id, false)
  assert.deepEqual(await seen(tpm.id), ['working', 'Reading .git/HEAD', false])
  await escape(tpm.id)
  assert.deepEqual(await seen(tpm.id), ['idle', null, true])
  // the person types something: a new turn, which ends normally and clears the interrupt
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'Smaller, please' })
  assert.deepEqual(await seen(tpm.id), ['working', 'Thinking', true])
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  assert.deepEqual(await seen(tpm.id), ['idle', null, false])
  // Escape with nothing running (no turn) changes nothing either
  await escape(tpm.id)
  assert.equal((await agentOf(tpm.id)).status, 'idle')
})

const startHelper = (id: string, helper: string, description: string) => [
  { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description, subagent_type: 'Explore', run_in_background: true } },
  { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description }, tool_response: { isAsync: true, status: 'async_launched', agentId: helper, description } },
].reduce((p, b) => p.then(() => hq.hook(id, b)), Promise.resolve() as Promise<unknown>)

test('Bug 148: a helper of its own still running keeps it working after Escape, until the helper stops', async () => {
  const tpm = await tpmOf('escape-helper')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'Map the code' })
  await startHelper(tpm.id, 'h148', 'Map code for new feature')
  await hq.hook(tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/r/src/a.ts' } })
  await escape(tpm.id)
  assert.deepEqual(await seen(tpm.id), ['working', 'Subagent: Map code for new feature', true])
  await hq.hook(tpm.id, { hook_event_name: 'SubagentStop', agent_id: 'h148' }) // the turn has ended: the helper was all that kept it working
  assert.deepEqual(await seen(tpm.id), ['idle', null, true])
})

test('Bug 148: a run of its own in the background keeps it working after Escape', async () => {
  const tpm = await tpmOf('escape-bg')
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'run the suite' })
  const command = 'npm run test-backend 2>&1 | head -40', input = { command, timeout: 600000 }
  await hq.hook(tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_148', tool_input: input })
  await hq.hook(tpm.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_148', tool_input: input,
    tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b148', timedOutAfterMs: 600000 } })
  await escape(tpm.id)
  assert.deepEqual(await seen(tpm.id), ['working', `Waiting on: ${command}`, true])
})

test("Bug 148: an engineer interrupted on a finished ticket isn't stopped as finished; once a turn ends normally it is", async () => {
  const { dir, eng, t } = await engineerOf('escape-finished')
  const wt = path.join(dir, '.claude', 'worktrees', t.key)
  fs.writeFileSync(path.join(wt, 'version.txt'), 'v1\nbug 148\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'version: bug 148')
  assert.equal((await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })).isError, false)
  const r = await hq.mcp(eng.id, 'open_pr', { title: 'Add a line', body: 'Adds a line.\n\n## Deviations from approved plan\nNone' }); assert.equal(r.isError, false, r.text)
  await hq.hook(eng.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_s', tool_input: { command: 'git log --oneline' } })
  await escape(eng.id)
  assert.deepEqual(await seen(eng.id), ['idle', null, true])
  await wait(400) // limit: HQ leaves a finished engineer alone for HQ_FINISHED_STOP_MS (0.3 s here) after its last sign of life; no look stops it sooner
  await hq.beats('finished', 2) // and the backstop has looked at every engineer since
  assert.equal((await agentOf(eng.id)).status, 'idle', 'kept: somebody stopped it mid-turn, and may type to it')
  await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: 'never mind, you are done' })
  await hq.hook(eng.id, { hook_event_name: 'Stop', last_assistant_message: 'OK.' })
  await waitFor(`${eng.id} to stop`, async () => (await agentOf(eng.id)).status === 'exited', 8000)
})

test("Bug 148: an interrupted engineer's idle time starts at the interrupt, not at its last hook", async () => {
  const { eng, t } = await engineerOf('escape-idle')
  await hq.hook(eng.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_p', tool_input: { command: "perl -e 'sleep 75'" } })
  await hq.api('settings', { key: 'stuck_idle_min', value: 0.05 }) // 3 s
  try {
    await wait(3500) // limit: the idle limit is 3 s here (stuck_idle_min 0.05), and the command has to have run longer than that with no hook
    const at = Date.now(); await escape(eng.id)
    assert.deepEqual(await seen(eng.id), ['idle', null, true])
    const [row] = db<{ last_event_at: number }>('SELECT last_event_at FROM agents WHERE id = ?', eng.id)
    assert.ok(row!.last_event_at >= at, 'the interrupt is its last sign of life')
    const alerts = async () => (await hq.state()).attention.filter((a: any) => a.kind === 'engineer_idle' && a.agent_id === eng.id)
    const [al] = await waitFor('the idle engineer notice, 3 s after the interrupt', async () => { const x = await alerts(); return x.length ? x : null }, 20_000)
    assert.match(al.detail, new RegExp(`^${t.key}'s engineer has been idle for \\d+ min while the ticket is still planning`))
  } finally { await hq.api('settings', { key: 'stuck_idle_min', value: 45 }) }
})

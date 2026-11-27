// Bug 195 end to end (see harness.ts): an engineer switches models by itself, so HQ pauses the engineer role. The pause used to hold back only the
// engineers' messages: one at work went on working, and spending. Now every engineer with a turn at work is stopped (Escape in its terminal), a step or a
// turn that starts during the pause is refused and stopped too, messages wait (Urgent as well), and Resume tells the stopped ones to carry on. The tests
// act as the agents and their mods; the stand-in Claude Code shows the screens they draw.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_PAUSE_SETTLE_MS: '50' } }); await hq.api('settings', { key: 'concurrency_cap', value: 20 }) })
after(async () => { await hq?.stop() })

const RULE = '─'.repeat(60)
const INTERRUPTED = `⏺ Reading PROJECT.md\n  ⎿  Interrupted · What should Claude do instead?\n\n${RULE} eng ─\n❯ \n${RULE}\n  ⏵⏵ accept edits on (shift+tab to cycle)\n`
const WORKING = `✶ Tempering… (9s · ↓ 1.1k tokens · thinking)\n\n${RULE} eng ─\n❯ \n${RULE}\n  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt\n`
const SONNET = 'claude-sonnet-5-5', OPUS = 'claude-opus-5-5'
const agentNow = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
const pane = (a: any): string => hq.tmux('capture-pane', '-p', '-J', '-t', a.tmux_session)
async function draw(a: any, text: string, shows: string): Promise<void> { await hq.screen(a.id, text); await waitFor(`the screen to show "${shows}"`, () => pane(a).includes(shows)) }
const kinds = async (agentId: string, kind: string) => (await hq.api(`events?agent=${agentId}`)).json.filter((e: any) => e.kind === kind).map((e: any) => JSON.parse(e.payload)).reverse()
const fromHq = async (id: string) => (await hq.state()).messages.filter((m: any) => m.to_id === id && m.from_id === 'hq' && /the pause is over/.test(m.body))
const msg = async (body: string) => (await hq.state()).messages.find((m: any) => m.body === body)
const paused = async () => (await hq.state()).settings.paused_roles ?? []
const alarms = async () => (await hq.state()).attention.filter((a: any) => a.kind === 'model_fallback')
/** The agent's own turn ends the way Escape ends it: its mod says so, no Stop hook comes, and its screen waits at the prompt. */
async function escaped(a: any): Promise<void> {
  await hq.modEvent(a.id, { kind: 'turn.complete', turnId: 't', agentId: null, isAborted: true, durationMs: 9000, answer: '' }); await draw(a, INTERRUPTED, 'Interrupted')
}
const step = (a: any, tool: string, more: Record<string, unknown> = {}) =>
  hq.hookOnce(a.id, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: tool === 'Bash' ? { command: 'npm test' } : { file_path: 'a.txt' }, tool_use_id: `u-${tool}`, ...more })
const refused = (r: any): boolean => r.hookSpecificOutput?.permissionDecision === 'deny' && /^HQ: .*paused.*end your turn now/s.test(r.hookSpecificOutput.permissionDecisionReason)

/** A project with its TPM and `n` engineers, each at work on its own ticket (its launch prompt taken, a turn on its screen). */
async function team(name: string, n: number): Promise<{ tpm: any; engs: any[]; tickets: any[] }> {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const engs: any[] = [], tickets: any[] = []
  for (let i = 1; i <= n; i++) {
    const t = (await hq.api('tickets', { featureId: f.id, title: `Part ${i}`, size: 'S', spec: `Part ${i}.` })).json
    const e = (await hq.api(`tickets/${t.id}/launch`, {})).json
    await waitFor('the engineer', async () => (await agentNow(e.id))?.status === 'working')
    const launch = (await hq.modNext(e.id)).batch; await hq.hook(e.id, { hook_event_name: 'UserPromptSubmit', prompt: launch.text })
    await draw(e, WORKING, 'esc to interrupt'); engs.push(e); tickets.push(t)
  }
  await draw(tpm, WORKING, 'esc to interrupt')
  return { tpm, engs, tickets }
}

test('Bug 195: a model switch nobody asked for stops every engineer at work; messages wait, Urgent too; Resume has them carry on with what waited', async () => {
  const { tpm, engs: [a, b], tickets } = await team('b195x', 2)
  const spare = (await hq.api('tickets', { featureId: tickets[0].feature_id, title: 'Part 3', size: 'S', spec: 'Part 3.' })).json
  await hq.hook(a.id, { hook_event_name: 'PostModelSwitch', from_model: SONNET, to_model: OPUS, source: 'auto', requested_model: null })
  assert.deepEqual(await paused(), ['engineer'])
  // both engineers, not only the one that switched; the TPM is another role and works on
  for (const e of [a, b]) await waitFor(`${e.id} to be stopped`, async () => (await agentNow(e.id)).pause_stopped_at)
  for (const e of [a, b]) { assert.deepEqual(await kinds(e.id, 'agent.pause_stopped'), [{ why: 'pause' }]); await escaped(e) }
  assert.deepEqual((await Promise.all([a, b].map((e) => agentNow(e.id)))).map((x) => [x.status, !!x.interrupted_at]), [['idle', true], ['idle', true]])
  assert.equal((await agentNow(tpm.id)).pause_stopped_at, null); assert.deepEqual(await kinds(tpm.id, 'agent.pause_stopped'), [])
  assert.deepEqual(await step(tpm, 'Read'), {}, 'the TPM steps on')
  const [alarm] = await alarms(); assert.equal(alarm.agent_id, a.id)
  assert.match(alarm.detail, /switched models by itself: claude-sonnet-5-5 → claude-opus-5-5\. .* HQ stopped every engineer at work .* Resume lets them carry on/)
  // nothing reaches them: a plain message and an urgent one both wait, and nothing is typed into the terminal
  assert.equal((await hq.api(`agents/${b.id}/message`, { body: 'Also add a count.', reason: 'fyi' })).status, 200)
  assert.equal((await hq.api(`agents/${b.id}/message`, { body: 'Stop and read this.', urgent: true })).status, 200)
  assert.deepEqual(await hq.modNext(b.id), {})
  for (const body of ['Also add a count.', 'Stop and read this.']) assert.equal((await msg(body)).delivered_at, null, body)
  assert.deepEqual(await kinds(b.id, 'urgent.interrupt'), []); assert.ok(!pane(b).includes('Stop and read this.'))
  // a turn that goes on anyway (a helper's step, its own next step, a build that would wait in line) is refused at each step
  assert.ok(refused(await step(b, 'Edit'))); assert.ok(refused(await step(b, 'Bash'))); assert.ok(refused(await step(b, 'Read', { agent_id: 'helper-1' })))
  // and no new engineer starts on a paused role
  const launch = await hq.api(`tickets/${spare.id}/launch`, {}); assert.equal(launch.status, 409); assert.match(launch.json.error, /Engineers are paused .* press Resume/)

  // HQ restarts in the middle of the pause: still paused, still owed their "carry on"
  await hq.restart()
  assert.deepEqual(await paused(), ['engineer']); assert.ok((await agentNow(b.id)).pause_stopped_at); assert.deepEqual(await hq.modNext(b.id), {})
  assert.ok(refused(await step(b, 'Edit')))

  assert.equal((await hq.api('roles/engineer/resume', {})).status, 200)
  assert.deepEqual(await paused(), []); assert.deepEqual(await alarms(), [], 'Resume answers the notice')
  for (const e of [a, b]) { assert.equal((await agentNow(e.id)).pause_stopped_at, null); assert.equal((await fromHq(e.id)).length, 1, `${e.id}: told once`) }
  // their turns were interrupted, so HQ types what waited into each terminal (Bug 110), the user's messages and its own in one line
  assert.deepEqual(await hq.modNext(b.id), {}); assert.deepEqual(await hq.modNext(a.id), {})
  await waitFor("b's line in its terminal", () => { const p = pane(b); return p.includes('Also add a count.') && p.includes('Stop and read this.') && p.includes('the pause is over, carry on') })
  await waitFor("a's line in its terminal", () => pane(a).includes('the pause is over, carry on'))
  assert.equal((await kinds(b.id, 'batch.typed')).length, 1)
  // working again: its steps run, and a second Resume tells nobody anything
  await hq.hook(b.id, { hook_event_name: 'UserPromptSubmit', prompt: pane(b).slice(pane(b).indexOf('HQ message batch')).replace(/\s+/g, ' ').slice(0, 60) })
  assert.deepEqual(await step(b, 'Edit'), {})
  await hq.api('roles/engineer/resume', {}); assert.equal((await fromHq(b.id)).length, 1)
})

test('Bug 195: a turn that starts by itself during the pause is stopped; an engineer that sat idle is left alone and told nothing', async () => {
  const { engs: [late, idle] } = await team('b195y', 2)
  for (const e of [late, idle]) { await hq.hook(e.id, { hook_event_name: 'Stop', last_assistant_message: 'Waiting on my helper.' }); await draw(e, INTERRUPTED, 'Interrupted') }
  // paused through the setting this time: the same pause
  assert.equal((await hq.api('settings', { key: 'paused_roles', value: ['engineer'] })).status, 200)
  await hq.api(`agents/${idle.id}/message`, { body: 'Read this when you can.', reason: 'fyi' })
  assert.deepEqual(await hq.modNext(idle.id), {}, 'a message does not wake an idle engineer of a paused role')
  // its helper ends, and Claude Code starts a turn with the helper's result (seen on 2.1.322): HQ hears the prompt, and the screen shows the turn
  await hq.hook(late.id, { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>h1</task-id>\n<status>completed</status>\n</task-notification>' })
  await draw(late, WORKING, 'esc to interrupt')
  await waitFor('the new turn to be stopped', async () => (await agentNow(late.id)).pause_stopped_at)
  assert.deepEqual(await kinds(late.id, 'agent.pause_stopped'), [{ why: 'prompt' }]); await escaped(late)
  assert.equal((await agentNow(idle.id)).pause_stopped_at, null); assert.deepEqual(await kinds(idle.id, 'agent.pause_stopped'), [])

  assert.equal((await hq.api('settings', { key: 'paused_roles', value: [] })).status, 200)
  assert.equal((await fromHq(late.id)).length, 1); assert.equal((await fromHq(idle.id)).length, 0, 'nothing to carry on with')
  const b = (await hq.modNext(idle.id)).batch; assert.match(b.text, /Read this when you can\./) // never interrupted: its mod delivers, as always
  assert.deepEqual(await hq.modNext(late.id), {}); await waitFor('the line in its terminal', () => pane(late).includes('the pause is over, carry on'))
})

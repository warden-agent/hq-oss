// Bug 188 end to end: once a dialog is over, by Escape or a denial (no hook comes; the mod's turn.complete says the turn ended, isAborted false on 2.1.322)
// or by the agent working again (a hook
// of its own main loop), the agent leaves "blocked" and its dialog notice goes within seconds. HQ looks at the status file and the screen at once, and
// every second for a few seconds (HQ_DIALOG_LOOK_S). The stuck loop's sweep (two looks a minute apart, dialogs.test.ts) is held off here, so a clear
// can only come from that look. What must not be caught: a dialog that is still open (its file says waiting, a menu is on screen, or the file says
// nothing since the notice), a helper's hook, and another agent's.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_STUCK_TICK_S: '3600', HQ_DIALOG_LOOK_S: '3' } }) })
after(async () => { await hq?.stop() })
let n = 0
async function tpm(): Promise<any> {
  const repo = (await hq.api('repos', { path: hq.repo(`q${++n}`) })).json, a = (await hq.api(`repos/${repo.id}/message`, { body: 'hello' })).json.agent
  return waitFor('the TPM', async () => (await hq.state()).agents.find((x: any) => x.id === a.id && x.status === 'working'))
}
const now = async (a: any) => (await hq.state()).agents.find((x: any) => x.id === a.id)
const open = async (a: any) => (await hq.state()).attention.find((x: any) => x.kind === 'dialog' && x.agent_id === a.id && !x.resolved_at)
const events = async (a: any, kind: string) => ((await hq.api(`events?agent=${a.id}&limit=200`)).json as any[]).filter((e) => e.kind === kind)
const seen = async (a: any) => { const x = await now(a); return [x.status, x.activity ?? null, !!x.interrupted_at] }
/** The agent at work, then at a permission dialog: its status file says waiting (as Claude Code's does), and the Notification hook comes. */
async function atDialog(a: any, tool = 'Bash'): Promise<void> {
  await hq.hook(a.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go on' })
  await hq.hook(a.id, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: 'curl example.com' }, tool_use_id: `u${n}` })
  await hq.session(a.id, 'waiting'); await hq.hook(a.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: `Claude needs your permission to use ${tool}` })
  assert.equal((await now(a)).status, 'blocked'); assert.ok(await open(a))
}
/** What the mod sends when Escape or a denial on a dialog ends the turn (real 2.1.322: isAborted false, no Stop hook), or `aborted` for an Escape mid-turn. */
const escape = (a: any, aborted = false) => hq.modEvent(a.id, { kind: 'turn.complete', turnId: 't', agentId: null, isAborted: aborted, durationMs: 9000, answer: '' })
const cleared = (a: any) => waitFor(`${a.id}'s dialog notice to go`, async () => !(await open(a)), 6000)
const MENU = '\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n'
/** Draws `text` as the agent's screen and waits until its terminal shows it (the fake redraws every 200 ms). */
async function drawn(a: any, text: string): Promise<void> {
  await hq.screen(a.id, text); const line = text.trim().split('\n')[0]!
  await waitFor(`${a.id}'s screen to show "${line}"`, () => hq.tmux('capture-pane', '-p', '-t', a.tmux_session).includes(line), 5000)
}

test('Bug 188: Escape on a dialog: within seconds the notice goes and the agent is idle, even if its file says so a moment later', async () => {
  const a = await tpm(), late = await tpm(), aborted = await tpm()
  for (const x of [a, late, aborted]) await atDialog(x)
  await hq.session(a.id, 'idle'); await escape(a)
  await cleared(a); assert.deepEqual(await seen(a), ['idle', null, false])
  await escape(late) // its file still says waiting when the mod tells HQ, and changes after (about 0.4 s on 2.1.322): HQ looks again
  await hq.session(late.id, 'idle'); await cleared(late); assert.deepEqual(await seen(late), ['idle', null, false])
  for (const x of [a, late]) assert.deepEqual((await events(x, 'agent.dialog_cleared')).map((e) => JSON.parse(e.payload).by), ['turn_end'], x.id)
  await hq.session(aborted.id, 'idle'); await escape(aborted, true) // a turn the mod calls interrupted: idle, and "interrupted" (Bug 148)
  await cleared(aborted); assert.deepEqual(await seen(aborted), ['idle', null, true])
  // a helper of its own still works in the background (its file says busy): the turn is over, the agent isn't (Bugs 94, 148)
  const helped = await tpm(), d = 'Map the code'
  await hq.hook(helped.id, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: d }, tool_response: { isAsync: true, agentId: 'h188', description: d } })
  await atDialog(helped); await hq.session(helped.id, 'busy'); await escape(helped)
  await cleared(helped); assert.deepEqual(await seen(helped), ['working', `Subagent: ${d}`, false])
  // a new turn starts before HQ sees the dialog gone (a prompt typed at once): it is working on that one, not idle
  const again = await tpm(); await atDialog(again); await escape(again)
  await hq.hook(again.id, { hook_event_name: 'UserPromptSubmit', prompt: 'try another way' }); await hq.session(again.id, 'busy')
  await cleared(again); assert.deepEqual(await seen(again), ['working', 'Thinking', false])
})

test('Bug 188: working again after a dialog: its main loop\'s next hook clears the notice, and the box says what it does', async () => {
  const pre = await tpm(), post = await tpm(), prompt = await tpm(), stop = await tpm()
  for (const x of [pre, post, prompt, stop]) { await atDialog(x); await hq.session(x.id, 'busy') } // answered: Claude Code is busy again
  await hq.hook(pre.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'b188' })
  await hq.hook(post.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'curl example.com' }, tool_use_id: 'u188', tool_response: {} })
  await hq.hook(prompt.id, { hook_event_name: 'UserPromptSubmit', prompt: 'do it another way' })
  for (const x of [pre, post, prompt]) await cleared(x)
  assert.deepEqual((await seen(pre)).slice(0, 2), ['working', 'Running: npm test'])
  assert.equal((await now(post)).status, 'working', 'PostToolUse sets no status of its own: the clear does, from the file')
  assert.deepEqual((await seen(prompt)).slice(0, 2), ['working', 'Thinking'])
  await hq.session(stop.id, 'idle'); await hq.hook(stop.id, { hook_event_name: 'Stop', last_assistant_message: 'done' })
  await cleared(stop); assert.equal((await now(stop)).status, 'idle')
  assert.equal(JSON.parse((await events(pre, 'agent.dialog_cleared'))[0].payload).by, 'hook:PreToolUse')
})

test('Bug 188, what it must not catch: a dialog still open stays, whatever hooks come; a helper\'s hooks and another agent\'s look at nothing', async () => {
  const waiting = await tpm(), menu = await tpm(), stale = await tpm(), helper = await tpm(), other = await tpm()
  for (const x of [waiting, menu, stale, helper, other]) await atDialog(x)
  // a helper's dialog, or a second one in parallel: the main loop goes on while the file still says waiting
  await hq.hook(waiting.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/r/a.txt' } })
  await hq.session(menu.id, 'busy'); await drawn(menu, MENU); await escape(menu, true) // the file says busy but the menu is still on screen
  await hq.session(stale.id, 'idle', Date.now() - 60_000); await hq.hook(stale.id, { hook_event_name: 'Stop', last_assistant_message: 'x' }) // nothing since the notice
  for (const x of [waiting, menu, stale]) await waitFor(`HQ to give up looking at ${x.id}`, async () => (await events(x, 'dialog.still_open')).length === 1, 8000)
  for (const x of [waiting, menu, stale]) assert.ok(await open(x), x.id)
  assert.equal((await now(menu)).status, 'blocked', 'still on its dialog'); assert.equal((await now(menu)).interrupted_at > 0, true, 'the interrupt is kept for later')
  // a helper's hook (agent_id) is not the main loop going on, and the hooks above were other agents': neither looks at these two
  await hq.session(helper.id, 'busy'); await hq.hook(helper.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/r/b' }, agent_id: 'h188' })
  await hq.session(other.id, 'busy')
  // the menu goes: the next sign clears it, and the interrupt it held back now applies
  await drawn(menu, 'Interrupted · What should Claude do instead?\n'); await hq.session(menu.id, 'idle'); await escape(menu, true)
  await cleared(menu); assert.deepEqual(await seen(menu), ['idle', null, true])
  for (const x of [helper, other]) { assert.ok(await open(x), x.id); assert.equal((await events(x, 'dialog.still_open')).length + (await events(x, 'agent.dialog_cleared')).length, 0, x.id) }
})

// Bug 217: Escape (or an answer) on a dialog while the backend is down: the mod's turn.complete and the hooks go to no one, so HQ looks once at start-up at
// every agent with a dialog notice open. The sweep is held off (HQ_STUCK_TICK_S), so only that look can clear one.
test('Bug 217: a dialog that ended while HQ was down clears within seconds of the start; one still open stays', async () => {
  const esc = await tpm(), yes = await tpm(), still = await tpm(), none = await tpm()
  for (const x of [esc, yes, still]) await atDialog(x)
  const [e, y] = [await now(esc), await now(yes)]; await hq.down()
  await hq.session(e, 'idle'); await hq.session(y, 'busy') // Escape on one, Yes on another: no sign reaches HQ
  await hq.up()
  for (const x of [esc, yes]) await cleared(x)
  assert.deepEqual((await seen(esc)).slice(0, 2), ['idle', null]); assert.equal((await now(yes)).status, 'working')
  for (const x of [esc, yes]) assert.deepEqual((await events(x, 'agent.dialog_cleared')).map((e) => JSON.parse(e.payload).by), ['hq_start'], x.id)
  // what it must not catch: a dialog still open after the start (its file says waiting) keeps its notice, and an agent with none isn't looked at
  await waitFor('HQ to give up looking at the open dialog', async () => (await events(still, 'dialog.still_open')).length === 1, 8000)
  assert.ok(await open(still)); assert.equal((await now(still)).status, 'blocked')
  assert.equal((await events(none, 'dialog.still_open')).length + (await events(none, 'agent.dialog_cleared')).length, 0)
  // still found by its usual sign once it ends later
  await hq.session(still.id, 'idle'); await escape(still); await cleared(still); assert.equal((await now(still)).status, 'idle')
})

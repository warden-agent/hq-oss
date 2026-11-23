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

// Bug 254: Escape or No on a dialog in its first ~6 s, before Claude Code's permission_prompt notification: no dialog notice is open, and the turn ends with no
// Stop hook and a turn.complete that says isAborted false (real 2.1.322). The mod's turn.start says which turn it was, so HQ knows no Stop or prompt came since.
const start = (a: any, turnId: string, helper: string | null = null) => hq.modEvent(a.id, { kind: 'turn.start', turnId, agentId: helper })
const complete = (a: any, turnId: string, helper: string | null = null) =>
  hq.modEvent(a.id, { kind: 'turn.complete', turnId, agentId: helper, isAborted: false, durationMs: 1500, answer: '' })
const ask = (a: any, prompt: string) => hq.hook(a.id, { hook_event_name: 'UserPromptSubmit', prompt })
const run = (a: any, command: string) => hq.hook(a.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: `u${++n}` })

test('Bug 254: Escape or No on a dialog before its notice: idle at once, no activity line; what it must not catch', async () => {
  const esc = await tpm(), helper = await tpm(), raced = await tpm(), normal = await tpm(), older = await tpm()
  for (const x of [esc, helper, raced, normal, older]) { await ask(x, 'go on'); await start(x, 'T1'); await run(x, 'touch one.txt') }
  assert.deepEqual(await seen(esc), ['working', 'Running: touch one.txt', false])
  await complete(esc, 'T1')
  assert.deepEqual(await seen(esc), ['idle', null, false])
  assert.equal(await open(esc), undefined, 'no notice was ever raised')
  // a helper's turn starting and ending is not the agent's own: it stays working until its own turn ends
  await start(helper, 'H1', 'a254'); await complete(helper, 'H1', 'a254'); await complete(helper, 'T1', 'a254')
  assert.deepEqual(await seen(helper), ['working', 'Running: touch one.txt', false])
  await complete(helper, 'T1'); assert.deepEqual(await seen(helper), ['idle', null, false])
  // the message the mod had waiting goes in the moment the agent is idle, and its prompt can reach HQ before the turn.complete (same 0.1 s on 2.1.322)
  await ask(raced, 'HQ message batch b-1:\nhello'); await complete(raced, 'T1')
  assert.deepEqual(await seen(raced), ['working', 'Thinking', false])
  await start(raced, 'T2'); await hq.hook(raced.id, { hook_event_name: 'Stop', last_assistant_message: 'hi' }); await complete(raced, 'T2')
  assert.deepEqual(await seen(raced), ['idle', null, false])
  // a turn that ends normally: its Stop comes first; the next turn's prompt may beat that turn's turn.complete too
  await hq.hook(normal.id, { hook_event_name: 'Stop', last_assistant_message: 'done' }); await ask(normal, 'and one more thing'); await complete(normal, 'T1')
  assert.deepEqual(await seen(normal), ['working', 'Thinking', false])
  // the turn.complete of a turn that is no longer the latest one the mod said started
  await start(older, 'T2'); await complete(older, 'T1')
  assert.deepEqual(await seen(older), ['working', 'Running: touch one.txt', false])
  // none known (the turn started before a restart, or the mod's turn.start was lost): as before, the screen check covers it
  const unknown = await tpm(); await ask(unknown, 'go on'); await run(unknown, 'touch two.txt'); await complete(unknown, 'T9')
  assert.deepEqual(await seen(unknown), ['working', 'Running: touch two.txt', false])
})

test('Bug 254: a helper of its own still running keeps it working after a quick Escape; a dialog notice already open is Bug 188\'s way', async () => {
  const helped = await tpm(), d = 'Map the code'
  await ask(helped, 'go on'); await start(helped, 'T1')
  await hq.hook(helped.id, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: d }, tool_response: { isAsync: true, agentId: 'h254', description: d } })
  await run(helped, 'touch one.txt'); await complete(helped, 'T1')
  assert.deepEqual(await seen(helped), ['working', `Subagent: ${d}`, false])
  await hq.hook(helped.id, { hook_event_name: 'SubagentStop', agent_id: 'h254' }); assert.deepEqual(await seen(helped), ['idle', null, false])
  // after the notice: still blocked until HQ has seen the dialog gone, then idle (Bug 188)
  const late = await tpm(); await atDialog(late); await start(late, 'T1'); await hq.session(late.id, 'idle'); await complete(late, 'T1')
  await cleared(late); assert.deepEqual(await seen(late), ['idle', null, false])
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

// Bug 289: a turn that ends with no Stop hook and no interrupt (Escape or No on a dialog) gets a "Turn ended" line in the Events tab, once, whichever way HQ
// learns of it; a turn that ends any other way keeps the line it had (its Stop, or "Interrupted").
const lines = async (a: any): Promise<string[]> => ((await hq.api(`agents/${a.id}/events`)).json.events as any[]).map((e) => e.text)
const turnOvers = async (a: any) => (await events(a, 'agent.turn_over')).map((e) => JSON.parse(e.payload))
test('Bug 289: Escape or No on a dialog says the turn ended, in the Events tab; a Stop, an interrupt or a turn HQ knows nothing of add no such line', async () => {
  const esc = await tpm(); await ask(esc, 'go on'); await start(esc, 'T1'); await run(esc, 'touch one.txt'); await complete(esc, 'T1')
  assert.deepEqual(await turnOvers(esc), [{ why: 'no_stop', still: null }])
  assert.equal((await lines(esc))[0], 'Turn ended: Escape or No on a question on its screen')
  const helped = await tpm(), d = 'Map the code'; await ask(helped, 'go on'); await start(helped, 'T1')
  await hq.hook(helped.id, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: d }, tool_response: { isAsync: true, agentId: 'h289', description: d } })
  await complete(helped, 'T1')
  assert.equal((await lines(helped))[0], `Turn ended: Escape or No on a question on its screen · its helper still runs: ${d}`)
  // the dialog's notice was open: the line comes once HQ has seen the dialog gone (Bug 188's way), not twice
  const late = await tpm(); await atDialog(late); await start(late, 'T1'); await hq.session(late.id, 'idle'); await complete(late, 'T1'); await cleared(late)
  await waitFor('the turn-ended line', async () => (await turnOvers(late)).length === 1, 5000)
  assert.deepEqual(await turnOvers(late), [{ why: 'dialog', still: null }])
  const l = await lines(late); assert.deepEqual(l.slice(0, 2), ['Turn ended: Escape or No on a question on its screen', 'A question on its screen was answered'])
  // what it must not catch: a Stop (its own line), an interrupt ("Interrupted"), a normal turn with a dialog, and a turn.complete for a turn not known
  const stopped = await tpm(); await ask(stopped, 'go on'); await start(stopped, 'T1'); await hq.hook(stopped.id, { hook_event_name: 'Stop', last_assistant_message: 'done' })
  await complete(stopped, 'T1')
  const intr = await tpm(); await ask(intr, 'go on'); await start(intr, 'T1'); await escape(intr, true)
  const asked = await tpm(); await atDialog(asked); await start(asked, 'T1'); await hq.session(asked.id, 'idle')
  await hq.hook(asked.id, { hook_event_name: 'Stop', last_assistant_message: 'ok' }); await complete(asked, 'T1'); await cleared(asked) // once cleared, what follows the clear has run
  const unknown = await tpm(); await ask(unknown, 'go on'); await run(unknown, 'touch two.txt'); await complete(unknown, 'T9')
  for (const x of [stopped, intr, asked, unknown]) assert.deepEqual(await turnOvers(x), [], x.id)
  assert.equal((await lines(stopped))[0], 'Turn ended: done'); assert.equal((await lines(intr))[0], 'Interrupted (Escape)')
})

// Bug 352: an API error ends a turn with no Stop hook too. Its StopFailure says so ("Turn failed: …"); on 2.1.322 the mod's turn.complete (reason 'error')
// comes first, and it used to add "Escape or No on a question on its screen". The status is the StopFailure's either way: blocked on the API error.
const failed = (a: any, turnId: string) =>
  hq.modEvent(a.id, { kind: 'turn.complete', turnId, agentId: null, isAborted: false, reason: 'error', durationMs: 900, answer: '' })
test('Bug 352: a turn that ends on an API error reads "Turn failed", never "Escape or No", in either order; a turn with no Stop still does', async () => {
  const late = await tpm(), early = await tpm(), plain = await tpm()
  for (const x of [late, early, plain]) { await ask(x, 'go on'); await start(x, 'T1'); await run(x, 'touch one.txt') }
  await failed(late, 'T1'); await hq.hook(late.id, { hook_event_name: 'StopFailure', error: 'overloaded_error' }) // 2.1.322's order
  await hq.hook(early.id, { hook_event_name: 'StopFailure', error: 'overloaded_error' }); await failed(early, 'T1')
  for (const x of [late, early]) {
    assert.deepEqual(await turnOvers(x), [], x.id)
    const l = await lines(x); assert.ok(l.slice(0, 2).includes('Turn failed: overloaded_error'), `${x.id}: ${l.slice(0, 3).join(' | ')}`); assert.ok(!l.some((t) => /Escape or No/.test(t)), x.id)
    const a = await now(x); assert.deepEqual([a.status, a.blocked_why], ['blocked', 'api_error'], x.id)
  }
  // what it must not catch: a turn the mod says ended with an answer and no Stop keeps Bug 289's line
  await hq.modEvent(plain.id, { kind: 'turn.complete', turnId: 'T1', agentId: null, isAborted: false, reason: 'answer', durationMs: 900, answer: '' })
  assert.deepEqual(await turnOvers(plain), [{ why: 'no_stop', still: null }])
})

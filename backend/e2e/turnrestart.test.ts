// Bugs 268, 281: a turn of the agent's own that ends across a backend restart. Bug 254 ends a turn that completes with no Stop hook (a quick Escape or No on
// a dialog, before its notice) from the mod's turn.start, which HQ kept in memory only: after a restart nothing ended such a turn (281). And a turn that
// ended while HQ was down sent its sign (the mod's turn.complete, a Stop hook) to no one (268). Either way the box said "working" until the stuck loop's
// screen check, held off here (HQ_STUCK_TICK_S), so only the fix can end the turn.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_STUCK_TICK_S: '3600', HQ_DIALOG_LOOK_S: '3' } }) })
after(async () => { await hq?.stop() })
let n = 0
async function tpm(): Promise<any> {
  const repo = (await hq.api('repos', { path: hq.repo(`r${++n}`) })).json, a = (await hq.api(`repos/${repo.id}/message`, { body: 'hello' })).json.agent
  return waitFor('the TPM', async () => (await hq.state()).agents.find((x: any) => x.id === a.id && x.status === 'working'))
}
const now = async (a: any) => (await hq.state()).agents.find((x: any) => x.id === a.id)
const seen = async (a: any) => { const x = await now(a); return [x.status, x.activity ?? null] }
const events = async (a: any, kind: string) => ((await hq.api(`events?agent=${a.id}&limit=200`)).json as any[]).filter((e) => e.kind === kind)
const start = (a: any, turnId: string, helper: string | null = null) => hq.modEvent(a.id, { kind: 'turn.start', turnId, agentId: helper })
const complete = (a: any, turnId: string, helper: string | null = null) =>
  hq.modEvent(a.id, { kind: 'turn.complete', turnId, agentId: helper, isAborted: false, durationMs: 1500, answer: '' })
const ask = (a: any, prompt: string) => hq.hook(a.id, { hook_event_name: 'UserPromptSubmit', prompt })
const run = (a: any, command: string) => hq.hook(a.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: `u${++n}` })
const looks = async (): Promise<any[]> => ((await hq.api('events?limit=2000')).json as any[]).filter((e) => e.kind === 'turn.start_look')
/** The backend goes away and comes back (agents stay), `meanwhile` done while it is down; then the start-up look at turns is over. */
async function restart(meanwhile: () => Promise<void> = async () => {}): Promise<void> {
  const before = (await looks()).length; await hq.down(); await meanwhile(); await hq.up()
  await waitFor('HQ\'s start-up look at turns', async () => (await looks()).length > before, 10_000)
}

test('Bug 281: a quick Escape on a turn that started before a restart ends it; what it must not catch', async () => {
  const esc = await tpm(), normal = await tpm(), older = await tpm(), helper = await tpm(), fresh = await tpm()
  for (const x of [esc, normal, older, helper, fresh]) { await ask(x, 'go on'); await start(x, 'T1'); await run(x, 'touch one.txt') }
  await hq.hook(normal.id, { hook_event_name: 'Stop', last_assistant_message: 'done' }); await ask(normal, 'and one more thing') // the next turn's prompt
  await start(older, 'T2')
  await restart() // every status file still says busy (as the fake writes it): the start-up look leaves them alone
  for (const x of [esc, normal, older, helper, fresh]) assert.equal((await now(x)).status, 'working', x.id)
  await complete(esc, 'T1') // Escape or No on its dialog in its first seconds: no Stop, isAborted false
  assert.deepEqual(await seen(esc), ['idle', null])
  await complete(normal, 'T1'); assert.equal((await now(normal)).status, 'working', 'its next turn is under way')
  await complete(older, 'T1'); assert.equal((await now(older)).status, 'working', 'T1 is no longer its latest turn')
  await start(helper, 'H1', 'a281'); await complete(helper, 'H1', 'a281'); await complete(helper, 'T1', 'a281')
  assert.equal((await now(helper)).status, 'working', 'a helper\'s turns are not its own'); await complete(helper, 'T1'); assert.equal((await now(helper)).status, 'idle')
  await ask(fresh, 'a new turn after the restart'); await complete(fresh, 'T1'); assert.equal((await now(fresh)).status, 'working', 'a prompt came after T1 started')
  // the counter goes on above what was read back: a new turn after the restart, ended by a quick Escape too
  await start(fresh, 'T2'); await run(fresh, 'touch two.txt'); await complete(fresh, 'T2'); assert.deepEqual(await seen(fresh), ['idle', null])
})

test('Bug 268: a turn that ended while HQ was down is idle once HQ is back; one still at work, at a dialog or unknown stays', async () => {
  const esc = await tpm(), busy = await tpm(), waiting = await tpm(), stale = await tpm(), menu = await tpm(), helped = await tpm(), ended = await tpm()
  for (const x of [esc, busy, waiting, stale, menu, helped, ended]) { await ask(x, 'go on'); await start(x, 'T1'); await run(x, 'touch one.txt') }
  const d = 'Map the code'
  await hq.hook(helped.id, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: d }, tool_response: { isAsync: true, agentId: 'h268', description: d } })
  await hq.hook(ended.id, { hook_event_name: 'Stop', last_assistant_message: 'done' }); assert.equal((await now(ended)).status, 'idle')
  await hq.screen(menu, '\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n')
  await waitFor('the menu on screen', () => hq.tmux('capture-pane', '-p', '-t', menu.tmux_session).includes('Do you want to proceed?'), 5000)
  const was = Object.fromEntries(await Promise.all([esc, busy, waiting, stale, menu, helped].map(async (x) => [x.id, await now(x)])))
  await restart(async () => { // what Claude Code's status file says once each turn ended, or didn't, while no sign could reach HQ
    await hq.session(was[esc.id], 'idle'); await hq.session(was[busy.id], 'busy'); await hq.session(was[waiting.id], 'waiting')
    await hq.session(was[stale.id], 'idle', Date.now() - 60_000) // idle since before HQ's last hook from it: not a change HQ missed
    await hq.session(was[menu.id], 'idle'); await hq.session(was[helped.id], 'idle')
  })
  assert.deepEqual(await seen(esc), ['idle', null])
  assert.equal((await events(esc, 'agent.turn_ended_away')).length, 1)
  for (const x of [busy, waiting, stale, menu]) {
    assert.equal((await now(x)).status, 'working', x.id); assert.equal((await events(x, 'agent.turn_ended_away')).length, 0, x.id)
  }
  assert.deepEqual(await seen(helped), ['working', `Subagent: ${d}`], 'its turn is over, its helper still works (Bug 94)')
  assert.equal((await now(ended)).status, 'idle'); assert.equal((await events(ended, 'agent.turn_ended_away')).length, 0, 'HQ knew it was idle')
  // still found by its usual sign once it ends later; and a quick Escape after this restart on the turn from before it (Bug 281)
  await hq.hook(busy.id, { hook_event_name: 'Stop', last_assistant_message: 'done' }); assert.equal((await now(busy)).status, 'idle')
  await complete(stale, 'T1'); assert.deepEqual(await seen(stale), ['idle', null])
})

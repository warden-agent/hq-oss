// Bugs 297, 298 end to end: the agent's own turn ends while HQ's backend is down. Claude Code's http hooks (the Stop with the TPM's reply) and the mod's
// reports both fail then. The real mod (plugin/hooks/register.js, run by modhost.ts) keeps its turn.start and turn.complete and sends them again once HQ
// is back, before its next ask: HQ records the reply whose Stop it missed (297) and keeps the interrupt of an Escape (298), so the next message is typed
// into the terminal at once (Bug 110) instead of being dropped by Claude Code until the 90 s requeue.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { startHq, waitFor, type Hq } from './harness.ts'
import { startMod, type ModHost } from './modhost.ts'

let hq: Hq
const mods: ModHost[] = []
before(async () => { hq = await startHq({ env: { HQ_STUCK_TICK_S: '3600' } }) }) // the screen check must not be what ends a turn here
after(async () => { for (const m of mods) m.stop(); await hq?.stop() })

let n = 0
const say = (agentId: string, body: string) => hq.api(`agents/${agentId}/message`, { body, reason: 'fyi' })
const agentNow = async (a: any) => (await hq.state()).agents.find((x: any) => x.id === a.id)
const replies = async (a: any): Promise<string[]> =>
  (await hq.state()).messages.filter((m: any) => m.from_id === a.id && m.to_id === 'user').sort((x: any, y: any) => x.created_at - y.created_at).map((m: any) => m.body)
const events = async (a: any, kind: string) => ((await hq.api(`events?agent=${a.id}&limit=500`)).json as any[]).filter((e) => e.kind === kind)
const turn = () => new Promise((r) => setImmediate(r))
const RULE = '─'.repeat(60)
/** Claude Code's screen after Escape stopped a turn (2.1.322): the waiting prompt, with nothing running. HQ types only into that. */
const INTERRUPTED = `⏺ Writing a long list\n  ⎿  Interrupted · What should Claude do instead?\n\n${RULE} TPM b297 ─\n❯ \n${RULE}\n  ⏸ manual mode on · ? for shortcuts\n`
const pane = (a: any): string => hq.tmux('capture-pane', '-p', '-J', '-t', a.tmux_session)

/** A project's TPM with the real mod, its launch prompt in and its first turn ended (a Stop HQ got). `prompts`: what the mod has submitted. */
async function tpmWithMod() {
  const name = `b297x${++n}`, repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const prompts: string[] = []
  const mod = await startMod({ backend: `http://127.0.0.1:${hq.ports.hooks}`, agentId: tpm.id, tokenFile: path.join(hq.hqHome, 'agents', tpm.id, 'token'),
    submit: async (text) => { prompts.push(text); await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: text }).catch(() => {}) } })
  mods.push(mod); mod.tick()
  await waitFor('the launch prompt', () => prompts.length === 1)
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Hello.' })
  return { tpm, mod, prompts }
}
/** A turn of the agent's own starts with HQ up: its prompt's hook, then the mod's turn.start (the order Claude Code keeps). */
async function startTurn(t: { tpm: any; mod: ModHost }, turnId: string, prompt = 'Please do a thing.') {
  await hq.hook(t.tpm.id, { hook_event_name: 'UserPromptSubmit', prompt }); await t.mod.fire('turn.start', { turnId, text: prompt })
  assert.equal((await agentNow(t.tpm)).status, 'working')
}
/** The mod's reports that failed while HQ was down go once it is back, at the mod's next tick, before its next ask. */
async function backAndTick(mod: ModHost) {
  await hq.up(); const asks = mod.asks(); mod.tick(); await waitFor('the mod\'s next ask', () => mod.asks() > asks); await turn()
}

test('Bug 297: a reply whose Stop hook went to a downed HQ is recorded once HQ is back, once, whole', async () => {
  const t = await tpmWithMod(), long = `Here is the list:\n${Array.from({ length: 60 }, (_, i) => `${i + 1}. Item number ${i + 1}`).join('\n')}\nDONE-297`
  await startTurn(t, 'T1')
  await hq.down()
  await t.mod.step({ turnId: 'T1' }, { toolUses: [{ name: 'Read' }] }) // it read a file, then answered
  await t.mod.step({ turnId: 'T1' }, { toolUses: [] })
  await t.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'answer', answer: long, durationMs: 4000 }) // its Stop hook failed too
  await backAndTick(t.mod)
  await waitFor('the reply', async () => (await replies(t.tpm)).includes(long), 5000)
  const a = await agentNow(t.tpm); assert.equal(a.status, 'idle'); assert.equal(a.last_message, long)
  const stops = await events(t.tpm, 'hook.Stop'); assert.equal(JSON.parse(stops[0].payload).away, true, 'logged as a Stop that came late')
  t.mod.tick(); await turn(); await waitFor('another ask', () => t.mod.asks() > 2)
  assert.deepEqual(await replies(t.tpm), ['Hello.', long], 'once')
  // the next turn, with HQ up, ends as usual
  await startTurn(t, 'T2'); await hq.hook(t.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Next.' })
  await t.mod.fire('turn.complete', { turnId: 'T2', isAborted: false, reason: 'answer', answer: 'Next.', durationMs: 900 })
  assert.deepEqual(await replies(t.tpm), ['Hello.', long, 'Next.'])
})

test('Bug 297: a turn that started while HQ was down (typed in its terminal) and ended there is recorded too', async () => {
  const t = await tpmWithMod()
  await hq.down()
  await t.mod.fire('turn.start', { turnId: 'T1', text: 'typed by the user' }) // its UserPromptSubmit hook failed
  await t.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'answer', answer: 'Typed answer.', durationMs: 800 })
  await backAndTick(t.mod)
  await waitFor('the reply', async () => (await replies(t.tpm)).includes('Typed answer.'), 5000)
  assert.equal((await agentNow(t.tpm)).status, 'idle')
})

test('Bug 297, what it must not catch: a Stop HQ got, an Escape or No on a dialog, an API error, a turn the user ended with Escape', async () => {
  // HQ went down just after the Stop: the mod's turn.complete comes late, and the reply is already there
  const got = await tpmWithMod(); await startTurn(got, 'T1')
  await hq.hook(got.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Got it.' }); await hq.down()
  await got.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'answer', answer: 'Got it.', durationMs: 900 })
  await backAndTick(got.mod)
  assert.deepEqual(await replies(got.tpm), ['Hello.', 'Got it.'])
  // the rest end while HQ is down: a turn that ends at a tool call (Escape or No on its dialog: no Stop hook even with HQ up, reason 'answer' on
  // 2.1.322), one that ends on an API error (a StopFailure, not a Stop), one the user interrupted
  const dialog = await tpmWithMod(), error = await tpmWithMod(), esc = await tpmWithMod()
  for (const x of [dialog, error, esc]) await startTurn(x, 'T1')
  await hq.down()
  await dialog.mod.step({ turnId: 'T1' }, { toolUses: [{ name: 'Read' }] })
  await dialog.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'answer', answer: 'I will read the file.', durationMs: 900 })
  await error.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'error', answer: 'Half an answer', durationMs: 900 })
  await esc.mod.fire('turn.complete', { turnId: 'T1', isAborted: true, reason: 'aborted', answer: 'Half an answer', durationMs: 900 })
  await hq.up()
  for (const x of [dialog, error, esc]) { const asks = x.mod.asks(); x.mod.tick(); await waitFor('the mod\'s next ask', () => x.mod.asks() > asks) }
  await turn()
  for (const x of [dialog, error, esc]) {
    assert.deepEqual(await replies(x.tpm), ['Hello.'], x.tpm.id); assert.equal((await events(x.tpm, 'hook.Stop')).length, 1, x.tpm.id)
  }
  assert.ok((await agentNow(esc.tpm)).interrupted_at, 'the Escape is kept (Bug 298)')
  assert.equal((await agentNow(dialog.tpm)).interrupted_at, null); assert.equal((await agentNow(error.tpm)).interrupted_at, null)
})

const openAlerts = async (a: any) => (await hq.state()).attention.filter((x: any) => x.kind === 'api_error' && x.agent_id === a.id && !x.resolved_at)

test('Bug 367: a turn that ended on an API error (or a refusal) while HQ was down is shown failed once HQ is back, once', async () => {
  // error: started with HQ up, failed while it was down. refused: the API refused its reply (also a StopFailure turn on 2.1.322). typed: started and failed
  // while HQ was down (the mod marks its start `over`)
  const error = await tpmWithMod(), refused = await tpmWithMod(), typed = await tpmWithMod()
  for (const x of [error, refused]) await startTurn(x, 'T1')
  await hq.down()
  await error.mod.step({ turnId: 'T1' }, { toolUses: [{ name: 'Read' }] })
  await error.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'error', answer: 'I will read the file.', durationMs: 900 })
  await refused.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'refusal', answer: '', durationMs: 900 })
  await typed.mod.fire('turn.start', { turnId: 'T1', text: 'typed b367' })
  await typed.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'error', answer: '', durationMs: 900 })
  await hq.up()
  for (const x of [error, refused, typed]) { const asks = x.mod.asks(); x.mod.tick(); await waitFor('the mod\'s next ask', () => x.mod.asks() > asks) }
  await turn()
  for (const x of [error, refused, typed]) {
    const a = await agentNow(x.tpm); assert.deepEqual([a.status, a.blocked_why, a.activity ?? null], ['blocked', 'api_error', null], x.tpm.id)
    const fails = await events(x.tpm, 'hook.StopFailure'); assert.equal(fails.length, 1, x.tpm.id); assert.equal(JSON.parse(fails[0].payload).away, true)
    assert.equal((await openAlerts(x.tpm)).length, 1, `${x.tpm.id}: its ⚠`)
    assert.deepEqual(await replies(x.tpm), ['Hello.'], 'not a reply'); assert.equal((await events(x.tpm, 'agent.turn_over')).length, 0, 'no "Escape or No" line')
  }
  assert.match((await openAlerts(error.tpm))[0].detail, /turn ended with an API error while HQ was down$/)
  assert.match((await openAlerts(refused.tpm))[0].detail, /turn ended with an API error while HQ was down \(the API refused its reply\)$/)
  // the turn's own StopFailure, very late (after HQ said it): logged as old news, no second line or ⚠ (Bug 386's failureTold reads Bug 367's mark too)
  const before = (await openAlerts(refused.tpm))[0].detail
  await hq.hook(refused.tpm.id, { hook_event_name: 'StopFailure', error: 'overloaded_error' })
  assert.deepEqual((await events(refused.tpm, 'hook.StopFailure')).map((e) => JSON.parse(e.payload).told ?? false), [true, false]) // newest first
  assert.equal((await openAlerts(refused.tpm)).length, 1); assert.equal((await openAlerts(refused.tpm))[0].detail, before)
  // the user's next message starts a turn: the error is over (Bug 178), as after a StopFailure HQ heard
  await startTurn(error, 'T2'); assert.equal((await openAlerts(error.tpm)).length, 0)
})

test('Bug 367, what it must not catch: a StopFailure HQ heard, a Stop HQ heard, a turn that started since, a turn that ended normally', async () => {
  const heard = await tpmWithMod(), stopped = await tpmWithMod(), since = await tpmWithMod(), normal = await tpmWithMod()
  for (const x of [heard, stopped, since, normal]) await startTurn(x, 'T1')
  await hq.hook(heard.tpm.id, { hook_event_name: 'StopFailure', error: 'overloaded_error' }) // HQ went down just after it: the mod's report comes late
  await hq.hook(stopped.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Retried b367.' }) // a refusal Claude Code retried to a normal answer
  await hq.down()
  await heard.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'error', answer: '', durationMs: 900 })
  await stopped.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'refusal', answer: 'Retried b367.', durationMs: 900 })
  await since.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'error', answer: '', durationMs: 900 })
  await normal.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'answer', answer: 'Normal b367.', durationMs: 900 })
  await hq.up()
  await hq.hook(since.tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'try again b367' }) // the user's retry, heard before the mod's late report
  for (const x of [heard, stopped, since, normal]) { const asks = x.mod.asks(); x.mod.tick(); await waitFor('the mod\'s next ask', () => x.mod.asks() > asks) }
  await turn()
  assert.deepEqual((await events(heard.tpm, 'hook.StopFailure')).map((e) => JSON.parse(e.payload).away ?? false), [false], 'only the one HQ heard')
  assert.equal((await openAlerts(heard.tpm)).length, 1)
  for (const x of [stopped, since, normal]) {
    assert.equal((await events(x.tpm, 'hook.StopFailure')).length, 0, x.tpm.id); assert.equal((await openAlerts(x.tpm)).length, 0, x.tpm.id)
  }
  assert.equal((await agentNow(stopped.tpm)).status, 'idle'); assert.equal((await agentNow(since.tpm)).status, 'working')
  assert.equal((await agentNow(normal.tpm)).status, 'idle'); assert.ok((await replies(normal.tpm)).includes('Normal b367.'))
})

test('Bug 298: an Escape while HQ was down is known once HQ is back, so the next message is typed at once, not handed to a mod that drops it', async () => {
  const t = await tpmWithMod(); await startTurn(t, 'T1')
  await hq.screen(t.tpm.id, INTERRUPTED); await waitFor('the screen', () => pane(t.tpm).includes('Interrupted')) // what Escape leaves (drawn while HQ is up)
  await hq.down()
  await t.mod.fire('turn.complete', { turnId: 'T1', isAborted: true, reason: 'aborted', answer: '', durationMs: 3000 })
  await backAndTick(t.mod)
  assert.ok((await agentNow(t.tpm)).interrupted_at)
  await say(t.tpm.id, 'After the Escape.')
  await waitFor('HQ to type it', async () => (await events(t.tpm, 'batch.typed')).length === 1, 10_000)
  await waitFor('the line in the terminal', () => pane(t.tpm).includes('After the Escape.'))
  assert.ok(!t.prompts.includes('After the Escape.'), 'not handed to the mod')
})

test('Bug 298: a turn that started after the Escape (typed while HQ was down) and ended normally leaves no interrupt behind', async () => {
  const t = await tpmWithMod(); await startTurn(t, 'T1')
  await hq.down()
  await t.mod.fire('turn.complete', { turnId: 'T1', isAborted: true, reason: 'aborted', answer: '', durationMs: 3000 })
  await t.mod.fire('turn.start', { turnId: 'T2', text: 'never mind, say hi' }) // typed in its terminal: Claude Code takes typed prompts after an Escape
  await t.mod.fire('turn.complete', { turnId: 'T2', isAborted: false, reason: 'answer', answer: 'Hi.', durationMs: 700 })
  await backAndTick(t.mod)
  await waitFor('the reply', async () => (await replies(t.tpm)).includes('Hi.'), 5000)
  const a = await agentNow(t.tpm); assert.equal(a.interrupted_at, null); assert.equal(a.status, 'idle')
  assert.equal((await events(t.tpm, 'agent.interrupted')).length, 0, 'the Escape of the turn before was moot')
  await say(t.tpm.id, 'Through the mod.')
  await waitFor('the mod to submit it', () => t.prompts.includes('Through the mod.'), 5000)
})

test('Bug 346: a turn that started while HQ was down and still goes shows working once HQ is back, and idle after its Stop', async () => {
  const t = await tpmWithMod(); assert.equal((await agentNow(t.tpm)).status, 'idle')
  await hq.down()
  await t.mod.fire('turn.start', { turnId: 'T1', text: 'typed by the user' }) // its UserPromptSubmit hook failed
  await t.mod.step({ turnId: 'T1' }, { toolUses: [{ name: 'Read' }] }) // its hooks for this went nowhere too
  await backAndTick(t.mod)
  const a = await agentNow(t.tpm); assert.equal(a.status, 'working', 'working once HQ heard its turn start'); assert.equal(a.activity, 'Thinking')
  assert.equal((await events(t.tpm, 'agent.turn_started_away')).length, 1)
  // it goes on and ends with HQ up: as usual
  await hq.hook(t.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Typed answer 346.' })
  await t.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'answer', answer: 'Typed answer 346.', durationMs: 8000 })
  assert.equal((await agentNow(t.tpm)).status, 'idle'); assert.deepEqual(await replies(t.tpm), ['Hello.', 'Typed answer 346.'])
  assert.equal((await events(t.tpm, 'agent.turn_over')).length, 0, 'it had its Stop: no "no Stop" line')
})

test('Bug 346: an API error before HQ went down is over once a turn started while it was down is heard of', async () => {
  const t = await tpmWithMod(); await startTurn(t, 'T1')
  await hq.hook(t.tpm.id, { hook_event_name: 'StopFailure', error: 'overloaded' })
  await t.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'error', answer: '', durationMs: 900 })
  assert.equal((await agentNow(t.tpm)).status, 'blocked')
  await hq.down(); await t.mod.fire('turn.start', { turnId: 'T2', text: 'try again' }); await backAndTick(t.mod)
  const a = await agentNow(t.tpm); assert.equal(a.status, 'working'); assert.equal(a.blocked_why, null)
  assert.ok(!(await hq.state()).attention.some((x: any) => x.kind === 'api_error' && x.agent_id === t.tpm.id && !x.resolved_at), 'its ⚠ is gone')
})

test('Bug 346, what it must not catch: a turn that also ended while HQ was down, a Stop HQ heard first, an agent already working', async () => {
  // started and ended while HQ was down: never shown working (the mod marks the start `over`), and its reply is recorded (Bug 297).
  // started while down; HQ came back and heard its Stop before the mod's late start (the mod's turn.complete not yet sent).
  // started while down, and a tool call heard once HQ is back made it working already
  const both = await tpmWithMod(), stopFirst = await tpmWithMod(), busy = await tpmWithMod()
  await hq.down()
  for (const x of [both, stopFirst, busy]) await x.mod.fire('turn.start', { turnId: 'T1', text: 'typed' })
  await both.mod.fire('turn.complete', { turnId: 'T1', isAborted: false, reason: 'answer', answer: 'Both 346.', durationMs: 800 })
  await hq.up()
  await hq.hook(stopFirst.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Quick 346.' })
  await hq.hook(busy.tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/notes.md' } })
  for (const x of [both, stopFirst, busy]) { const asks = x.mod.asks(); x.mod.tick(); await waitFor('the mod\'s next ask', () => x.mod.asks() > asks) }
  await turn()
  await waitFor('the reply', async () => (await replies(both.tpm)).includes('Both 346.'), 5000)
  for (const x of [both, stopFirst]) {
    assert.equal((await agentNow(x.tpm)).status, 'idle', x.tpm.id); assert.equal((await events(x.tpm, 'agent.turn_started_away')).length, 0, x.tpm.id)
  }
  const b = await agentNow(busy.tpm); assert.equal(b.status, 'working'); assert.equal(b.activity, 'Reading x/notes.md', 'what it does, not "Thinking"')
  assert.equal((await events(busy.tpm, 'agent.turn_started_away')).length, 0)
})

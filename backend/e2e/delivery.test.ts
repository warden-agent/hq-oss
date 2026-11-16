// Message delivery and agent lifecycle end to end (see harness.ts): a batch the mod never got or couldn't submit comes back,
// a hold set mid-poll holds, only real answers answer a question, HQ's notices are HQ's, and a stopped agent's token is dead.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

async function setup(name: string): Promise<{ dir: string; repo: any; f: any; tpm: any }> {
  const dir = hq.repo(name)
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f, tpm }
}
/** The mod takes the launch prompt and Claude Code submits it (the UserPromptSubmit hook acks it). */
async function takeLaunch(agentId: string): Promise<void> {
  const b = (await hq.modNext(agentId)).batch; assert.ok(b, 'a launch batch'); await hq.modEvent(agentId, { kind: 'batch_received', id: b.id })
  await hq.hook(agentId, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
}
const say = (agentId: string, body: string) => hq.api(`agents/${agentId}/message`, { body, reason: 'fyi' })
const ticketOf = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)

test('a batch the mod could not submit is handed out again', async () => {
  const { tpm } = await setup('submit-failed')
  await takeLaunch(tpm.id)
  await say(tpm.id, 'Please split it into two tickets.')
  const b1 = (await hq.modNext(tpm.id)).batch; assert.match(b1.text, /two tickets/)
  await hq.modEvent(tpm.id, { kind: 'batch_received', id: b1.id }); await hq.modEvent(tpm.id, { kind: 'batch_submit_failed', id: b1.id, error: 'boom' })
  const b2 = (await hq.modNext(tpm.id)).batch
  assert.ok(b2, 'handed again'); assert.notEqual(b2.id, b1.id); assert.equal(b2.text, b1.text)
})

test('a batch that keeps failing is given up after three tries, and the user is told', async () => {
  const { tpm } = await setup('submit-loop')
  await takeLaunch(tpm.id)
  await say(tpm.id, 'Stubborn note.')
  for (let i = 0; i < 3; i++) {
    const b = (await hq.modNext(tpm.id)).batch; assert.ok(b, `try ${i + 1}`); assert.match(b.text, /Stubborn note/)
    await hq.modEvent(tpm.id, { kind: 'batch_received', id: b.id }); await hq.modEvent(tpm.id, { kind: 'batch_submit_failed', id: b.id, error: 'boom' })
  }
  assert.deepEqual(await hq.modNext(tpm.id), {}) // not handed out a fourth time
  const att = (await hq.state()).attention.find((a: any) => a.kind === 'delivery_failed' && a.agent_id === tpm.id)
  assert.ok(att); assert.match(att.detail, /3 times/)
  const m = (await hq.state()).messages.find((x: any) => x.body === 'Stubborn note.'); assert.equal(m.delivery_method, 'failed')
})

test('a batch that never reached the mod is handed out again; one it got is not', async () => {
  const { tpm } = await setup('never-received')
  await takeLaunch(tpm.id)
  assert.equal((await hq.api('settings', { key: 'batch_receive_s', value: 1 })).status, 200)
  await say(tpm.id, 'First note.')
  const lost = (await hq.modNext(tpm.id)).batch; assert.match(lost.text, /First note/) // the long-poll answer never arrives
  await new Promise((r) => setTimeout(r, 1300))
  const again = (await hq.modNext(tpm.id)).batch; assert.ok(again, 'handed again'); assert.equal(again.text, lost.text)
  await hq.modEvent(tpm.id, { kind: 'batch_received', id: again.id }) // this one got there; it waits for the session to go idle
  await new Promise((r) => setTimeout(r, 1300))
  assert.deepEqual(await hq.modNext(tpm.id), {})
  await hq.api('settings', { key: 'batch_receive_s', value: 30 })
})

test('a launch prompt the mod could not submit is handed out again', async () => {
  const { tpm } = await setup('launch-failed')
  const b1 = (await hq.modNext(tpm.id)).batch; assert.ok(b1.raw)
  await hq.modEvent(tpm.id, { kind: 'batch_received', id: b1.id }); await hq.modEvent(tpm.id, { kind: 'batch_submit_failed', id: b1.id, error: 'boom' })
  const b2 = (await hq.modNext(tpm.id)).batch
  assert.ok(b2, 'handed again'); assert.equal(b2.text, b1.text)
})

test('a hold set while the mod is polling holds the batch', async () => {
  const { tpm } = await setup('hold-mid-poll')
  await takeLaunch(tpm.id)
  const poll = hq.modNext(tpm.id, 2500)
  await new Promise((r) => setTimeout(r, 300))
  await hq.api(`agents/${tpm.id}/takeover`, { locked: true }); await say(tpm.id, 'Held note.')
  assert.deepEqual(await poll, {})
  await hq.api(`agents/${tpm.id}/takeover`, { locked: false })
  assert.match((await hq.modNext(tpm.id)).batch.text, /Held note/)
})

/** Writes to the test HQ's database, for state only time would bring (a mod gone quiet, a batch handed out long ago). */
function sql(query: string, ...args: (string | number)[]): void {
  const db = new DatabaseSync(path.join(hq.hqHome, 'hq.sqlite')); try { db.prepare(query).run(...args) } finally { db.close() }
}
/** Moves a batch's times 10 minutes back: past the "submitted but never started" wait (90 s) and the one-in-flight window (3 min). */
const ageBatch = (id: string) => sql(`UPDATE batches SET handed_at = handed_at - 600000, received_at = received_at - 600000,
  submitted_at = submitted_at - 600000 WHERE id = ?`, id)
const kinds = async (agentId: string, kind: string) => (await hq.api(`events?agent=${agentId}`)).json.filter((e: any) => e.kind === kind)

test('Bug 103: a message the Stop hook hands over counts as delivered and is not handed out again', async () => {
  const { tpm } = await setup('stop-hook')
  await takeLaunch(tpm.id)
  sql('UPDATE agents SET mod_seen_at = ? WHERE id = ?', Date.now() - 300_000, tpm.id) // its mod hasn't asked for work in 5 minutes
  await say(tpm.id, 'Stop-hook note.')
  const r = await hq.hookOnce(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' }) // not the Stop that follows
  assert.equal(r.decision, 'block'); assert.match(r.reason, /^HQ message batch (B-[0-9a-f]+):\n.*Stop-hook note\./s)
  const id = /B-[0-9a-f]+/.exec(r.reason)![0]
  // Claude Code goes on with the message as feedback on its turn, and no UserPromptSubmit follows (2.1.322), so the hook's answer is the delivery.
  const m = (await hq.state()).messages.find((x: any) => x.body === 'Stop-hook note.'); assert.equal(m.batch_id, id); assert.ok(m.ack_at, 'acknowledged')
  assert.equal((await kinds(tpm.id, 'batch.acked')).filter((e: any) => JSON.parse(e.payload).id === id).length, 1)
  assert.equal((await hq.state()).agents.find((a: any) => a.id === tpm.id).status, 'working') // it is working on the message, not idle
  ageBatch(id) // long after: its mod is back, and the Stop that ends the turn the message started
  assert.deepEqual(await hq.modNext(tpm.id), {}, 'not handed out a second time')
  assert.deepEqual(await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Noted.' }), {})
  assert.equal((await kinds(tpm.id, 'batch.requeued')).length, 0)
  assert.equal((await hq.state()).attention.filter((a: any) => a.kind === 'delivery_failed' && a.agent_id === tpm.id).length, 0)
})

// ---- Bug 110: after an interrupted turn (Escape in the terminal) Claude Code drops what the mod submits, so HQ types the agent's messages ----
const RULE = '─'.repeat(60)
/** Claude Code's screen after Escape stopped a turn (2.1.322): the waiting prompt, with nothing running. */
const INTERRUPTED = `⏺ Reading PROJECT.md\n  ⎿  Interrupted · What should Claude do instead?\n\n${RULE} TPM demo ─\n❯ \n${RULE}\n  ⏸ manual mode on · ? for shortcuts\n`
const WORKING = `✶ Tempering… (9s · ↓ 1.1k tokens · thinking)\n\n${RULE} TPM demo ─\n❯ \n${RULE}\n  ⏸ manual mode on · esc to interrupt\n`
const MENU = `${RULE}\n Bash command\n   rm -rf build\n Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n`
const pane = (a: any): string => hq.tmux('capture-pane', '-p', '-J', '-t', a.tmux_session)
/** Draws the agent's screen and waits until its terminal shows it (the stand-in Claude Code redraws a few times a second). */
async function draw(a: any, text: string, shows: string): Promise<void> { await hq.screen(a.id, text); await waitFor(`the screen to show "${shows}"`, () => pane(a).includes(shows)) }
/** The agent's own turn ends the way Escape ends it: the mod says so, and no Stop hook comes. */
const interrupt = (a: any) => hq.modEvent(a.id, { kind: 'turn.complete', turnId: 't', agentId: null, isAborted: true, durationMs: 9000, answer: '' })
const agentNow = async (a: any) => (await hq.state()).agents.find((x: any) => x.id === a.id)
const msgNow = async (body: string) => (await hq.state()).messages.find((x: any) => x.body === body)
/** The agent's events of one kind, oldest first. */
const payloads = async (agentId: string, kind: string) => (await kinds(agentId, kind)).map((e: any) => JSON.parse(e.payload)).reverse()
/** Waits for HQ to have typed its `n`th batch into the agent's terminal; the batch's id. */
const typed = async (a: any, n = 1): Promise<string> => (await waitFor(`typed batch ${n}`, async () => (await payloads(a.id, 'batch.typed'))[n - 1])).id

test('Bug 110: after an interrupted turn the next message is typed into the terminal, and the mod gets it again once a turn has ended normally', async () => {
  const { tpm } = await setup('interrupted')
  await takeLaunch(tpm.id); await draw(tpm, INTERRUPTED, 'Interrupted')
  await interrupt(tpm); assert.ok((await agentNow(tpm)).interrupted_at, 'HQ knows the turn was interrupted')
  await say(tpm.id, 'Typed note.\nOn two lines.')
  assert.deepEqual(await hq.modNext(tpm.id), {}, 'nothing for the mod: its prompt would be dropped')
  const id = await typed(tpm)
  await waitFor('the line in the terminal', () => pane(tpm).includes('Typed note. On two lines.')) // one line: Enter sends it
  const m = await msgNow('Typed note.\nOn two lines.'); assert.equal(m.batch_id, id); assert.equal(m.delivery_method, 'tmux'); assert.equal(m.ack_at, null)
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'Typed note. On two lines.' }) // Claude Code starts on what was typed
  assert.ok((await msgNow('Typed note.\nOn two lines.')).ack_at, 'acknowledged by the prompt')
  await say(tpm.id, 'While it works.') // the typed turn is still running: this one waits for it, typed or not
  assert.ok((await agentNow(tpm)).interrupted_at, 'still set while the turn runs')
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Noted.' }) // a turn ended normally
  assert.equal((await agentNow(tpm)).interrupted_at, null)
  const b = (await hq.modNext(tpm.id)).batch; assert.ok(b, 'the mod delivers again'); assert.match(b.text, /While it works/)
  assert.equal((await payloads(tpm.id, 'batch.typed')).length, 1)
  assert.equal((await hq.state()).attention.filter((a: any) => a.kind === 'delivery_failed' && a.agent_id === tpm.id).length, 0)
})

test('Bug 110: a message in the mod\'s hands when the turn is interrupted is typed at once, and that never counts as a failed delivery', async () => {
  const { tpm } = await setup('in-flight')
  await takeLaunch(tpm.id); await draw(tpm, INTERRUPTED, 'Interrupted')
  for (let n = 1; n <= 3; n++) { // three in ten minutes would be "Message not delivered" if they counted
    await say(tpm.id, `In flight ${n}.`)
    const b = (await hq.modNext(tpm.id)).batch; assert.match(b.text, new RegExp(`In flight ${n}`))
    await hq.modEvent(tpm.id, { kind: 'batch_received', id: b.id }) // it waits in the mod for the turn to end...
    await hq.modEvent(tpm.id, { kind: 'batch_submitted', id: b.id }); await interrupt(tpm) // ...Escape: submitted, dropped, and the turn reported as interrupted
    assert.deepEqual(await hq.modNext(tpm.id), {})
    await typed(tpm, n); await waitFor('the line in the terminal', () => pane(tpm).includes(`In flight ${n}.`))
    assert.deepEqual((await payloads(tpm.id, 'batch.requeued')).at(-1), { id: b.id, why: 'interrupted', launch: false })
    await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: `In flight ${n}.` }); assert.ok((await msgNow(`In flight ${n}.`)).ack_at)
    await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Noted.' })
  }
  assert.equal((await payloads(tpm.id, 'batch.requeued')).length, 3)
  assert.equal((await hq.state()).attention.filter((a: any) => a.kind === 'delivery_failed' && a.agent_id === tpm.id).length, 0)
})

test('Bug 110: nothing is typed into a menu, a dialog or a working session; the message goes in once the prompt is back', async () => {
  const { tpm } = await setup('not-into-a-menu')
  await takeLaunch(tpm.id); await interrupt(tpm)
  const waits = async (why: string) => {
    assert.deepEqual(await hq.modNext(tpm.id), {}); await waitFor(`HQ to hold back (${why})`, async () => (await payloads(tpm.id, 'batch.type_waits')).some((p: any) => p.why === why))
  }
  const untouched = async () => { assert.equal((await msgNow('Careful note.')).delivered_at, null); assert.ok(!pane(tpm).includes('Careful note.'), 'not typed') }
  await draw(tpm, MENU, 'Do you want to proceed?'); await say(tpm.id, 'Careful note.')
  await waits('dialog'); await untouched() // Enter there would pick "Yes"
  assert.equal((await agentNow(tpm)).type_waits, 'dialog') // the page gets the reason: its box says a menu or a question is in the way
  await draw(tpm, WORKING, 'esc to interrupt'); await waits('busy'); await untouched()
  await draw(tpm, INTERRUPTED, 'Interrupted') // the prompt is back, but HQ was told of a dialog (the notice comes about 6 s after it opens)
  await hq.hook(tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  await waits('status'); await untouched()
  await hq.hook(tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.txt' } }) // answered: it works again, then Escape
  assert.deepEqual(await hq.modNext(tpm.id), {})
  await typed(tpm); await waitFor('the line in the terminal', () => pane(tpm).includes('Careful note.'))
  assert.equal((await payloads(tpm.id, 'batch.typed')).length, 1); assert.equal((await agentNow(tpm)).type_waits, null)
})

test('Bug 110: a typed line can\'t be taken for a command: a message that starts with / or ! goes in labelled', async () => {
  const { tpm } = await setup('slash')
  await takeLaunch(tpm.id); await draw(tpm, INTERRUPTED, 'Interrupted'); await interrupt(tpm)
  await say(tpm.id, '/clear the old list, please'); assert.deepEqual(await hq.modNext(tpm.id), {})
  const id = await typed(tpm), m = await msgNow('/clear the old list, please')
  const line = `HQ message batch ${id}: [fyi] from the user [msg ${m.id}]: /clear the old list, please`
  await waitFor('the labelled line in the terminal', () => pane(tpm).includes(line))
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: line }); assert.ok((await msgNow('/clear the old list, please')).ack_at)
  await say(tpm.id, '!ls'); await say(tpm.id, 'and a second one') // still interrupted: no Stop yet. The batch starts with the first message's "!"
  assert.deepEqual(await hq.modNext(tpm.id), {})
  const id2 = await typed(tpm, 2)
  const both = new RegExp(`HQ message batch ${id2}: \\[fyi\\] from the user \\[msg [^\\]]+\\]: !ls \\[fyi\\] from the user \\[msg [^\\]]+\\]: and a second one`)
  await waitFor('both messages on one labelled line', () => both.test(pane(tpm)))
})

test('Bug 110: an interrupt outlives a backend restart, and a long message is typed whole', async () => {
  const { tpm } = await setup('restart')
  await takeLaunch(tpm.id); await draw(tpm, INTERRUPTED, 'Interrupted'); await interrupt(tpm)
  await hq.restart()
  assert.ok((await agentNow(tpm)).interrupted_at, 'still known after the restart')
  // About 800 characters, typed in four pieces. No longer: the stand-in Claude Code never reads its terminal, which then keeps only its first 1,024 bytes
  const long = `Long note. ${Array.from({ length: 24 }, (_, i) => `Sentence ${i} of the long note 🙂.`).join(' ')} The end.`
  await say(tpm.id, long); assert.deepEqual(await hq.modNext(tpm.id), {})
  await typed(tpm)
  await waitFor('the whole line in the terminal', () => pane(tpm).replace(/\n/g, '').includes(long))
})

test('Bug 110: a batch the mod submitted whose prompt never started is typed the second time; three that never start are given up', async () => {
  const { tpm } = await setup('never-started')
  await takeLaunch(tpm.id); await draw(tpm, INTERRUPTED, 'Interrupted') // HQ never heard of the interrupt (its backend was restarting, say)
  await say(tpm.id, 'Lost after Escape.')
  const b = (await hq.modNext(tpm.id)).batch; assert.match(b.text, /Lost after Escape/)
  await hq.modEvent(tpm.id, { kind: 'batch_received', id: b.id }); await hq.modEvent(tpm.id, { kind: 'batch_submitted', id: b.id }) // and no UserPromptSubmit
  ageBatch(b.id)
  assert.deepEqual(await hq.modNext(tpm.id), {}, 'not handed to the mod again: it would be dropped again')
  const second = await typed(tpm); assert.notEqual(second, b.id)
  assert.deepEqual(await payloads(tpm.id, 'batch.requeued'), [{ id: b.id, why: 'not_acked', launch: false }])
  assert.deepEqual(await payloads(tpm.id, 'agent.interrupted'), [{ why: 'not_acked', batch: b.id }]); assert.ok((await agentNow(tpm)).interrupted_at)
  ageBatch(second); assert.deepEqual(await hq.modNext(tpm.id), {}) // typed, and still no prompt: once more
  const third = await typed(tpm, 2); assert.notEqual(third, second)
  ageBatch(third); assert.deepEqual(await hq.modNext(tpm.id), {}) // the third time HQ stops and says so
  const att = await waitFor('the alert', async () => (await hq.state()).attention.find((a: any) => a.kind === 'delivery_failed' && a.agent_id === tpm.id))
  assert.match(att.detail, /3 times \(it went in but the agent never started on it\)/)
  assert.equal((await msgNow('Lost after Escape.')).delivery_method, 'failed'); assert.equal((await payloads(tpm.id, 'batch.typed')).length, 2)
})

test('only an answer answers an engineer\'s question; HQ\'s notices come from HQ', async () => {
  const { f, tpm } = await setup('questions')
  assert.equal((await hq.api('settings', { key: 'dm_per_peer_min', value: 0 })).status, 200)
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Shelf', size: 'S', spec: 'A shelf.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  const started = await waitFor('the started notice', async () => (await hq.state()).messages.find((m: any) => m.to_id === tpm.id && /started on/.test(m.body)))
  assert.equal(started.from_id, 'hq')

  const ask = await hq.mcp(eng.id, 'send_message', { to: 'tpm', reason: 'question', body: 'Wood or metal?' }); assert.equal(ask.isError, false, ask.text)
  assert.equal((await ticketOf(t)).status, 'awaiting_answer')
  assert.equal((await hq.mcp(tpm.id, 'update_ticket_spec', { key: t.key, spec: 'A wooden shelf.' })).isError, false)
  assert.equal((await ticketOf(t)).status, 'awaiting_answer') // the "spec updated" FYI is not an answer
  assert.equal((await hq.mcp(tpm.id, 'send_message', { to: eng.id, reason: 'fyi', body: 'Thinking about it.' })).isError, false)
  assert.equal((await ticketOf(t)).status, 'awaiting_answer')
  assert.equal((await hq.mcp(tpm.id, 'send_message', { to: eng.id, reason: 'answer', body: 'Wood.' })).isError, false)
  assert.notEqual((await ticketOf(t)).status, 'awaiting_answer')

  await hq.mcp(eng.id, 'send_message', { to: 'tpm', reason: 'question', body: 'Oak or pine?' })
  assert.equal((await ticketOf(t)).status, 'awaiting_answer')
  await say(eng.id, 'Pine.') // The user's reply from HQ's message box answers it
  assert.notEqual((await ticketOf(t)).status, 'awaiting_answer')
  await hq.api('settings', { key: 'dm_per_peer_min', value: 5 })
})

test('a blocker always reaches the TPM; one the hourly cap refuses goes to the user', async () => {
  const { f, tpm } = await setup('blocker-limit')
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Tests', size: 'S', spec: 'Run them.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  const send = (reason: string, body: string) => hq.mcp(eng.id, 'send_message', { to: 'tpm', reason, body })
  const refused = async () => (await hq.state()).attention.filter((a: any) => a.kind === 'dm_refused' && !a.resolved_at)
  assert.equal((await send('fyi', 'Code written.')).isError, false)
  const chatter = await send('fyi', 'Still going.') // the per-recipient window holds back chatter, quietly
  assert.equal(chatter.isError, true); assert.match(chatter.text, /one per 5 min/); assert.equal((await refused()).length, 0)
  assert.equal((await send('blocker', "Can't install pytest.")).isError, false, 'a blocker gets through the window')
  assert.equal((await send('question', 'May I use the main venv?')).isError, false, 'so does a question')
  await hq.api('settings', { key: 'dm_per_hour', value: 3 })
  const capped = await send('blocker', 'Still blocked.')
  assert.equal(capped.isError, true); assert.match(capped.text, /showed this blocker to the user/)
  const [a] = await refused(); assert.equal(a.agent_id, eng.id); assert.equal(a.ticket_id, t.id); assert.match(a.detail, /blocker to .*: Still blocked\./)
  await hq.api('settings', { key: 'dm_per_hour', value: 6 }); await hq.api(`agents/${eng.id}/stop`, {}) // frees its slot
})

test('Bug 86: the TPM\'s chat with the user doesn\'t use up its DM limits, and it can always pass on what the user said', async () => {
  const { f, tpm } = await setup('relay-user')
  await takeLaunch(tpm.id)
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Shelf', size: 'S', spec: 'A shelf.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  for (let i = 0; i < 6; i++) await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: `Here is answer ${i}.` }) // six replies
  const tell = (body: string) => hq.mcp(tpm.id, 'send_message', { to: eng.id, reason: 'fyi', body })
  try {
    assert.equal((await tell('The user wants a shelf.')).isError, false, 'passes on the request (the user\'s first message), not counted')
    assert.equal((await tell('Use oak.')).isError, false, 'six chat replies are not six DMs')
    const chatter = await tell('Also, sand it.')
    assert.equal(chatter.isError, true); assert.match(chatter.text, /one per 5 min/); assert.match(chatter.text, /nothing will remind you/)
    await say(tpm.id, 'HQ is back, please carry on.')
    assert.equal((await tell('The user says: carry on.')).isError, false, 'what the user just said gets through the window')
  } finally { await hq.api(`agents/${eng.id}/stop`, {}) } // frees its slot
})

test('engineers have no respond_to_issues tool', async () => {
  const { f } = await setup('no-respond')
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Jar', size: 'S', spec: 'A jar.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  const r = await hq.mcp(eng.id, 'respond_to_issues', { responses: [] }).catch((e) => ({ text: String(e), isError: true }))
  assert.equal(r.isError, true); assert.match(r.text, /not found/i)
})

test('a stopped agent\'s token stops working; /clear keeps a session alive; a lost engineer frees its slot', async () => {
  const { f, tpm } = await setup('lifecycle')
  await hq.api('settings', { key: 'concurrency_cap', value: 10 })
  await hq.hook(tpm.id, { hook_event_name: 'SessionEnd', reason: 'clear' })
  assert.equal((await hq.state()).agents.find((a: any) => a.id === tpm.id).status, 'working')
  assert.equal((await hq.hook(tpm.id, { hook_event_name: 'SessionStart', source: 'clear' })).error, undefined)

  const t1 = (await hq.api('tickets', { featureId: f.id, title: 'Lid', size: 'S', spec: 'A lid.' })).json
  const e1 = (await hq.api(`tickets/${t1.id}/launch`, {})).json
  await waitFor('engineer 1', async () => (await hq.state()).agents.find((a: any) => a.id === e1.id && a.status === 'working'))
  const worker = (id: string) => /export HQ_WORKER='(\d+)'/.exec(fs.readFileSync(path.join(hq.hqHome, 'agents', id, 'launch.sh'), 'utf8'))?.[1]
  const port = (id: string) => /export PORT='(\d+)'/.exec(fs.readFileSync(path.join(hq.hqHome, 'agents', id, 'launch.sh'), 'utf8'))?.[1]
  const w1 = worker(e1.id); assert.ok(w1); assert.equal(port(e1.id), String(3100 + Number(w1) * 10))
  const tok = hq.agentToken(e1.id)
  hq.tmux('kill-session', '-t', `hq-${e1.id}`) // the engineer's process dies without a SessionEnd
  await hq.restart() // recoverAgents finds it gone
  assert.equal((await hq.state()).agents.find((a: any) => a.id === e1.id).status, 'exited')
  const hook = await fetch(`http://127.0.0.1:${hq.ports.hooks}/hooks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hq-token': tok },
    body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }) })
  assert.equal(hook.status, 403)
  assert.equal((await hq.state()).agents.find((a: any) => a.id === e1.id).status, 'exited') // the late hook didn't bring it back
  assert.equal(fs.existsSync(path.join(hq.hqHome, 'agents', e1.id, 'token')), false)
  assert.equal(fs.existsSync(path.join(hq.hqHome, 'agents', e1.id, 'hook-header')), false) // Bug 87: the SessionStart hook's copy goes too

  const t2 = (await hq.api('tickets', { featureId: f.id, title: 'Cap', size: 'S', spec: 'A cap.' })).json
  const e2 = (await hq.api(`tickets/${t2.id}/launch`, {})).json
  await waitFor('engineer 2', async () => (await hq.state()).agents.find((a: any) => a.id === e2.id && a.status === 'working'))
  assert.equal(worker(e2.id), w1) // the lost engineer's slot was free again
  const tok2 = hq.agentToken(e2.id)
  await hq.api(`agents/${e2.id}/stop`, {})
  const mcp = await fetch(`http://127.0.0.1:${hq.ports.mcp}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tok2}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
  assert.equal(mcp.status, 401)
})

test('Bug 33: the TPM can retitle a ticket after a change of mind; the engineer is told', async () => {
  const { f, tpm } = await setup('retitle')
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Reports tab', size: 'S', spec: 'A new tab.' })).json
  const r = await hq.mcp(tpm.id, 'update_ticket_spec', { key: t.key, title: 'Totals line on the Home page', spec: 'A line on the Home page.' })
  assert.equal(r.isError, false, r.text)
  assert.deepEqual([(await ticketOf(t)).title, (await ticketOf(t)).spec], ['Totals line on the Home page', 'A line on the Home page.'])
  assert.equal((await hq.mcp(tpm.id, 'update_ticket_spec', { key: t.key, title: 'Only the title' })).isError, false)
  assert.equal((await ticketOf(t)).spec, 'A line on the Home page.') // a title alone keeps the spec
  assert.match((await hq.mcp(tpm.id, 'update_ticket_spec', { key: t.key })).text, /give a new spec, a new title, or both/)
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  await hq.mcp(tpm.id, 'update_ticket_spec', { key: t.key, title: 'Totals line' })
  await waitFor('the engineer to be told', async () => (await hq.state()).messages.find((m: any) => m.to_id === eng.id && /^HQ: the TPM updated .*title \(now "Totals line"\)\./.test(m.body)))
})

test('Bug 102: a spec change while a ticket has no engineer waits for the next one, and the TPM hears so', async () => {
  const { f, tpm } = await setup('spec-gone')
  const spec = (t: any, a: Record<string, string>) => hq.mcp(tpm.id, 'update_ticket_spec', { key: t.key, ...a })
  const msgs = async (to: string) => (await hq.state()).messages.filter((m: any) => m.to_id === to && m.from_id === 'hq' && /^HQ: the TPM updated/.test(m.body))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Shelf', size: 'S', spec: 'A shelf.' })).json
  assert.equal((await spec(t, { spec: 'A pine shelf.' })).text, `Updated. Nobody has started on ${t.key} yet; its engineer gets the new spec when it starts.`)
  assert.equal((await hq.state()).messages.filter((m: any) => m.feature_id === f.id && m.from_id === 'hq' && /^HQ: the TPM updated/.test(m.body)).length, 0)
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  assert.match(fs.readFileSync(path.join(hq.hqHome, 'agents', eng.id, 'prompt.md'), 'utf8'), /## Spec\nA pine shelf\./)
  assert.equal((await spec(t, { spec: 'An oak shelf.' })).text, 'Updated.') // the engineer on it now is told, as before
  const oak = await msgs(eng.id); assert.equal(oak.length, 1)
  await hq.mcp(eng.id, 'read_inbox') // it has read that one
  await hq.api(`agents/${eng.id}/stop`, {})
  await waitFor('the engineer to stop', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id).status === 'exited')
  const gone = `Updated. ${t.key}'s engineer (${eng.id}) has stopped, so nobody has read this yet: HQ tells the next engineer that starts on ${t.key}.`
  assert.equal((await spec(t, { spec: 'A walnut shelf.' })).text, gone)
  assert.equal((await spec(t, { title: 'Walnut shelf' })).text, gone)
  const waiting = (await msgs(eng.id)).filter((m: any) => !m.delivered_at); assert.equal(waiting.length, 2)
  // Resume: the engineer that takes over starts from the spec as it is now and gets both notices.
  const r = await hq.api(`tickets/${t.id}/resume`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.match(fs.readFileSync(path.join(hq.hqHome, 'agents', r.json.id, 'prompt.md'), 'utf8'), /A walnut shelf\./)
  assert.deepEqual((await msgs(r.json.id)).map((m: any) => m.id).sort(), waiting.map((m: any) => m.id).sort())
  assert.equal((await msgs(eng.id)).filter((m: any) => !m.delivered_at).length, 0, 'nothing left for the engineer that has gone')
  assert.equal((await spec(t, { spec: 'A cherry shelf.' })).text, 'Updated.') // the one on it now is told at once
  assert.equal((await msgs(r.json.id)).length, 3)
})

test('Bug 102: a relaunch over an engineer that left a question open gets its unread messages, and an answer leaves the new plan alone', async () => {
  const { f, tpm } = await setup('relaunch-question')
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Rack', size: 'S', spec: 'A rack.' })).json
  const e1 = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === e1.id && a.status === 'working'))
  assert.equal((await hq.mcp(e1.id, 'send_message', { to: 'tpm', reason: 'question', body: 'Steel or wood?' })).isError, false)
  assert.equal((await ticketOf(t)).status, 'awaiting_answer')
  await hq.api(`agents/${e1.id}/stop`, {})
  await waitFor('the engineer to stop', async () => (await hq.state()).agents.find((a: any) => a.id === e1.id).status === 'exited')
  await hq.mcp(tpm.id, 'update_ticket_spec', { key: t.key, spec: 'A steel rack.' })
  const e2 = (await hq.api(`tickets/${t.id}/launch`, {})).json; assert.ok(e2.id, JSON.stringify(e2))
  await waitFor('the new engineer', async () => (await hq.state()).agents.find((a: any) => a.id === e2.id && a.status === 'working'))
  assert.equal((await ticketOf(t)).status, 'planning')
  const left = (await hq.state()).messages.filter((m: any) => m.to_id === e1.id && !m.delivered_at); assert.equal(left.length, 0)
  assert.ok((await hq.state()).messages.some((m: any) => m.to_id === e2.id && m.from_id === 'hq' && /^HQ: the TPM updated/.test(m.body)))
  assert.equal((await hq.mcp(tpm.id, 'send_message', { to: e1.id, reason: 'answer', body: 'Steel.' })).isError, false)
  assert.equal((await ticketOf(t)).status, 'planning') // the old question's answer doesn't move the new engineer's ticket
})

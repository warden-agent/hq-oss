// Bug 135 end to end: HQ's real mod (plugin/hooks/register.js, run by modhost.ts) against a test HQ. The mod's clock is the test's
// and ticks only where a test says so: whatever reaches the agent without a tick, the mod asked for by itself.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { startHq, waitFor, type Hq } from './harness.ts'
import { startMod, type ModHost } from './modhost.ts'

let hq: Hq
const mods: ModHost[] = []
before(async () => { hq = await startHq() })
after(async () => { for (const m of mods) m.stop(); await hq?.stop() })

const say = (agentId: string, body: string) => hq.api(`agents/${agentId}/message`, { body, reason: 'fyi' })
const message = async (body: string) => (await hq.state()).messages.find((m: any) => m.body === body)
const turn = () => new Promise((r) => setImmediate(r))
/** A batch as HQ has stored it. */
const batch = (id: string): any => {
  const db = hq.db({ readOnly: true }); try { return db.prepare('SELECT * FROM batches WHERE id = ?').get(id) } finally { db.close() }
}
/** A project's TPM with the real mod. Its prompt box works as Claude Code's: a prompt goes in once the agent is idle (`busy` is
 *  over), and its UserPromptSubmit hook tells HQ it started; a hook that can't reach HQ fails, and the prompt goes in all the same.
 *  `prompts`: what has gone in so far. */
async function tpmWithMod(name: string) {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const box = { prompts: [] as string[], busy: Promise.resolve() }
  const mod = await startMod({ backend: `http://127.0.0.1:${hq.ports.hooks}`, agentId: tpm.id, tokenFile: path.join(hq.hqHome, 'agents', tpm.id, 'token'),
    submit: async (text) => { await box.busy; box.prompts.push(text); await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: text }).catch(() => {}) } })
  mods.push(mod)
  mod.tick() // the mod's first ask, which brings the launch prompt
  await waitFor('the launch prompt', () => box.prompts.length === 1)
  return { tpm, mod, box }
}

test('two messages sent back to back: the second goes in as soon as the first has, with no tick of the mod\'s clock', async () => {
  const { tpm, box } = await tpmWithMod('mod-back-to-back')
  let idle = (): void => {}; box.busy = new Promise((r) => { idle = r }) // the agent is at work
  await say(tpm.id, 'First.')
  await waitFor('the first to be handed to the mod', async () => (await message('First.'))?.delivered_at)
  await say(tpm.id, 'Second.') // stored while the first waits for the agent
  idle()
  await waitFor('both prompts', () => box.prompts.length === 3, 5000)
  assert.deepEqual(box.prompts.slice(1), ['First.', 'Second.'])
  const second = await message('Second.'); assert.equal(second.delivery_method, 'mod'); assert.ok(second.ack_at)
})

test('a message sent after the last one went in arrives with no tick', async () => {
  const { tpm, box } = await tpmWithMod('mod-after')
  for (const [i, body] of ['One.', 'Two.', 'Three.'].entries()) { await say(tpm.id, body); await waitFor(`"${body}"`, () => box.prompts.length === i + 2, 5000) }
  assert.deepEqual(box.prompts.slice(1), ['One.', 'Two.', 'Three.'])
})

test('HQ restarts under a waiting mod: one ask per tick while it is away, and the next message arrives once it is back', async () => {
  const { tpm, mod, box } = await tpmWithMod('mod-restart')
  await waitFor('the mod waiting again', () => mod.asks() === 2) // asked by itself once the launch prompt was in
  await hq.down()
  await waitFor('its request to fail', () => mod.ended() === 2); await turn(); assert.equal(mod.asks(), 2)
  mod.tick(); await waitFor('the next to fail', () => mod.ended() === 3); await turn(); assert.equal(mod.asks(), 3)
  await hq.up()
  await say(tpm.id, 'After the restart.')
  mod.tick()
  await waitFor('the message', () => box.prompts.includes('After the restart.'), 5000)
  await say(tpm.id, 'And one more.') // and it is waiting again, by itself
  await waitFor('the one after', () => box.prompts.includes('And one more.'), 5000)
})

/** Bug 140: HQ goes away while a message waits in the mod for the agent's turn to end. The turn ends, the prompt goes in with HQ away, so
 *  its UserPromptSubmit hook and the mod's "it's in" both fail. Returns the batch, once both have failed. */
async function inWhileAway(name: string) {
  const { tpm, mod, box } = await tpmWithMod(name)
  let idle = (): void => {}; box.busy = new Promise((r) => { idle = r }) // the agent is at work
  await say(tpm.id, 'Sent before the restart.')
  const id = (await waitFor('it to be handed to the mod', async () => (await message('Sent before the restart.'))?.batch_id)) as string
  await waitFor('the mod to say it got it', () => batch(id).received_at)
  await hq.down()
  const failed = mod.unanswered()
  idle() // the turn ends: the prompt goes in
  await waitFor('the prompt', () => box.prompts.includes('Sent before the restart.'))
  // the mod's "it's in", its next ask and its report that the ask failed
  await waitFor('the report and the ask after it to fail', () => mod.unanswered() === failed + 3); await turn()
  return { tpm, mod, box, id }
}

test('Bug 140: a prompt that went in while HQ was away is taken as in once HQ is back, and the next message goes at once', async () => {
  const { tpm, mod, box, id } = await inWhileAway('mod-away')
  await hq.up()
  assert.equal(batch(id).acked_at, null, 'nothing has told HQ yet')
  await say(tpm.id, 'Sent after the restart.')
  mod.tick() // the mod's clock, the one thing that wakes it while HQ is away
  await waitFor('the next message', () => box.prompts.includes('Sent after the restart.'), 5000)
  assert.deepEqual(box.prompts.slice(1), ['Sent before the restart.', 'Sent after the restart.'], 'each once')
  const b = batch(id); assert.ok(b.submitted_at && b.acked_at); assert.equal(b.dropped_at, null)
  assert.ok((await message('Sent before the restart.')).ack_at)
})

test('Bug 140: a prompt that went in while HQ was away just as the turn was interrupted is not taken as in', async () => {
  const { mod, box, id } = await inWhileAway('mod-away-esc')
  await mod.fire('turn.complete', { turnId: 't-1', isAborted: true }) // Escape: Claude Code drops the prompt (Bug 110); HQ hears of neither
  await hq.up()
  mod.tick()
  await waitFor('the mod to say it went in', () => batch(id).submitted_at, 5000)
  assert.equal(batch(id).acked_at, null, 'the "submitted but never started" rule sends it again')
  assert.equal((await message('Sent before the restart.')).ack_at, null)
  assert.deepEqual(box.prompts.slice(1), ['Sent before the restart.'])
})

test('Bug 140: a late report counts only for the hand-out it names, never for a newer batch', async () => {
  const repo = (await hq.api('repos', { path: hq.repo('mod-late-guard') })).json // no real mod here: the test sends the mod's reports
  const f = (await hq.api('features', { repoId: repo.id, title: 'guard', request: 'Build guard' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const launch = (await hq.modNext(tpm.id)).batch; await hq.modEvent(tpm.id, { kind: 'batch_received', id: launch.id })
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: launch.text })
  await say(tpm.id, 'Guarded.')
  const first = (await hq.modNext(tpm.id)).batch; assert.ok(first?.handed)
  await hq.modEvent(tpm.id, { kind: 'batch_received', id: first.id, handed: first.handed })
  await hq.modEvent(tpm.id, { kind: 'batch_submit_failed', id: first.id, handed: first.handed, error: 'boom' }) // its messages go back
  const second = (await hq.modNext(tpm.id)).batch; assert.notEqual(second.id, first.id)
  await hq.modEvent(tpm.id, { kind: 'batch_received', id: second.id, handed: second.handed })
  await hq.modEvent(tpm.id, { kind: 'batch_submitted', id: first.id, handed: first.handed, late: true }) // the old one's report, very late
  assert.equal(batch(second.id).acked_at, null); assert.equal(batch(first.id).acked_at, null)
  await hq.modEvent(tpm.id, { kind: 'batch_submitted', id: second.id, handed: second.handed - 1, late: true }) // not this hand-out
  assert.equal(batch(second.id).acked_at, null); assert.equal(batch(second.id).submitted_at, null)
  await hq.modEvent(tpm.id, { kind: 'batch_submitted', id: second.id, handed: second.handed, late: true })
  assert.ok(batch(second.id).acked_at)
})

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
/** A project's TPM with the real mod. Its prompt box works as Claude Code's: a prompt goes in once the agent is idle (`busy` is
 *  over), and its UserPromptSubmit hook tells HQ it started. `prompts`: what has gone in so far. */
async function tpmWithMod(name: string) {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const box = { prompts: [] as string[], busy: Promise.resolve() }
  const mod = await startMod({ backend: `http://127.0.0.1:${hq.ports.hooks}`, agentId: tpm.id, tokenFile: path.join(hq.hqHome, 'agents', tpm.id, 'token'),
    submit: async (text) => { await box.busy; box.prompts.push(text); await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: text }) } })
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

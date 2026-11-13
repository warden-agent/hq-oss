// Bug 99: the mod's waiting `next` request is woken by what could give its agent a batch, instead of looking every 500 ms. The
// backstop look is set to a minute here, so each of these passes only if the right thing woke the request (see src/wake.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_NEXT_BACKSTOP_MS: '60000' } }) })
after(async () => { await hq?.stop() })

const SOON = 5000 // well under the backstop: only a wake (or a deadline timer) gets there in time

async function tpmOf(name: string): Promise<any> {
  return (await project(name)).tpm
}
async function project(name: string): Promise<{ tpm: any; f: any }> {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const b = (await hq.modNext(tpm.id)).batch; assert.ok(b, 'a launch batch'); await hq.modEvent(tpm.id, { kind: 'batch_received', id: b.id })
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: b.text }) // acks the launch prompt
  return { tpm, f }
}
/** Hands out and acks whatever is waiting for the agent, till nothing is. */
async function drain(agentId: string): Promise<void> {
  for (let b = (await hq.modNext(agentId)).batch; b; b = (await hq.modNext(agentId)).batch) {
    await hq.modEvent(agentId, { kind: 'batch_received', id: b.id }); await hq.hook(agentId, { hook_event_name: 'UserPromptSubmit', prompt: b.raw ? b.text : `HQ message batch ${b.id}` })
  }
}
/** Starts a waiting `next` and returns once HQ holds it: the request stamps the agent's mod_seen_at when it starts waiting. */
async function waiting(agentId: string, wait: number): Promise<{ poll: Promise<any> }> {
  const seen = async () => (await hq.state()).agents.find((a: any) => a.id === agentId)?.mod_seen_at ?? 0
  const before = await seen(); await new Promise((r) => setTimeout(r, 5)) // a later millisecond than `before`
  const poll = hq.modNext(agentId, wait)
  await waitFor('the mod waiting', async () => (await seen()) > before)
  return { poll }
}
const say = (agentId: string, body: string, urgent = false) => hq.api(`agents/${agentId}/message`, { body, reason: 'fyi', urgent })
const timed = async (p: Promise<any>, from: number) => { const v = await p; return { v, ms: Date.now() - from } }

test('a message sent while the mod waits is handed out at once', async () => {
  const tpm = await tpmOf('wake-message')
  const { poll } = await waiting(tpm.id, 30_000)
  const t0 = Date.now(); await say(tpm.id, 'Add a shelf.')
  const { v, ms } = await timed(poll, t0)
  assert.match(v.batch?.text ?? '', /Add a shelf/); assert.ok(ms < SOON, `took ${ms} ms`)
})

test('a team message wakes the TPM waiting for it', async () => {
  const { tpm, f } = await project('wake-team')
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Shelf', size: 'S', spec: 'A shelf.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  await drain(tpm.id) // HQ's "started on" notice
  const { poll } = await waiting(tpm.id, 30_000)
  const t0 = Date.now(); assert.equal((await hq.mcp(eng.id, 'send_message', { to: 'team', reason: 'fyi', body: 'Shelf is half done.' })).isError, false)
  const { v, ms } = await timed(poll, t0)
  assert.match(v.batch?.text ?? '', /half done/); assert.ok(ms < SOON, `took ${ms} ms`)
})

test('the next batch goes as soon as the one in flight is acked', async () => {
  const tpm = await tpmOf('wake-ack')
  await say(tpm.id, 'First.')
  const b1 = (await hq.modNext(tpm.id)).batch; assert.match(b1.text, /First/); await hq.modEvent(tpm.id, { kind: 'batch_received', id: b1.id })
  await say(tpm.id, 'Second.')
  const { poll } = await waiting(tpm.id, 30_000) // held back: the first is still in flight
  const t0 = Date.now(); await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: b1.text })
  const { v, ms } = await timed(poll, t0)
  assert.match(v.batch?.text ?? '', /Second/); assert.ok(ms < SOON, `took ${ms} ms`)
})

test('a hold lifted while the mod waits lets the batch go at once', async () => {
  const tpm = await tpmOf('wake-hold')
  await hq.api(`agents/${tpm.id}/takeover`, { locked: true }); await say(tpm.id, 'Held note.')
  const { poll } = await waiting(tpm.id, 30_000)
  const t0 = Date.now(); await hq.api(`agents/${tpm.id}/takeover`, { locked: false })
  const { v, ms } = await timed(poll, t0)
  assert.match(v.batch?.text ?? '', /Held note/); assert.ok(ms < SOON, `took ${ms} ms`)
})

test('a paused role resumed while the mod waits gets its batch at once', async () => {
  const tpm = await tpmOf('wake-pause')
  assert.equal((await hq.api('settings', { key: 'paused_roles', value: ['tpm'] })).status, 200)
  try {
    await say(tpm.id, 'Paused note.')
    const { poll } = await waiting(tpm.id, 30_000)
    const t0 = Date.now(); assert.equal((await hq.api('settings', { key: 'paused_roles', value: [] })).status, 200)
    const { v, ms } = await timed(poll, t0)
    assert.match(v.batch?.text ?? '', /Paused note/); assert.ok(ms < SOON, `took ${ms} ms`)
  } finally { await hq.api('settings', { key: 'paused_roles', value: [] }) }
})

test('a batch the mod never got is handed out again when it falls due, to the request already waiting', async () => {
  const tpm = await tpmOf('wake-due')
  assert.equal((await hq.api('settings', { key: 'batch_receive_s', value: 1 })).status, 200)
  try {
    await say(tpm.id, 'Lost note.')
    const lost = (await hq.modNext(tpm.id)).batch; assert.match(lost.text, /Lost note/) // its answer never reaches the mod
    const t0 = Date.now(); const { poll } = await waiting(tpm.id, 30_000)
    const { v, ms } = await timed(poll, t0)
    assert.equal(v.batch?.text, lost.text); assert.notEqual(v.batch?.id, lost.id); assert.ok(ms < SOON, `took ${ms} ms`)
  } finally { await hq.api('settings', { key: 'batch_receive_s', value: 30 }) }
})

test('an urgent message is typed, and the waiting request does not hand it out as well', async () => {
  const tpm = await tpmOf('wake-urgent')
  const { poll } = await waiting(tpm.id, 3000)
  await say(tpm.id, 'Stop and look at this.', true)
  assert.deepEqual(await poll, {})
  const m = (await hq.state()).messages.find((x: any) => x.body === 'Stop and look at this.'); assert.equal(m.delivery_method, 'tmux'); assert.equal(m.batch_id, null)
})

test('an idle wait with nothing for the agent ends empty when its time is up', async () => {
  const tpm = await tpmOf('wake-idle')
  const t0 = Date.now(); assert.deepEqual(await hq.modNext(tpm.id, 1500), {}); assert.ok(Date.now() - t0 >= 1400)
})

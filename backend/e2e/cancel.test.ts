// Cancel end to end (see harness.ts): a cancelled ticket's engineer stops, its slot goes to the next go-ahead ticket, the TPM
// hears it from HQ and the ticket can't start again; a cancelled feature stops its TPM and every unmerged ticket.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

async function setup(name: string): Promise<{ f: any; tpm: any }> {
  const dir = hq.repo(name)
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { f, tpm }
}
const ticket = async (f: any, title: string) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
const row = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
const agent = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)

test('cancel a ticket: its engineer stops, the next go-ahead ticket starts, the TPM is told, it cannot start again', async () => {
  const { f, tpm } = await setup('cancel-ticket')
  await hq.api('settings', { key: 'concurrency_cap', value: 1 })
  const t1 = await ticket(f, 'One'), t2 = await ticket(f, 'Two')
  const e1 = (await hq.api(`tickets/${t1.id}/launch`, {})).json
  await waitFor('engineer 1', async () => (await agent(e1.id))?.status === 'working')
  await hq.api(`features/${f.id}/start-ready`, {}) // Two gets the go-ahead and waits for the slot
  assert.equal((await row(t2)).status, 'queued')

  const r = await hq.api(`tickets/${t1.id}/cancel`, {})
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json, { key: t1.key, stopped: e1.id })
  assert.equal((await row(t1)).status, 'cancelled'); assert.equal((await agent(e1.id)).status, 'exited')
  await waitFor('Two to start in the freed slot', async () => (await row(t2)).assignee_agent_id)
  const told = (await hq.state()).messages.find((m: any) => m.to_id === tpm.id && m.body.includes(`cancelled ${t1.key}`))
  assert.ok(told); assert.equal(told.from_id, 'hq')
  const again = await hq.api(`tickets/${t1.id}/launch`, {}); assert.equal(again.status, 409); assert.match(again.json.error, /is cancelled/)
  assert.equal((await hq.api(`tickets/${t1.id}/cancel`, {})).status, 200) // cancelling twice is harmless
  await hq.api('settings', { key: 'concurrency_cap', value: 10 })
})

test('cancel a feature: its engineers stop and every unmerged ticket is cancelled; the project\'s TPM stays and is told (Bug 52)', async () => {
  const { f, tpm } = await setup('cancel-feature')
  const t1 = await ticket(f, 'One'), t2 = await ticket(f, 'Two')
  const e1 = (await hq.api(`tickets/${t1.id}/launch`, {})).json
  await waitFor('engineer 1', async () => (await agent(e1.id))?.status === 'working')
  const r = await hq.api(`features/${f.id}/cancel`, {})
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.tickets.sort(), [t1.key, t2.key].sort()); assert.deepEqual(r.json.stopped, [e1.id])
  const s = await hq.state()
  assert.equal(s.features.find((x: any) => x.id === f.id).status, 'cancelled')
  for (const t of [t1, t2]) assert.equal(s.tickets.find((x: any) => x.id === t.id).status, 'cancelled')
  assert.equal(s.agents.find((a: any) => a.id === e1.id).status, 'exited'); assert.notEqual(s.agents.find((a: any) => a.id === tpm.id).status, 'exited')
  assert.ok(s.messages.some((m: any) => m.to_id === tpm.id && m.from_id === 'hq' && /The user cancelled feature F-1 "cancel-feature": T-0\d and T-0\d are cancelled/.test(m.body)))
  assert.match((await hq.api(`tickets`, { featureId: f.id, title: 'more', size: 'S', spec: 'x' })).json.error ?? '', /cancelled/)
  assert.equal((await hq.api(`features/${f.id}/start-ready`, {})).status, 400)
  assert.equal((await hq.api(`tickets/nope/cancel`, {})).status, 409)
})

test('Bug 50: the TPM removes a ticket only on the user\'s "Remove it", then rewires the ticket that waited on it', async () => {
  const { f, tpm } = await setup('remove-ticket')
  const make = async (key: string, title: string, deps: string[] = []) => {
    assert.equal((await hq.mcp(tpm.id, 'create_ticket', { key, title, size: 'S', spec: `${title}.`, depends_on: deps })).isError, false)
    return (await hq.state()).tickets.find((t: any) => t.feature_id === f.id && t.key === key)
  }
  const counter = await make('RT-1', 'Counter'), dark = await make('RT-2', 'Dark mode', ['RT-1'])
  const asks = async () => (await hq.state()).asks.filter((a: any) => a.feature_id === f.id && !a.answered_at)
  const toTpm = async (re: RegExp) => (await hq.state()).messages.filter((m: any) => m.to_id === tpm.id && re.test(m.body))

  assert.match((await hq.mcp(tpm.id, 'cancel_ticket', { key: 'RT-9', why: 'x' })).text, /no such ticket/)
  const asked = await hq.mcp(tpm.id, 'cancel_ticket', { key: 'RT-1', why: 'You said the counter isn\'t needed.' })
  assert.equal(asked.isError, false); assert.match(asked.text, /"Remove it" \/ "Keep it"/)
  assert.match((await hq.mcp(tpm.id, 'cancel_ticket', { key: 'RT-1', why: 'again' })).text, /already asking the user about removing RT-1/)
  const [ask] = await asks()
  assert.equal(ask.question, 'Remove RT-1 (Counter)? You said the counter isn\'t needed. RT-2 waits on it.')
  assert.deepEqual(JSON.parse(ask.choices), ['Remove it', 'Keep it']); assert.deepEqual(JSON.parse(ask.action), { kind: 'cancel_ticket', ticket: counter.id })

  // Nothing but the button removes it: not a message to the TPM, not a typed answer
  await hq.api(`agents/${tpm.id}/message`, { body: 'yes go ahead', reason: 'fyi' })
  assert.equal((await asks()).length, 1); assert.equal((await row(counter)).status, 'queued')
  await hq.api(`features/${f.id}/start-ready`, {}) // Start ready skips the ticket the user is being asked to remove
  assert.equal((await row(counter)).go_ahead, 0); assert.equal((await row(counter)).assignee_agent_id, null)
  const typed = await hq.api(`asks/${ask.id}/answer`, { answer: 'sure' }); assert.equal(typed.status, 409); assert.match(typed.json.error, /Choose "Remove it" or "Keep it"/)

  const r = await hq.api(`asks/${ask.id}/answer`, { answer: 'Remove it' }); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal((await row(counter)).status, 'cancelled'); assert.deepEqual(await asks(), [])
  const [told] = await toTpm(/OK'd removing RT-1/)
  assert.equal(told.from_id, 'hq')
  assert.match(told.body, /Don't assign it again\. RT-2 waited on it and can't start until you rewire it with set_dependencies \(or remove it with cancel_ticket\)\./)

  // The TPM rewires RT-2: not onto the removed ticket, itself or a loop; then it's ready
  assert.match((await hq.mcp(tpm.id, 'set_dependencies', { key: 'RT-2', depends_on: ['RT-1'] })).text, /RT-1 was removed/)
  assert.match((await hq.mcp(tpm.id, 'set_dependencies', { key: 'RT-2', depends_on: ['RT-2'] })).text, /can't wait on itself/)
  const ok = await hq.mcp(tpm.id, 'set_dependencies', { key: 'RT-2', depends_on: [] }); assert.equal(ok.isError, false); assert.equal(ok.text, 'RT-2 waits on nothing now.')
  assert.equal((await row(dark)).deps, '[]')

  // "Keep it": nothing changes and the TPM hears it
  const sound = await make('RT-3', 'Sound')
  await hq.mcp(tpm.id, 'cancel_ticket', { key: 'RT-3', why: 'Maybe not needed.' })
  const [keep] = await asks()
  assert.equal((await hq.api(`asks/${keep.id}/answer`, { answer: 'Keep it' })).status, 200)
  assert.equal((await row(sound)).status, 'queued'); assert.equal((await toTpm(/The user's answer: Keep it\. Leave RT-3 as it is\./)).length, 1)

  // A started ticket's dependencies no longer matter; a merged or removed one can't be removed
  const eng = (await hq.api(`tickets/${sound.id}/launch`, {})).json
  await waitFor('its engineer', async () => (await agent(eng.id))?.status === 'working')
  assert.match((await hq.mcp(tpm.id, 'set_dependencies', { key: 'RT-3', depends_on: ['RT-2'] })).text, /RT-3 has already started/)
  assert.match((await hq.mcp(tpm.id, 'cancel_ticket', { key: 'RT-1', why: 'x' })).text, /RT-1 is already removed/)
})

test('Bug 50: a "Remove it" works with the TPM stopped; the user\'s own ✕ tells the TPM which tickets to rewire', async () => {
  const { f, tpm } = await setup('remove-offline')
  for (const [key, deps] of [['RO-1', []], ['RO-2', ['RO-1']], ['RO-3', ['RO-1']]] as const) {
    assert.equal((await hq.mcp(tpm.id, 'create_ticket', { key, title: key, size: 'S', spec: 'x', depends_on: deps })).isError, false)
  }
  const tk = async (key: string) => (await hq.state()).tickets.find((t: any) => t.feature_id === f.id && t.key === key)
  await hq.mcp(tpm.id, 'cancel_ticket', { key: 'RO-2', why: 'Not needed.' })
  const ask = (await hq.state()).asks.find((a: any) => a.feature_id === f.id && !a.answered_at)
  await hq.api(`agents/${tpm.id}/stop`, {}); await waitFor('the TPM to stop', async () => (await agent(tpm.id)).status === 'exited')
  assert.equal((await hq.api(`asks/${ask.id}/answer`, { answer: 'Remove it' })).status, 200)
  assert.equal((await tk('RO-2')).status, 'cancelled')

  const fresh = (await hq.api(`repos/${f.repo_id}/restart-tpm`, {})).json // HQ's notices go to a running TPM (one that starts later is briefed)
  await waitFor('the new TPM', async () => (await agent(fresh.id))?.status === 'working')
  const r = await hq.api(`tickets/${(await tk('RO-1')).id}/cancel`, {}); assert.equal(r.status, 200)
  const told = (await hq.state()).messages.find((m: any) => m.to_id === fresh.id && /The user cancelled RO-1/.test(m.body))
  assert.match(told.body, /RO-3 waited on it and can't start until you rewire it/) // RO-2 is removed already: not listed
})

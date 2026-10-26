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

test('cancel a feature: its TPM and engineers stop, every unmerged ticket is cancelled', async () => {
  const { f, tpm } = await setup('cancel-feature')
  const t1 = await ticket(f, 'One'), t2 = await ticket(f, 'Two')
  const e1 = (await hq.api(`tickets/${t1.id}/launch`, {})).json
  await waitFor('engineer 1', async () => (await agent(e1.id))?.status === 'working')
  const r = await hq.api(`features/${f.id}/cancel`, {})
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.tickets.sort(), [t1.key, t2.key].sort()); assert.deepEqual(r.json.stopped.sort(), [e1.id, tpm.id].sort())
  const s = await hq.state()
  assert.equal(s.features.find((x: any) => x.id === f.id).status, 'cancelled')
  for (const t of [t1, t2]) assert.equal(s.tickets.find((x: any) => x.id === t.id).status, 'cancelled')
  for (const id of [e1.id, tpm.id]) assert.equal(s.agents.find((a: any) => a.id === id).status, 'exited')
  assert.equal((await hq.api(`features/${f.id}/start-ready`, {})).status, 400)
  assert.equal((await hq.api(`tickets/nope/cancel`, {})).status, 409)
})

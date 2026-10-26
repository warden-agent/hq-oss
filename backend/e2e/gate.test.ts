// The plan gate end to end: an approval HQ sent is not taken for a terminal-menu one, a terminal-menu approval right after
// HQ's own is still caught, and at revision_cap a plan can no longer be sent back (see harness.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, exitPlanMode, pendingAfter, type Hq } from './harness.ts'

let hq: Hq, eng: any, ticketRow: any
after(async () => { await hq?.stop() })
before(async () => {
  hq = await startHq()
  const repo = (await hq.api('repos', { path: hq.repo('gate') })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'Gate', request: 'Build it' })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  ticketRow = (await hq.api('tickets', { featureId: f.id, title: 'Box', size: 'S', spec: 'A box.' })).json
  const e = (await hq.api(`tickets/${ticketRow.id}/launch`, {})).json
  eng = await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === e.id && a.status === 'working'))
})
const openReview = () => waitFor('the open review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === ticketRow.id && r.status === 'open'))
const overrides = async () => (await hq.state()).attention.filter((a: any) => a.kind === 'user_override' && a.agent_id === eng.id).length
const postExit = () => hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: {}, tool_response: { plan: 'x' } })

test('HQ approval then PostToolUse: no override; a terminal-menu approval moments later: caught', async () => {
  const hold = hq.hook(eng.id, exitPlanMode('Plan: a box'))
  const r1 = await openReview()
  assert.equal((await hq.api(`reviews/${r1.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  assert.equal((await hold).hookSpecificOutput.decision.behavior, 'allow')
  await postExit()
  assert.equal(await overrides(), 0)

  const hold2 = hq.hook(eng.id, exitPlanMode('Plan: a bigger box')) // a new plan, held; the user picks approve in the terminal
  await openReview()
  await postExit()
  await waitFor('the override notice', async () => (await overrides()) === 1 || null)
  assert.equal((await hq.state()).tickets.find((t: any) => t.id === ticketRow.id).status, 'implementing')
  void hold2.catch(() => {})
})

test('at revision_cap the next round escalates and Revise is refused; Approve still works', async () => {
  assert.equal((await hq.api('settings', { key: 'revision_cap', value: 1 })).status, 200)
  const h1 = hq.hook(eng.id, exitPlanMode('Plan: round A'))
  const rA = await openReview()
  assert.equal((await hq.api(`reviews/${rA.id}/answer`, { verdict: 'revise', by: 'user', message: 'smaller' })).json.ok, true)
  assert.equal((await h1).hookSpecificOutput.decision.behavior, 'deny')

  const h2 = hq.hook(eng.id, exitPlanMode('Plan: round B'))
  const rB = await openReview()
  assert.equal(rB.revises_used, 1)
  const s = await hq.state()
  assert.equal(s.tickets.find((t: any) => t.id === ticketRow.id).status, 'escalated')
  assert.ok(s.attention.find((a: any) => a.kind === 'cap_reached' && a.agent_id === eng.id))
  const no = (await hq.api(`reviews/${rB.id}/answer`, { verdict: 'revise', by: 'user', message: 'again' })).json
  assert.equal(no.ok, false); assert.match(no.error, /revision cap reached/)
  assert.equal(await pendingAfter(h2, 200), true) // the engineer still waits
  assert.equal((await hq.api(`reviews/${rB.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  assert.equal((await h2).hookSpecificOutput.decision.behavior, 'allow')
  await waitFor('the cap notice cleared', async () => !(await hq.state()).attention.some((a: any) => a.kind === 'cap_reached') || null)
})

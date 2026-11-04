// Sending a plan back (Bugs 35, 36), end to end with fake agents (see harness.ts): the TPM hears the user's own words, so a fresh
// TPM doesn't ask again for something the user already asked for; the engineer is told to update its plain-words summary.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

test('Bugs 35/36: the user\'s revise note reaches the TPM; the engineer is asked to rewrite "In plain words"', async () => {
  const repo = (await hq.api('repos', { path: hq.repo('revise') })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'Archive', request: 'tidy the list' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Archive button', size: 'S', spec: 'A button.' })).json
  const e = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === e.id && a.status === 'working'))
  const held = hq.hook(e.id, exitPlanMode('## In plain words\nAn Archive button.\n\n## Plan\n1. Button.'))
  const rv = await waitFor('the review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open'))
  // what the UI sends for Revise (board.ts answerReview)
  const note = 'can the message have an Undo button that puts it back?'
  const message = `Plan not approved (round 1). Blocking issues: ${note} Address them, update the "In plain words" summary so it says what changed, then call ExitPlanMode again.`
  assert.equal((await hq.api(`reviews/${rv.id}/answer`, { verdict: 'revise', message, note, by: 'user' })).json.ok, true)
  const denied = await held
  assert.match(denied.hookSpecificOutput.decision.message, /update the "In plain words" summary/)
  const m = await waitFor('the TPM told', async () => (await hq.state()).messages.find((x: any) => x.to_id === tpm.id && x.from_id === 'hq' && /sent T-01's plan back/.test(x.body)))
  assert.equal(m.body, `HQ: the user sent T-01's plan back (round 1) with: "${note}". The engineer is revising it. `
    + 'If this changes what the ticket builds, keep its spec and title in step (update_ticket_spec).')
  // an approval tells the TPM nothing new
  const held2 = hq.hook(e.id, exitPlanMode('## In plain words\nAn Archive button with Undo.\n\n## Plan\n1. Button. 2. Undo.'))
  const rv2 = await waitFor('round 2', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open' && r.id !== rv.id))
  await hq.api(`reviews/${rv2.id}/answer`, { verdict: 'approve', by: 'user' }); await held2
  assert.equal((await hq.state()).messages.filter((x: any) => x.to_id === tpm.id && /plan back/.test(x.body)).length, 1)
})

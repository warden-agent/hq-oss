// Bug 371: with auto mode off, a change to a started ticket's spec or criteria after its plan was handed in goes back to a new plan the user approves
// before the engineer builds on. The engineer is told so with the change, open_pr is refused until then, the old plan handed in again is a new round
// (not taken back as approved), and a fresh engineer on the ticket starts in plan mode. Not for a new title alone, nor with the switch
// (replan_on_change) off: then the engineer builds the change on the plan approved before, as HQ did until Bug 371.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, exitPlanMode, sh, type Hq } from './harness.ts'

let hq: Hq, f: any, tpm: any
after(async () => { await hq?.stop() })
before(async () => {
  hq = await startHq()
  assert.equal((await hq.api('settings', { key: 'concurrency_cap', value: 8 })).status, 200) // an engineer per test, each left running
  const repo = (await hq.api('repos', { path: hq.repo('b371replan') })).json
  f = (await hq.api('features', { repoId: repo.id, title: 'Shelves', request: 'Build shelves' })).json
  tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
})
const ticketOf = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
const openReview = (t: any, round: number) => waitFor(`round ${round}'s review`, async () =>
  (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open' && r.round === round))
const notices = async (to: string) => (await hq.state()).messages.filter((m: any) => m.to_id === to && m.from_id === 'hq' && /^HQ: the TPM updated/.test(m.body))
const change = (t: any, a: Record<string, unknown>) => hq.mcp(tpm.id, 'update_ticket_spec', { key: t.key, ...a, user_asked: true }) // the user's change of mind
const NO_REPEAT = " Don't message the engineer about this change yourself: HQ's notice tells it what changed and what to do." // Bug 406
const CRIT = [{ kind: 'backend', text: 'A saved shelf is listed with its wood' }]
const ASK = /Auto mode is off, so the user approves how a change to a started ticket is built: don't build it on the plan approved before\. Call EnterPlanMode/
const REFUSED = /spec or criteria changed after its plan was handed in, and with auto mode off the user approves a new plan before the change is built\./

/** A ticket whose engineer's first plan the user approved: it is building. */
async function building(title: string): Promise<{ t: any; eng: any }> {
  const t = (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `A ${title.toLowerCase()}.`, criteria: CRIT })).json
  const e = (await hq.api(`tickets/${t.id}/launch`, {})).json
  const eng = await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === e.id && a.status === 'working'))
  const hold = hq.hook(eng.id, exitPlanMode(`Plan: a ${title.toLowerCase()}`))
  const r1 = await openReview(t, 1)
  assert.equal((await hq.api(`reviews/${r1.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  assert.equal((await hold).hookSpecificOutput.decision.behavior, 'allow')
  await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: {}, tool_response: { plan: 'x' } })
  assert.equal((await ticketOf(t)).status, 'implementing')
  return { t, eng }
}
const openPr = async (eng: any) => {
  await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  return hq.mcp(eng.id, 'open_pr', { title: 'Shelf', body: '## Deviations from approved plan\nNone.', tests: [{ criterion: 'A1', cant_test: 'a test of this' }] })
}

test('auto off: a changed spec asks for a new plan; open_pr waits for it; the old plan again is a new round; the approved new one settles it', async () => {
  const { t, eng } = await building('Shelf')
  const r = await change(t, { spec: 'An oak shelf.' })
  assert.equal(r.isError, false, r.text)
  assert.equal(r.text, `Updated. HQ has told ${t.key}'s engineer (${eng.id}). Auto mode is off, so ${t.key}'s engineer shows the user a new plan for the change`
    + ` before it builds on; they approve it like the first.${NO_REPEAT}`) // Bug 406: and the TPM is told not to send its own message on top
  assert.equal((await ticketOf(t)).replan_after, 1)
  const told = await waitFor('the notice', async () => { const m = await notices(eng.id); return m.length ? m : null })
  assert.equal(told.length, 1); assert.match(told[0].body, new RegExp(`^HQ: the TPM updated ${t.key}'s spec\\. Call get_ticket to read it\\. ${ASK.source}`))
  assert.match((await hq.mcp(eng.id, 'get_ticket')).text, /\nA new plan is owed: Auto mode is off/) // a lost notice: get_ticket says it too
  const tab = (await hq.api(`agents/${eng.id}/events`)).json.events.map((e: any) => e.text) // its Events tab says what HQ asked
  assert.ok(tab.some((x: string) => /^HQ asked for a new plan for T-\d+: its spec changed after its plan was handed in, so you approve it first$/.test(x)), tab.join('\n'))

  const pr = await openPr(eng)
  assert.equal(pr.isError, true); assert.match(pr.text, REFUSED); assert.equal((await ticketOf(t)).status, 'implementing')

  // It reads the change at its next step (Bug 370), then hands in the plan approved before, unchanged: a new round for the user, not "approved already"
  await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} })
  const same = hq.hook(eng.id, exitPlanMode('Plan: a shelf'))
  const r2 = await openReview(t, 2)
  assert.equal((await ticketOf(t)).status, 'plan_review')
  // A send-back doesn't settle it…
  assert.equal((await hq.api(`reviews/${r2.id}/answer`, { verdict: 'revise', by: 'user', message: 'say oak' })).json.ok, true)
  assert.equal((await same).hookSpecificOutput.decision.behavior, 'deny')
  assert.equal((await ticketOf(t)).replan_after, 1)
  // …approving the new plan does
  const hold = hq.hook(eng.id, exitPlanMode('Plan: an oak shelf'))
  const r3 = await openReview(t, 3)
  assert.equal((await hq.api(`reviews/${r3.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  assert.equal((await hold).hookSpecificOutput.decision.behavior, 'allow')
  assert.equal((await ticketOf(t)).replan_after, null)
  assert.doesNotMatch((await hq.mcp(eng.id, 'get_ticket')).text, /A new plan is owed/)
  const after = await openPr(eng)
  assert.doesNotMatch(after.text, REFUSED) // refused now, if at all, for something else (no commits in this test)
})

// Bug 387: the user answers plans on the board and HQ sent the TPM nothing about them, so after the re-plan it told the user "I haven't seen a plan from the
// engineer". list_tickets shows each ticket's rounds, and the "finished" notice lists them.
test('Bug 387: the TPM reads the plan rounds in list_tickets and in the finished notice: the first plan, the one owed after the change, the new one', async () => {
  const { t, eng } = await building('Desk')
  const plans = async () => JSON.parse((await hq.mcp(tpm.id, 'list_tickets')).text).flatMap((x: any) => x.tickets).find((x: any) => x.key === t.key).plans
  assert.equal(await plans(), 'R-1 approved by the user')
  await change(t, { spec: 'An oak desk.' })
  assert.equal(await plans(), 'R-1 approved by the user; a new plan is owed: the spec changed, and R-1 came before its engineer read the change')
  await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} }) // it reads the change at a step (Bug 370), then plans
  const hold = hq.hook(eng.id, exitPlanMode('Plan: an oak desk'))
  assert.equal(await waitFor('round 2 in list_tickets', async () => /R-2 waits/.test(await plans()) && await plans()), "R-1 approved by the user; R-2 waits for the user's review")
  assert.equal((await hq.api(`reviews/${(await openReview(t, 2)).id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  assert.equal((await hold).hookSpecificOutput.decision.behavior, 'allow')
  assert.equal(await plans(), 'R-1 approved by the user; R-2 approved by the user')
  const wt = (await ticketOf(t)).worktree_path
  fs.writeFileSync(path.join(wt, 'desk.txt'), 'oak\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'oak desk')
  await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const pr = await hq.mcp(eng.id, 'open_pr', { title: 'Desk', body: '## Deviations from approved plan\nNone.',
    tests: [{ criterion: 'A1', cant_test: 'This project has no test runner yet, so nothing can run a test of the saved shelf here.' }] })
  assert.equal(pr.isError, false, pr.text)
  const done = await waitFor('the finished notice', async () => (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === tpm.id
    && m.body.startsWith(`HQ: ${t.key} is finished`)))
  assert.match(done.body, /you'll be told when it merges\. Its plans: R-1 approved by the user; R-2 approved by the user\.$/)
})

// Bug 394 follow-up: a change to a finished ticket is built with no new plan (the owner's call), and the TPM read only "R-1 approved by the user", as if that
// plan covered the change: it told the user the plan was approved. The words now say the ticket changed after it, and how many times.
test('Bug 394 follow-up: a finished ticket changed and built again: list_tickets and the finished notice say R-1 does not cover the change', async () => {
  const { t, eng } = await building('Cabinet')
  const plans = async () => JSON.parse((await hq.mcp(tpm.id, 'list_tickets')).text).flatMap((x: any) => x.tickets).find((x: any) => x.key === t.key).plans
  const wt = (await ticketOf(t)).worktree_path
  const finish = async (text: string) => {
    fs.writeFileSync(path.join(wt, 'cabinet.txt'), text); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', text.trim())
    await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
    const pr = await hq.mcp(eng.id, 'open_pr', { title: 'Cabinet', body: '## Deviations from approved plan\nNone.',
      tests: [{ criterion: 'A1', cant_test: 'This project has no test runner yet, so nothing can run a test of the saved shelf here.' }] })
    assert.equal(pr.isError, false, pr.text)
  }
  const finished = (start: string) => waitFor(`"${start}"`, async () => (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === tpm.id
    && m.body.startsWith(start)))
  await finish('pine\n')
  assert.match((await finished(`HQ: ${t.key} is finished`)).body, /Its plans: R-1 approved by the user\.$/)
  const once = 'R-1 approved by the user; then the ticket was changed after it was finished, with no new plan for the change: R-1 doesn\'t cover it'
  assert.equal((await change(t, { spec: 'An oak cabinet.' })).isError, false)
  assert.equal((await ticketOf(t)).status, 'resolving')
  assert.equal(await plans(), once) // while its engineer builds it
  await finish('oak\n')
  const built = await finished(`HQ: ${t.key}'s engineer built the change`), branch = (await ticketOf(t)).branch
  assert.equal(built.body, `HQ: ${t.key}'s engineer built the change to its spec (${branch}). The user merges it from HQ; you'll be told when it merges. Its plans: ${once}.`)
  assert.equal((await change(t, { spec: 'An oak cabinet with two doors.' })).isError, false)
  assert.equal(await plans(), 'R-1 approved by the user; then the ticket was changed 2 times after it was finished, with no new plan for the changes: R-1 doesn\'t cover them')
  const db = hq.db({ readOnly: true }) // kept past the event log's clean-up: the TPM reads it for as long as the ticket lasts
  try {
    const rows = db.prepare("SELECT pinned, json_extract(payload, '$.round') AS round FROM events WHERE kind = 'ticket.change' AND json_extract(payload, '$.ticket') = ?").all(t.id)
    assert.deepEqual(rows.map((r: any) => [r.pinned, r.round]), [[1, 1], [1, 1]])
  } finally { db.close() }
})

test('new criteria ask for a new plan too; a new title alone does not', async () => {
  const { t, eng } = await building('Rack')
  assert.equal((await change(t, { title: 'Steel rack' })).text, `Updated. HQ has told ${t.key}'s engineer (${eng.id}).${NO_REPEAT}`)
  assert.equal((await ticketOf(t)).replan_after, null)
  const r = await change(t, { criteria: [{ id: 'A1', ...CRIT[0] }, { id: 'A2', kind: 'backend', text: 'A rack holds at most ten shelves' }] })
  assert.equal(r.isError, false, r.text); assert.match(r.text, /shows the user a new plan/)
  assert.equal((await ticketOf(t)).replan_after, 1)
  const m = await waitFor('the notice', async () => (await notices(eng.id)).find((x: any) => /acceptance criteria/.test(x.body)))
  assert.match(m.body, ASK)
})

test('the engineer that takes over a ticket that owes a new plan starts in plan mode and is told why', async () => {
  const { t, eng } = await building('Bench')
  await hq.api(`agents/${eng.id}/stop`, {})
  await waitFor('the engineer to stop', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id).status === 'exited')
  const r = await change(t, { spec: 'A pine bench.' })
  assert.match(r.text, /has stopped, so nobody has read this yet: HQ tells the next engineer that starts on T-\d+\. Auto mode is off, so .* new plan/)
  const next = await hq.api(`tickets/${t.id}/resume`, {}); assert.equal(next.status, 200, JSON.stringify(next.json))
  const a = await waitFor('the new engineer', async () => (await hq.state()).agents.find((x: any) => x.id === next.json.id && x.status === 'working'))
  assert.equal(a.in_plan_mode, 1)
  const prompt = fs.readFileSync(path.join(hq.hqHome, 'agents', a.id, 'prompt.md'), 'utf8')
  assert.match(prompt, /Its spec or criteria changed after its plan was handed in.* You start in plan mode/)
  assert.match(prompt, /## The plan approved before the change\nPlan: a bench/)
  assert.match(prompt, /## Spec\nA pine bench\./)
})

test('with the switch off (the other choice), the engineer builds the change on its approved plan, as before', async () => {
  assert.equal((await hq.api('settings', { key: 'replan_on_change', value: 'off' })).status, 200)
  try {
    const { t, eng } = await building('Stool')
    assert.equal((await change(t, { spec: 'A tall stool.' })).text, `Updated. HQ has told ${t.key}'s engineer (${eng.id}).${NO_REPEAT}`)
    assert.equal((await ticketOf(t)).replan_after, null)
    const m = await waitFor('the notice', async () => { const x = await notices(eng.id); return x.length ? x : null })
    assert.deepEqual(m.map((x: any) => x.body), [`HQ: the TPM updated ${t.key}'s spec. Call get_ticket to read it.`])
    assert.doesNotMatch((await openPr(eng)).text, REFUSED)
  } finally { await hq.api('settings', { key: 'replan_on_change', value: 'on' }) }
})

/** Bug 371 follow-up: a stand-in for the engineer's Claude Code transcript. Each tool call is a line with the id of the model response it came in. */
function transcript(eng: any): { file: string; response: (id: string, tools: [string, string][]) => void } {
  const file = path.join(hq.hqHome, `b371r-${eng.id}.jsonl`); fs.writeFileSync(file, '')
  return { file, response: (id, tools) => { for (const [name, use] of tools) fs.appendFileSync(file, `${JSON.stringify({ type: 'assistant', message: { id, role: 'assistant',
    content: [{ type: 'tool_use', id: use, name, input: {} }] } })}\n`) } }
}
const planIn = (eng: any, file: string, plan: string) => hq.hook(eng.id, { ...exitPlanMode(plan), transcript_path: file })
const step = (eng: any, tool: string, use: string) => hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: {}, tool_use_id: use })

test('Bug 371 follow-up: the plan handed in by the same response whose step brought the change in is no new plan; one from a later response is', async () => {
  const { t, eng } = await building('Lamp')
  const tr = transcript(eng)
  assert.equal((await change(t, { spec: 'A brass lamp.' })).isError, false)
  assert.equal((await ticketOf(t)).replan_after, 1)
  // One response: write the plan file, then ExitPlanMode. The Write's step brings the notice in; ExitPlanMode was already decided (T-02's R-3, live)
  tr.response('msg_b371r_A', [['Write', 'toolu_b371r_W1'], ['ExitPlanMode', 'toolu_b371r_E1']])
  const carried = await step(eng, 'Write', 'toolu_b371r_W1')
  assert.match(carried.hookSpecificOutput?.additionalContext ?? '', /HQ: the TPM updated T-\d+'s spec\./)
  const early = planIn(eng, tr.file, 'Plan: a lamp, as before')
  const r2 = await openReview(t, 2)
  assert.equal((await ticketOf(t)).replan_after, 2, 'written before it read the change: the plan owed moves past it')
  const tab = (await hq.api(`agents/${eng.id}/events`)).json.events.map((e: any) => e.text)
  assert.ok(tab.includes('Its plan (round 2) was written before it read the change to its spec: approving it still leaves a new plan to come'), tab.join('\n'))
  assert.equal((await hq.api(`reviews/${r2.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  assert.equal((await early).hookSpecificOutput.decision.behavior, 'allow')
  assert.equal((await ticketOf(t)).replan_after, 2, 'approving it settles nothing')
  assert.match((await openPr(eng)).text, REFUSED)
  // Its next response, after reading the notice: EnterPlanMode, a new plan, ExitPlanMode. That one is the new plan
  tr.response('msg_b371r_B', [['EnterPlanMode', 'toolu_b371r_P2']]); tr.response('msg_b371r_C', [['Write', 'toolu_b371r_W3'], ['ExitPlanMode', 'toolu_b371r_E3']])
  const fresh = planIn(eng, tr.file, 'Plan: a brass lamp')
  const r3 = await openReview(t, 3)
  assert.equal((await ticketOf(t)).replan_after, 2)
  assert.equal((await hq.api(`reviews/${r3.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  assert.equal((await fresh).hookSpecificOutput.decision.behavior, 'allow')
  assert.equal((await ticketOf(t)).replan_after, null)
  assert.doesNotMatch((await openPr(eng)).text, REFUSED)
})

test('Bug 371 follow-up: a plan handed in while the change notice is still unread is no new plan either', async () => {
  const { t, eng } = await building('Desk')
  const tr = transcript(eng)
  assert.equal((await change(t, { spec: 'A standing desk.' })).isError, false)
  tr.response('msg_b371r_D', [['ExitPlanMode', 'toolu_b371r_E4']])
  const early = planIn(eng, tr.file, 'Plan: a desk, written before')
  const r2 = await openReview(t, 2)
  assert.equal((await ticketOf(t)).replan_after, 2)
  assert.equal((await hq.api(`reviews/${r2.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  assert.equal((await early).hookSpecificOutput.decision.behavior, 'allow')
  const after = await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: {}, tool_response: { plan: 'x' }, tool_use_id: 'toolu_b371r_E4' })
  assert.match(after.hookSpecificOutput?.additionalContext ?? '', /HQ: the TPM updated T-\d+'s spec\./) // the approval's step brings it in
  assert.equal((await ticketOf(t)).replan_after, 2)
  tr.response('msg_b371r_F', [['EnterPlanMode', 'toolu_b371r_P5']]); tr.response('msg_b371r_G', [['ExitPlanMode', 'toolu_b371r_E5']])
  const fresh = planIn(eng, tr.file, 'Plan: a standing desk')
  const r3 = await openReview(t, 3)
  assert.equal((await hq.api(`reviews/${r3.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  assert.equal((await fresh).hookSpecificOutput.decision.behavior, 'allow')
  assert.equal((await ticketOf(t)).replan_after, null)
})

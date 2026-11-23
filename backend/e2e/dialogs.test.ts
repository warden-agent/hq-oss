// Bug 62, the part that ships whatever the spike finds: the Notification types HQ acts on are matched by their exact names (2.1.300), and a dialog alert goes with its
// session, because a session that's over has no dialog.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, exitPlanMode, type Hq } from './harness.ts'
import { agentPill, liveActivity, menuActivity } from '../../frontend/src/api.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_STUCK_TICK_S: '1' } }) })
after(async () => { await hq?.stop() })
let n = 0
async function tpm(): Promise<any> {
  const repo = (await hq.api('repos', { path: hq.repo(`d${++n}`) })).json, a = (await hq.api(`repos/${repo.id}/message`, { body: 'hello' })).json.agent
  return waitFor('the TPM', async () => (await hq.state()).agents.find((x: any) => x.id === a.id && x.status === 'working'))
}
const note = (a: any, type: string, message = 'Allow this?') => hq.hook(a.id, { hook_event_name: 'Notification', notification_type: type, message })
const now = async (a: any) => (await hq.state()).agents.find((x: any) => x.id === a.id)
const open = async (a: any, kind = 'dialog') => (await hq.state()).attention.find((x: any) => x.kind === kind && x.agent_id === a.id && !x.resolved_at)

test('Bug 62: a dialog that ended raises nothing; each type that opens one still does', async () => {
  const a = await tpm()
  for (const type of ['elicitation_response', 'elicitation_complete', 'idle_prompt', 'auth_success']) {
    await note(a, type); assert.equal((await now(a)).status, 'working', type); assert.equal(await open(a), undefined, type)
  }
  for (const type of ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'worker_permission_prompt']) {
    await note(a, type, `waiting: ${type}`); assert.deepEqual([(await now(a)).status, (await now(a)).blocked_why], ['blocked', 'dialog'], type)
    assert.match((await open(a))?.detail ?? '', new RegExp(type), type)
  }
  await note(a, 'permission_prompt', 'Claude Code needs your approval for the plan'); assert.doesNotMatch((await open(a)).detail, /approval for the plan/) // the plan gate isn't a dialog
})

// Bug 179: the Agents menu read the hooks' last activity line, so an agent on a dialog still said "Thinking". It says it waits on a dialog, as its box does,
// and its activity line comes back once it works again. The menu's words come from the page's own helpers, over the state HQ sends the page.
test('Bug 179: on a dialog the Agents menu says so, not "Thinking"; working again, it shows what the agent does', async () => {
  const a = await tpm(), menu = async () => { const s = await hq.state(), x = s.agents.find((y: any) => y.id === a.id); return [x.status, menuActivity(x, s), liveActivity(x)] }
  await hq.hook(a.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go on' })
  assert.deepEqual(await menu(), ['working', 'Thinking', 'Thinking'])
  await note(a, 'permission_prompt', 'Claude needs your permission to use Bash')
  assert.deepEqual(await menu(), ['blocked', 'waiting on a dialog in its terminal', null], 'no box line either')
  assert.equal((await now(a)).activity, 'Thinking', 'kept for when it works again')
  await hq.hook(a.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'b179' })
  assert.deepEqual(await menu(), ['working', 'Running: npm test', 'Running: npm test'])
  await note(a, 'elicitation_dialog', 'Pick one'); assert.equal((await menu())[1], 'waiting on a dialog in its terminal')
  await hq.hook(a.id, { hook_event_name: 'UserPromptSubmit', prompt: 'answered' }); assert.deepEqual(await menu(), ['working', 'Thinking', 'Thinking'])
  // what it must not catch: an API error is no dialog (and has no activity line), a usage pause says nothing under its "paused" pill, idle shows its line
  await hq.hook(a.id, { hook_event_name: 'StopFailure', error: 'overloaded' }); assert.deepEqual(await menu(), ['blocked', null, null])
  await hq.hook(a.id, { hook_event_name: 'UserPromptSubmit', prompt: 'again' }); await note(a, 'quota_auto_resume_stale', 'Press enter to continue')
  assert.deepEqual(await menu(), ['paused', null, null])
  assert.equal(menuActivity({ id: 'x', role: 'engineer', status: 'idle', activity: 'Subagent: tests' }, await hq.state()), 'Subagent: tests')
})

// Bug 216: an engineer held at the plan gate read `plan_review` on its pill and "Thinking" (its last activity line) in the Agents menu, while its box said
// "Plan R-1 waiting for you". The menu now says what the box says, and its pill reads as its ticket's does.
test('Bug 216: at the plan gate the Agents menu says whom the plan waits on, not `plan_review` and "Thinking"; approved, it shows what it does', async () => {
  const repo = (await hq.api('repos', { path: hq.repo(`p${++n}`) })).json, f = (await hq.api('features', { repoId: repo.id, title: 'Plan', request: 'Build it' })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((x: any) => x.id === f.tpm_agent_id && x.status === 'working'))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Box', size: 'S', spec: 'A box.' })).json, e = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await now(e))?.status === 'working' || null)
  const view = async () => { const s = await hq.state(), x = s.agents.find((y: any) => y.id === e.id); return [x.status, agentPill(x, s), menuActivity(x, s), liveActivity(x)] }
  await hq.hook(e.id, { hook_event_name: 'UserPromptSubmit', prompt: 'plan it' })
  assert.deepEqual(await view(), ['working', 'working', 'Thinking', 'Thinking'])
  const hold = hq.hook(e.id, exitPlanMode('Plan: a box'))
  const r = await waitFor('the open review', async () => (await hq.state()).reviews.find((x: any) => x.ticket_id === t.id && x.status === 'open'))
  await waitFor('held at the gate', async () => (await now(e)).status === 'plan_review' || null)
  assert.deepEqual(await view(), ['plan_review', 'plan for you', 'Plan R-1 waiting for you', null])
  assert.equal((await now(e)).activity, 'Thinking', 'kept for when it works again')
  assert.equal((await hq.api(`reviews/${r.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  assert.equal((await hold).hookSpecificOutput.decision.behavior, 'allow')
  await waitFor('working again', async () => (await now(e)).status === 'working' || null)
  await hq.hook(e.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'b216' })
  assert.deepEqual(await view(), ['working', 'working', 'Running: npm test', 'Running: npm test'])
})

// Bug 234: a plan sent back leaves its engineer at the gate (`plan_review`) until its next step. In that gap the menu said "plan for you" and its box
// "waiting for your review", though nobody was asked anything. Over the state HQ really sends the page after a send-back.
test('Bug 234: a plan sent back, its engineer not moved on yet: the menu says it is revising, not that it waits for a review', async () => {
  const repo = (await hq.api('repos', { path: hq.repo(`p${++n}`) })).json, f = (await hq.api('features', { repoId: repo.id, title: 'Plan', request: 'Build it' })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((x: any) => x.id === f.tpm_agent_id && x.status === 'working'))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Box', size: 'S', spec: 'A box.' })).json, e = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await now(e))?.status === 'working' || null)
  const view = async () => { const s = await hq.state(), x = s.agents.find((y: any) => y.id === e.id); return [x.status, agentPill(x, s), menuActivity(x, s)] }
  const hold = hq.hook(e.id, exitPlanMode('Plan: a box, round one'))
  const r = await waitFor('the open review', async () => (await hq.state()).reviews.find((x: any) => x.ticket_id === t.id && x.status === 'open'))
  await waitFor('held at the gate', async () => (await now(e)).status === 'plan_review' || null)
  assert.deepEqual(await view(), ['plan_review', 'plan for you', 'Plan R-1 waiting for you']) // the normal manual review, as before
  assert.equal((await hq.api(`reviews/${r.id}/answer`, { verdict: 'revise', message: 'Smaller box', by: 'user' })).json.ok, true)
  assert.equal((await hold).hookSpecificOutput.decision.behavior, 'deny')
  assert.deepEqual(await view(), ['plan_review', 'revising plan', 'its plan was sent back · it is revising it'])
  await hq.hook(e.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' }, tool_use_id: 'r234' }) // its next step
  assert.deepEqual(await view(), ['working', 'working', 'Reading x'])
})

test('Bug 62: "Claude is continuing your task" doesn\'t pause it, and ends a usage wait', async () => {
  const a = await tpm()
  await note(a, 'quota_auto_resume_stale', 'Press enter to continue')
  assert.equal((await now(a)).status, 'paused'); assert.equal((await now(a)).paused_reason, 'quota_auto_resume_stale')
  assert.equal((await open(a, 'usage_limit')).detail.includes('quota_auto_resume'), false, 'the raw type name isn\'t for people')
  await note(a, 'quota_auto_resume_fired', 'Claude is continuing your task')
  assert.equal((await now(a)).status, 'working'); assert.equal((await now(a)).paused_reason, null); assert.equal(await open(a, 'usage_limit'), undefined)
})

test('a usage wait also ends with the next turn: the reason and the notice go', async () => {
  const a = await tpm()
  await note(a, 'quota_auto_resume_disabled', 'Usage limit reached'); assert.equal((await now(a)).status, 'paused')
  await hq.hook(a.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go on' })
  assert.equal((await now(a)).status, 'working'); assert.equal((await now(a)).paused_reason, null); assert.equal(await open(a, 'usage_limit'), undefined)
})

test('Bug 62: a session that\'s over has no dialog: stopped, ended or lost, its alert goes; a /clear goes on, and so does its alert', async () => {
  const stopped = await tpm(), ended = await tpm(), cleared = await tpm(), lost = await tpm()
  for (const a of [stopped, ended, cleared, lost]) { await note(a, 'permission_prompt'); assert.ok(await open(a)) }
  await hq.api(`agents/${stopped.id}/stop`, {}); assert.equal(await open(stopped), undefined)
  await hq.hook(cleared.id, { hook_event_name: 'SessionEnd', reason: 'clear' }); assert.ok(await open(cleared))
  await hq.hook(ended.id, { hook_event_name: 'SessionEnd', reason: 'logout' }); assert.equal(await open(ended), undefined)
  hq.tmux('kill-session', '-t', lost.tmux_session)
  await waitFor('the lost one', async () => (await now(lost)).status === 'exited', 8000); assert.equal(await open(lost), undefined)
})

// The automatic clear (presence.ts): positive evidence only, two looks a minute apart (a second here). The fake's status file is what Claude Code keeps in ~/.claude/sessions.
const MENU = '\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n'
test('Bug 62: a dialog answered with no hook clears itself after two looks, and the agent goes back to what its status file says', async () => {
  const idle = await tpm(), busy = await tpm()
  for (const a of [idle, busy]) { await hq.session(a.id, 'waiting'); await note(a, 'permission_prompt'); assert.equal((await now(a)).status, 'blocked') }
  // Written again, after the alert: from here only the word "waiting" keeps the notice, not a file older than it (which the next test is about).
  // Without this the check below passed with the "waiting" rule taken out of HQ.
  await hq.session(idle.id, 'waiting')
  await hq.beats('stuck', 3); assert.ok(await open(idle), 'still waiting: it stays') // HQ has looked again and again (denied, say: no hook comes)
  await hq.session(idle.id, 'idle'); await hq.session(busy.id, 'busy')
  await waitFor('both to clear', async () => !(await open(idle)) && !(await open(busy)), 6000)
  assert.equal((await now(idle)).status, 'idle'); assert.equal((await now(busy)).status, 'working')
  // Bug 155: only this test's two agents' events. An earlier test's agent can be cleared late under load, and that clear is not this test's.
  for (const a of [idle, busy]) {
    const ev = ((await hq.api(`events?agent=${a.id}&limit=200`)).json as any[]).filter((e) => e.kind === 'agent.dialog_cleared')
    assert.equal(ev.length, 1, a.id); assert.equal(JSON.parse(ev[0].payload).by, 'session_file')
  }
})

test('Bug 62: doubt never clears: a status file older than the alert, or a menu still on screen', async () => {
  const stale = await tpm(), menu = await tpm()
  await hq.session(stale.id, 'idle', Date.now() - 60_000); await note(stale, 'permission_prompt')
  await note(menu, 'permission_prompt'); await hq.session(menu.id, 'idle'); await hq.screen(menu.id, MENU)
  await hq.beats('stuck', 4) // more looks than a clear takes
  assert.ok(await open(stale), 'the file says nothing since the alert'); assert.ok(await open(menu), 'the screen still shows the dialog')
  await hq.screen(menu.id, 'all done\n'); await waitFor('it to clear once the menu has gone', async () => !(await open(menu)), 6000)
})

test('Bug 62: an API error\'s "blocked" isn\'t a dialog, so the clear leaves it alone', async () => {
  // `a` is blocked by an API error only; `both` also had a dialog. Its dialog clearing is the sign the clear has looked (Bug 155: wait for that, not for a fixed time).
  // Bug 72: a dialog after the API error makes `both` blocked by the dialog, so once that clears it follows its status file; its API error notice stays open.
  const a = await tpm(), both = await tpm()
  for (const x of [a, both]) await hq.hook(x.id, { hook_event_name: 'StopFailure', error: 'overloaded' })
  await note(both, 'permission_prompt'); assert.ok(await open(both))
  for (const x of [a, both]) await hq.session(x.id, 'idle')
  await waitFor('the dialog to clear', async () => !(await open(both)), 8000)
  assert.equal((await now(a)).status, 'blocked'); assert.equal((await now(a)).blocked_why, 'api_error') // and the page can say so
  for (const x of [a, both]) assert.ok(await open(x, 'api_error'), x.id)
})

// Bug 218: an agent that works again (or goes idle, or ends) has no reason for a block it isn't in: the API kept 'dialog' or 'api_error' on it.
test('Bug 218: blocked_why goes once the agent isn\'t blocked, whichever way it leaves; a helper\'s hook leaves the block alone', async () => {
  const a = await tpm(), why = async () => { const x = await now(a); return [x.status, x.blocked_why] }
  await note(a, 'permission_prompt'); assert.deepEqual(await why(), ['blocked', 'dialog'])
  await hq.hook(a.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' }, agent_id: 'helper-1' })
  assert.deepEqual(await why(), ['blocked', 'dialog'], 'a helper working says nothing about the main loop\'s dialog')
  await hq.hook(a.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'b218' })
  assert.deepEqual(await why(), ['working', null], 'working again after a dialog')
  await hq.hook(a.id, { hook_event_name: 'StopFailure', error: 'overloaded' }); assert.deepEqual(await why(), ['blocked', 'api_error'])
  await hq.hook(a.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go on' }); assert.deepEqual(await why(), ['working', null], 'a turn after an API error')
  await hq.hook(a.id, { hook_event_name: 'StopFailure', error: 'overloaded' }); await hq.hook(a.id, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
  assert.deepEqual(await why(), ['idle', null], 'a turn that ended normally')
  // the dialog look (dialogclear.ts) puts a dialog-blocked agent back to its status file's word
  await note(a, 'permission_prompt'); await hq.session(a.id, 'idle')
  await waitFor('the dialog to clear', async () => !(await open(a)), 8000); assert.deepEqual(await why(), ['idle', null])
  await hq.hook(a.id, { hook_event_name: 'StopFailure', error: 'overloaded' }); await hq.hook(a.id, { hook_event_name: 'SessionEnd', reason: 'other' })
  assert.deepEqual(await why(), ['exited', null], 'an ended agent is blocked by nothing')
})

test('Bug 178: an API error\'s notice goes once the next turn starts or one ends normally; other agents\' and other kinds of notices stay', async () => {
  const next = await tpm(), ends = await tpm(), other = await tpm()
  for (const x of [next, ends, other]) { await hq.hook(x.id, { hook_event_name: 'StopFailure', error: 'overloaded' }); assert.ok(await open(x, 'api_error'), x.id) }
  await hq.session(next.id, 'waiting'); await note(next, 'permission_prompt') // its dialog stays open while this test looks
  await hq.hook(next.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go on' })
  assert.equal((await now(next)).status, 'working'); assert.equal(await open(next, 'api_error'), undefined)
  assert.ok(await open(next, 'dialog'), 'only the API error is over') // the dialog clears by its own rules (presence.ts)
  await hq.hook(ends.id, { hook_event_name: 'Stop', last_assistant_message: 'done' })
  assert.equal((await now(ends)).status, 'idle'); assert.equal(await open(ends, 'api_error'), undefined)
  await hq.hook(ends.id, { hook_event_name: 'StopFailure', error: 'overloaded' }) // the same error again is a new one: it shows again
  assert.deepEqual([(await now(ends)).status, (await now(ends)).blocked_why], ['blocked', 'api_error']); assert.ok(await open(ends, 'api_error'))
  assert.ok(await open(other, 'api_error'), 'another agent\'s turns don\'t end its error'); assert.equal((await now(other)).blocked_why, 'api_error')
})

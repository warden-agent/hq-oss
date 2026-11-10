// Bug 62, the part that ships whatever the spike finds: the Notification types HQ acts on are matched by their exact names (2.1.300), and a dialog alert goes with its
// session, because a session that's over has no dialog.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

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
    await note(a, type, `waiting: ${type}`); assert.equal((await now(a)).status, 'blocked', type); assert.match((await open(a))?.detail ?? '', new RegExp(type), type)
  }
  await note(a, 'permission_prompt', 'Claude Code needs your approval for the plan'); assert.doesNotMatch((await open(a)).detail, /approval for the plan/) // the plan gate isn't a dialog
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
  await new Promise((r) => setTimeout(r, 2500)); assert.ok(await open(idle), 'still waiting: it stays') // denied, say: no hook comes
  await hq.session(idle.id, 'idle'); await hq.session(busy.id, 'busy')
  await waitFor('both to clear', async () => !(await open(idle)) && !(await open(busy)), 6000)
  assert.equal((await now(idle)).status, 'idle'); assert.equal((await now(busy)).status, 'working')
  const ev = ((await hq.api('events?limit=200')).json as any[]).filter((e) => e.kind === 'agent.dialog_cleared'); assert.equal(ev.length, 2); assert.equal(JSON.parse(ev[0].payload).by, 'session_file')
})

test('Bug 62: doubt never clears: a status file older than the alert, or a menu still on screen', async () => {
  const stale = await tpm(), menu = await tpm()
  await hq.session(stale.id, 'idle', Date.now() - 60_000); await note(stale, 'permission_prompt')
  await note(menu, 'permission_prompt'); await hq.session(menu.id, 'idle'); await hq.screen(menu.id, MENU)
  await new Promise((r) => setTimeout(r, 3500))
  assert.ok(await open(stale), 'the file says nothing since the alert'); assert.ok(await open(menu), 'the screen still shows the dialog')
  await hq.screen(menu.id, 'all done\n'); await waitFor('it to clear once the menu has gone', async () => !(await open(menu)), 6000)
})

test('Bug 62: an API error\'s "blocked" isn\'t a dialog, so the clear leaves it alone', async () => {
  const a = await tpm()
  await hq.hook(a.id, { hook_event_name: 'StopFailure', error: 'overloaded' }); await hq.session(a.id, 'idle')
  await new Promise((r) => setTimeout(r, 3000)); assert.equal((await now(a)).status, 'blocked'); assert.ok(await open(a, 'api_error'))
})

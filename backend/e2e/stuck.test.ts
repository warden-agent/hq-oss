// Bug 114 end to end (see harness.ts): an engineer whose plan waits for the user's review is not "stuck", and its quiet clock starts
// again when the plan is answered; an open "stuck" alert goes as soon as its agent ends (Stop, its session ending, a finished
// ticket's engineer stopping), and one left open on an agent that has already ended (saved before the fix) goes on the next look.
// The tests act as the engineers (fake Claude Code); here an agent is stuck after 3 s of no events and no screen change.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
before(async () => {
  hq = await startHq({ env: { HQ_STUCK_TICK_S: '1', HQ_FINISHED_STOP_MS: '300', HQ_FINISHED_TICK_S: '1' } })
  await hq.api('settings', { key: 'concurrency_cap', value: 20 }); await hq.api('settings', { key: 'stuck_working_min', value: 0.05 }) // 3 s
})
after(async () => { await hq?.stop() })

const agentOf = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
const stuck = async (id: string) => (await hq.state()).attention.filter((a: any) => a.kind === 'stuck' && a.agent_id === id)
const isStuck = async (id: string) => { const x = await stuck(id); return x.length ? x[0] : null }
async function engineer(name: string) {
  const dir = hq.repo(name), repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await agentOf(eng.id))?.status === 'working')
  return { dir, eng, t }
}

test('a plan waiting for review is not stuck; once it is answered, the engineer is stuck only after a full quiet spell', async () => {
  const { eng, t } = await engineer('plan'), control = await engineer('control')
  const hold = hq.hook(eng.id, exitPlanMode('Plan: one box.'))
  await waitFor('plan_review', async () => (await agentOf(eng.id)).status === 'plan_review')
  // The control engineer works and goes quiet after the plan began to wait: by the time it is stuck, the plan has waited longer than that
  await hq.hook(control.eng.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a' } })
  await waitFor('the control engineer to look stuck', () => isStuck(control.eng.id), 15_000)
  assert.deepEqual(await stuck(eng.id), [], 'waiting for the user is not stuck')
  // Answered: the wait doesn't count towards the next alert
  const review = (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open')
  const answered = Date.now(); assert.equal((await hq.api(`reviews/${review.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  assert.equal((await hold).hookSpecificOutput.decision.behavior, 'allow')
  assert.equal((await agentOf(eng.id)).status, 'working')
  const al = await waitFor('the engineer to look stuck after its plan', () => isStuck(eng.id), 15_000)
  assert.ok(al.created_at - answered >= 1900, `stuck ${al.created_at - answered} ms after the answer: the wait for the review was counted`)
  assert.match(al.detail, /\(status working\)$/)
})

test('a plan whose hold has been answered as "still waiting" is still not stuck while its review is open', async () => {
  const { eng, t } = await engineer('pending'), control = await engineer('control2')
  const hold = hq.hook(eng.id, exitPlanMode('Plan: two boxes.'))
  await waitFor('plan_review', async () => (await agentOf(eng.id)).status === 'plan_review')
  // What the engineer does when the gate's hold times out: its tool call is denied and it calls ExitPlanMode again later. Meanwhile it is working.
  await hq.hook(eng.id, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: {} })
  assert.equal((await agentOf(eng.id)).status, 'working')
  await hq.hook(control.eng.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a' } })
  await waitFor('the control engineer to look stuck', () => isStuck(control.eng.id), 15_000)
  assert.deepEqual(await stuck(eng.id), [], 'its plan still waits for the user')
  assert.ok((await hq.state()).reviews.some((r: any) => r.ticket_id === t.id && r.status === 'open'))
  void hold.catch(() => {})
})

test('an open stuck alert goes when its agent ends: Stop, its session ending, its ticket finishing', async () => {
  // Stop
  const a = await engineer('stop')
  await waitFor('stuck', () => isStuck(a.eng.id), 15_000)
  assert.equal((await hq.api(`agents/${a.eng.id}/stop`, {})).status, 200)
  assert.deepEqual(await stuck(a.eng.id), [], 'gone with the agent')
  // Claude Code's session ends (SessionEnd hook)
  const b = await engineer('session-end')
  await waitFor('stuck', () => isStuck(b.eng.id), 15_000)
  await hq.hook(b.eng.id, { hook_event_name: 'SessionEnd', reason: 'other' })
  assert.equal((await agentOf(b.eng.id)).status, 'exited'); assert.deepEqual(await stuck(b.eng.id), [])
  // What the bug showed: the engineer finishes its ticket and HQ stops it; the alert used to stay on the ticket until the merge
  const c = await engineer('finished')
  await waitFor('stuck', () => isStuck(c.eng.id), 15_000)
  const wt = path.join(c.dir, '.claude', 'worktrees', c.t.key)
  fs.writeFileSync(path.join(wt, 'v.txt'), 'one\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'one')
  assert.equal((await hq.mcp(c.eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })).isError, false)
  const r = await hq.mcp(c.eng.id, 'open_pr', { title: 'One', body: 'One.\n\n## Deviations from approved plan\nNone' }); assert.equal(r.isError, false, r.text)
  await hq.hook(c.eng.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  await waitFor('the finished engineer to stop', async () => (await agentOf(c.eng.id)).status === 'exited', 8000)
  assert.deepEqual(await stuck(c.eng.id), [])
  assert.equal((await hq.state()).attention.filter((x: any) => x.ticket_id === c.t.id && x.kind === 'stuck').length, 0, 'nothing left on the ticket box')
})

test('a stuck alert left open on an agent that has already ended (saved before the fix) goes on the next look', async () => {
  const { eng, t } = await engineer('old-row')
  await hq.api(`agents/${eng.id}/stop`, {})
  const db = hq.db()
  try {
    db.prepare("INSERT INTO needs_attention(id, agent_id, ticket_id, kind, detail, created_at) VALUES ('att-old', ?, ?, 'stuck', ?, ?)")
      .run(eng.id, t.id, `${eng.id}: no events for 10 min and the screen has not changed (status working)`, Date.now())
    await waitFor('the old alert to go', () => db.prepare("SELECT resolved_at FROM needs_attention WHERE id = 'att-old'").get()?.resolved_at, 10_000)
  } finally { db.close() }
})

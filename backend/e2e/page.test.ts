// What HQ sends the page (ui.ts), end to end with fake agents (see harness.ts): an agent goes without its token's hash and its
// launch prompt, in the first snapshot, in the API's answers and in the patch a launch sends; a plan's text goes only while its
// review is open.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { startHq, waitFor, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

/** A tab: everything HQ's WebSocket sends it, oldest first. */
async function tab(): Promise<{ msgs: any[]; close: () => void }> {
  const msgs: any[] = [], token = fs.readFileSync(path.join(hq.hqHome, 'ui-token'), 'utf8').trim()
  const ws = new WebSocket(`ws://127.0.0.1:${hq.ports.ui}/ws`, { headers: { authorization: `Bearer ${token}` } })
  ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))))
  await new Promise<void>((ok, no) => { ws.once('open', () => ok()); ws.once('error', no) })
  return { msgs, close: () => ws.close() }
}
const kept = (a: Record<string, unknown>) => ['token_hash', 'launch_prompt'].filter((k) => k in a) // what should never reach the page

test('the page gets agents without their token\'s hash or launch prompt, and a plan\'s text only while its review is open', async () => {
  const repo = (await hq.api('repos', { path: hq.repo('page') })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'Page', request: 'Build it' })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t = await tab()
  try {
    const first = await waitFor('the first snapshot', () => t.msgs.find((m) => m.type === 'snapshot'))
    assert.deepEqual(first.data.agents.map((a: any) => [a.id, a.role, kept(a)]), [[f.tpm_agent_id, 'tpm', []]])

    const tk = (await hq.api('tickets', { featureId: f.id, title: 'Box', size: 'S', spec: 'A box.' })).json
    const e = (await hq.api(`tickets/${tk.id}/launch`, {})).json; assert.deepEqual(kept(e), [])
    const launched = await waitFor('the patch a launch sends', () => t.msgs.find((m) => m.type === 'patch' && m.entity === 'agent' && m.id === e.id && m.patch?.role === 'engineer'))
    assert.deepEqual([launched.patch.ticket_id, launched.patch.tmux_session, launched.patch.display_name, kept(launched.patch)], [tk.id, `hq-${e.id}`, e.display_name, []])
    await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === e.id && a.status === 'working'))
    for (const a of (await hq.state()).agents) assert.deepEqual(kept(a), [])
    assert.match(fs.readFileSync(path.join(hq.hqHome, 'agents', e.id, 'prompt.md'), 'utf8'), new RegExp(`${tk.key}`), 'the prompt is still on disk')

    const plan = `Plan: one box\n${'It has six sides. '.repeat(200)}`, hold = hq.hook(e.id, exitPlanMode(plan))
    const open = await waitFor('the open review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === tk.id && r.status === 'open'))
    assert.equal(open.plan_text, plan)
    await waitFor('the review to reach the tab', () => t.msgs.find((m) => m.type === 'patch' && m.entity === 'review' && m.id === open.id && m.patch?.plan_text === plan))
    assert.equal((await hq.api(`reviews/${open.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
    assert.equal((await hold).hookSpecificOutput.decision.behavior, 'allow')
    const closed = (await hq.state()).reviews.find((r: any) => r.id === open.id)
    assert.deepEqual([closed.status, closed.closed_reason, closed.verdict, closed.agent_id, closed.plan_text], ['answered', 'approve', 'approve', e.id, null])
    for (const m of t.msgs.filter((x) => x.type === 'patch' && x.entity === 'agent')) assert.deepEqual(kept(m.patch ?? {}), [])
  } finally { t.close() }
})

test('Bug 122: an agent that ends loses its activity line at once, in an open tab too, and keeps why it ended across a restart', async () => {
  await hq.api('settings', { key: 'concurrency_cap', value: 20 }) // the first test's engineer still runs
  const repo = (await hq.api('repos', { path: hq.repo('ended') })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'Ended', request: 'Build it' })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const one = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
  const start = async (title: string) => {
    const tk = (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json, e = (await hq.api(`tickets/${tk.id}/launch`, {})).json
    await waitFor('the engineer', async () => (await one(e.id))?.status === 'working')
    await hq.hook(e.id, { hook_event_name: 'PreToolUse', tool_name: 'mcp__hq__get_ticket', tool_input: {} })
    await waitFor('its activity line', async () => (await one(e.id))?.activity === 'Calling hq.get_ticket'); return e
  }
  const stopped = await start('Stopped'), quit = await start('Quit')
  const t = await tab()
  try {
    await waitFor('the snapshot', () => t.msgs.find((m) => m.type === 'snapshot'))
    assert.equal((await hq.api(`agents/${stopped.id}/stop`, {})).status, 200)
    const p = await waitFor('the patch the stop sends', () => t.msgs.find((m) => m.type === 'patch' && m.entity === 'agent' && m.id === stopped.id && m.patch?.status === 'exited'))
    assert.deepEqual([p.patch.activity, p.patch.ended_why], [null, 'user'], 'the same patch clears the line and says why')
    // A session that ends by itself says so; what doesn't end it (a /clear) keeps the line
    await hq.hook(quit.id, { hook_event_name: 'SessionEnd', reason: 'clear' }); assert.equal((await one(quit.id)).activity, 'Calling hq.get_ticket')
    await hq.hook(quit.id, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })
    assert.deepEqual([(await one(quit.id)).status, (await one(quit.id)).activity, (await one(quit.id)).ended_why], ['exited', null, 'session:prompt_input_exit'])
    assert.equal((await one(f.tpm_agent_id)).ended_why, null, 'a running agent has no ending')
  } finally { t.close() }
  await hq.restart()
  for (const [id, why] of [[stopped.id, 'user'], [quit.id, 'session:prompt_input_exit']]) assert.deepEqual([(await one(id)).activity ?? null, (await one(id)).ended_why], [null, why])
  // Stop on an agent that has already ended (its Agent tab still offers it) changes neither why nor when it ended
  for (const id of [stopped.id, quit.id]) {
    const was = await one(id); assert.equal((await hq.api(`agents/${id}/stop`, {})).status, 200)
    assert.deepEqual([(await one(id)).ended_why, (await one(id)).ended_at], [was.ended_why, was.ended_at], id)
  }
})

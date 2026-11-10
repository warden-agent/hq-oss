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

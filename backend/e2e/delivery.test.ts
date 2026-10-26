// Message delivery and agent lifecycle end to end (see harness.ts): a batch the mod never got or couldn't submit comes back,
// a hold set mid-poll holds, only real answers answer a question, HQ's notices are HQ's, and a stopped agent's token is dead.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

async function setup(name: string): Promise<{ dir: string; repo: any; f: any; tpm: any }> {
  const dir = hq.repo(name)
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f, tpm }
}
/** The mod takes the launch prompt and Claude Code submits it (the UserPromptSubmit hook acks it). */
async function takeLaunch(agentId: string): Promise<void> {
  const b = (await hq.modNext(agentId)).batch; assert.ok(b, 'a launch batch'); await hq.modEvent(agentId, { kind: 'batch_received', id: b.id })
  await hq.hook(agentId, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
}
const say = (agentId: string, body: string) => hq.api(`agents/${agentId}/message`, { body, reason: 'fyi' })
const ticketOf = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)

test('a batch the mod could not submit is handed out again', async () => {
  const { tpm } = await setup('submit-failed')
  await takeLaunch(tpm.id)
  await say(tpm.id, 'Please split it into two tickets.')
  const b1 = (await hq.modNext(tpm.id)).batch; assert.match(b1.text, /two tickets/)
  await hq.modEvent(tpm.id, { kind: 'batch_received', id: b1.id }); await hq.modEvent(tpm.id, { kind: 'batch_submit_failed', id: b1.id, error: 'boom' })
  const b2 = (await hq.modNext(tpm.id)).batch
  assert.ok(b2, 'handed again'); assert.notEqual(b2.id, b1.id); assert.equal(b2.text, b1.text)
})

test('a batch that keeps failing is given up after three tries, and the user is told', async () => {
  const { tpm } = await setup('submit-loop')
  await takeLaunch(tpm.id)
  await say(tpm.id, 'Stubborn note.')
  for (let i = 0; i < 3; i++) {
    const b = (await hq.modNext(tpm.id)).batch; assert.ok(b, `try ${i + 1}`); assert.match(b.text, /Stubborn note/)
    await hq.modEvent(tpm.id, { kind: 'batch_received', id: b.id }); await hq.modEvent(tpm.id, { kind: 'batch_submit_failed', id: b.id, error: 'boom' })
  }
  assert.deepEqual(await hq.modNext(tpm.id), {}) // not handed out a fourth time
  const att = (await hq.state()).attention.find((a: any) => a.kind === 'delivery_failed' && a.agent_id === tpm.id)
  assert.ok(att); assert.match(att.detail, /3 times/)
  const m = (await hq.state()).messages.find((x: any) => x.body === 'Stubborn note.'); assert.equal(m.delivery_method, 'failed')
})

test('a batch that never reached the mod is handed out again; one it got is not', async () => {
  const { tpm } = await setup('never-received')
  await takeLaunch(tpm.id)
  assert.equal((await hq.api('settings', { key: 'batch_receive_s', value: 1 })).status, 200)
  await say(tpm.id, 'First note.')
  const lost = (await hq.modNext(tpm.id)).batch; assert.match(lost.text, /First note/) // the long-poll answer never arrives
  await new Promise((r) => setTimeout(r, 1300))
  const again = (await hq.modNext(tpm.id)).batch; assert.ok(again, 'handed again'); assert.equal(again.text, lost.text)
  await hq.modEvent(tpm.id, { kind: 'batch_received', id: again.id }) // this one got there; it waits for the session to go idle
  await new Promise((r) => setTimeout(r, 1300))
  assert.deepEqual(await hq.modNext(tpm.id), {})
  await hq.api('settings', { key: 'batch_receive_s', value: 30 })
})

test('a launch prompt the mod could not submit is handed out again', async () => {
  const { tpm } = await setup('launch-failed')
  const b1 = (await hq.modNext(tpm.id)).batch; assert.ok(b1.raw)
  await hq.modEvent(tpm.id, { kind: 'batch_received', id: b1.id }); await hq.modEvent(tpm.id, { kind: 'batch_submit_failed', id: b1.id, error: 'boom' })
  const b2 = (await hq.modNext(tpm.id)).batch
  assert.ok(b2, 'handed again'); assert.equal(b2.text, b1.text)
})

test('a hold set while the mod is polling holds the batch', async () => {
  const { tpm } = await setup('hold-mid-poll')
  await takeLaunch(tpm.id)
  const poll = hq.modNext(tpm.id, 2500)
  await new Promise((r) => setTimeout(r, 300))
  await hq.api(`agents/${tpm.id}/takeover`, { locked: true }); await say(tpm.id, 'Held note.')
  assert.deepEqual(await poll, {})
  await hq.api(`agents/${tpm.id}/takeover`, { locked: false })
  assert.match((await hq.modNext(tpm.id)).batch.text, /Held note/)
})

test('only an answer answers an engineer\'s question; HQ\'s notices come from HQ', async () => {
  const { f, tpm } = await setup('questions')
  assert.equal((await hq.api('settings', { key: 'dm_per_peer_min', value: 0 })).status, 200)
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Shelf', size: 'S', spec: 'A shelf.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  const started = await waitFor('the started notice', async () => (await hq.state()).messages.find((m: any) => m.to_id === tpm.id && /started on/.test(m.body)))
  assert.equal(started.from_id, 'hq')

  const ask = await hq.mcp(eng.id, 'send_message', { to: 'tpm', reason: 'question', body: 'Wood or metal?' }); assert.equal(ask.isError, false, ask.text)
  assert.equal((await ticketOf(t)).status, 'awaiting_answer')
  assert.equal((await hq.mcp(tpm.id, 'update_ticket_spec', { key: t.key, spec: 'A wooden shelf.' })).isError, false)
  assert.equal((await ticketOf(t)).status, 'awaiting_answer') // the "spec updated" FYI is not an answer
  assert.equal((await hq.mcp(tpm.id, 'send_message', { to: eng.id, reason: 'fyi', body: 'Thinking about it.' })).isError, false)
  assert.equal((await ticketOf(t)).status, 'awaiting_answer')
  assert.equal((await hq.mcp(tpm.id, 'send_message', { to: eng.id, reason: 'answer', body: 'Wood.' })).isError, false)
  assert.notEqual((await ticketOf(t)).status, 'awaiting_answer')

  await hq.mcp(eng.id, 'send_message', { to: 'tpm', reason: 'question', body: 'Oak or pine?' })
  assert.equal((await ticketOf(t)).status, 'awaiting_answer')
  await say(eng.id, 'Pine.') // The user's reply from HQ's message box answers it
  assert.notEqual((await ticketOf(t)).status, 'awaiting_answer')
  await hq.api('settings', { key: 'dm_per_peer_min', value: 5 })
})

test('engineers have no respond_to_issues tool', async () => {
  const { f } = await setup('no-respond')
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Jar', size: 'S', spec: 'A jar.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  const r = await hq.mcp(eng.id, 'respond_to_issues', { responses: [] }).catch((e) => ({ text: String(e), isError: true }))
  assert.equal(r.isError, true); assert.match(r.text, /not found/i)
})

test('a stopped agent\'s token stops working; /clear keeps a session alive; a lost engineer frees its slot', async () => {
  const { f, tpm } = await setup('lifecycle')
  await hq.api('settings', { key: 'concurrency_cap', value: 10 })
  await hq.hook(tpm.id, { hook_event_name: 'SessionEnd', reason: 'clear' })
  assert.equal((await hq.state()).agents.find((a: any) => a.id === tpm.id).status, 'working')
  assert.equal((await hq.hook(tpm.id, { hook_event_name: 'SessionStart', source: 'clear' })).error, undefined)

  const t1 = (await hq.api('tickets', { featureId: f.id, title: 'Lid', size: 'S', spec: 'A lid.' })).json
  const e1 = (await hq.api(`tickets/${t1.id}/launch`, {})).json
  await waitFor('engineer 1', async () => (await hq.state()).agents.find((a: any) => a.id === e1.id && a.status === 'working'))
  const worker = (id: string) => /export HQ_WORKER='(\d+)'/.exec(fs.readFileSync(path.join(hq.hqHome, 'agents', id, 'launch.sh'), 'utf8'))?.[1]
  const port = (id: string) => /export PORT='(\d+)'/.exec(fs.readFileSync(path.join(hq.hqHome, 'agents', id, 'launch.sh'), 'utf8'))?.[1]
  const w1 = worker(e1.id); assert.ok(w1); assert.equal(port(e1.id), String(3100 + Number(w1) * 10))
  const tok = hq.agentToken(e1.id)
  hq.tmux('kill-session', '-t', `hq-${e1.id}`) // the engineer's process dies without a SessionEnd
  await hq.restart() // recoverAgents finds it gone
  assert.equal((await hq.state()).agents.find((a: any) => a.id === e1.id).status, 'exited')
  const hook = await fetch(`http://127.0.0.1:${hq.ports.hooks}/hooks/${tok}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }) })
  assert.equal(hook.status, 403)
  assert.equal((await hq.state()).agents.find((a: any) => a.id === e1.id).status, 'exited') // the late hook didn't bring it back
  assert.equal(fs.existsSync(path.join(hq.hqHome, 'agents', e1.id, 'token')), false)

  const t2 = (await hq.api('tickets', { featureId: f.id, title: 'Cap', size: 'S', spec: 'A cap.' })).json
  const e2 = (await hq.api(`tickets/${t2.id}/launch`, {})).json
  await waitFor('engineer 2', async () => (await hq.state()).agents.find((a: any) => a.id === e2.id && a.status === 'working'))
  assert.equal(worker(e2.id), w1) // the lost engineer's slot was free again
  const tok2 = hq.agentToken(e2.id)
  await hq.api(`agents/${e2.id}/stop`, {})
  const mcp = await fetch(`http://127.0.0.1:${hq.ports.mcp}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tok2}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
  assert.equal(mcp.status, 401)
})

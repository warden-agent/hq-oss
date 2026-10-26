// HQ's three servers refuse what they should (see harness.ts): the permission policy per role and mode, MCP tools scoped by
// role, the UI API's token and Origin checks, bad verdicts and settings, and oversized bodies.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq, tpm: any, eng: any, ticketRow: any
after(async () => { await hq?.stop() })
before(async () => {
  hq = await startHq()
  const dir = hq.repo('hardening')
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'Hardening', request: 'Build it' })).json
  tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  ticketRow = (await hq.api('tickets', { featureId: f.id, title: 'Box', size: 'S', spec: 'A box.' })).json
  const e = (await hq.api(`tickets/${ticketRow.id}/launch`, {})).json
  eng = await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === e.id && a.status === 'working'))
})
const permission = (agentId: string, tool: string, mode: string, input: Record<string, unknown> = {}) =>
  hq.hook(agentId, { hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: input, permission_mode: mode })
const decision = (r: any) => r.hookSpecificOutput.decision.behavior

test('permission policy: engineer Bash after planning only, hq tools always, anything else denied and reported', async () => {
  assert.equal(decision(await permission(eng.id, 'Bash', 'acceptEdits', { command: 'npm test' })), 'allow')
  assert.equal(decision(await permission(eng.id, 'Bash', 'plan', { command: 'npm test' })), 'deny')
  assert.equal(decision(await permission(eng.id, 'mcp__hq__get_ticket', 'plan')), 'allow')
  assert.equal(decision(await permission(tpm.id, 'Bash', 'default', { command: 'ls' })), 'deny') // only engineers run commands
  assert.equal(decision(await permission(eng.id, 'WebFetch', 'acceptEdits', { url: 'https://example.com' })), 'deny')
  await waitFor('the unexpected-prompt notice', async () => (await hq.state()).attention.find((a: any) => a.kind === 'unexpected_prompt' && a.agent_id === eng.id))
})

test('MCP tools are scoped by role', async () => {
  const notFound = (r: { text: string; isError: boolean }) => r.isError && /not found/i.test(r.text)
  const call = (id: string, tool: string, args: Record<string, unknown> = {}) => hq.mcp(id, tool, args).catch((e) => ({ text: String(e), isError: true }))
  assert.ok(notFound(await call(eng.id, 'create_ticket', { title: 'x', size: 'S', spec: 'x' })))
  assert.ok(notFound(await call(eng.id, 'assign_ticket', { key: ticketRow.key })))
  assert.ok(notFound(await call(tpm.id, 'get_ticket')))
  assert.ok(notFound(await call(tpm.id, 'open_pr', { title: 'x', body: 'x' })))
  assert.equal((await call(eng.id, 'get_ticket')).isError, false)
  assert.equal((await call(tpm.id, 'list_tickets')).isError, false)
})

test('UI API: token and Origin checked; the ?token= link only opens the page', async () => {
  const base = `http://127.0.0.1:${hq.ports.ui}`, token = fs.readFileSync(path.join(hq.hqHome, 'ui-token'), 'utf8').trim()
  assert.equal((await fetch(`${base}/api/state`)).status, 401)
  assert.equal((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}`, origin: 'http://evil.test' } })).status, 403)
  assert.equal((await fetch(`${base}/api/state?token=${token}`)).status, 401)
  const page = await fetch(`${base}/?token=${token}`); assert.equal(page.status, 200); assert.match(page.headers.get('set-cookie') ?? '', /^hq=/)
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: `hq=${encodeURIComponent(token)}` } })).status, 200)
})

test('bad verdicts, bad settings and oversized bodies are refused (1 MB; 8 MB for hooks)', async () => {
  const hold = hq.hook(eng.id, { hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: 'Plan: a box', planFilePath: null }, permission_mode: 'plan' })
  const review = await waitFor('the review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === ticketRow.id && r.status === 'open'))
  const bad = await hq.api(`reviews/${review.id}/answer`, { verdict: 'lgtm', by: 'user' })
  assert.equal(bad.status, 400); assert.match(bad.json.error, /verdict/)
  assert.equal((await hq.state()).reviews.find((r: any) => r.id === review.id).status, 'open') // still answerable
  assert.equal((await hq.api(`reviews/${review.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  assert.equal(decision(await hold), 'allow')

  const s = await hq.api('settings', { key: 'models', value: 'opus' }); assert.equal(s.status, 400); assert.match(s.json.error, /models/)
  assert.equal((await hq.api('settings', { key: 'whatever', value: 1 })).status, 400)
  assert.equal((await hq.api('settings', { key: 'concurrency_cap', value: 3 })).status, 200)

  const big = JSON.stringify({ body: 'x'.repeat(2 * 1024 * 1024) })
  const ui = await fetch(`http://127.0.0.1:${hq.ports.ui}/api/agents/${tpm.id}/message`, { method: 'POST', headers: { authorization: `Bearer ${fs.readFileSync(path.join(hq.hqHome, 'ui-token'), 'utf8').trim()}`, 'content-type': 'application/json' }, body: big })
  assert.equal(ui.status, 413)
  const hookUrl = `http://127.0.0.1:${hq.ports.hooks}/hooks/${hq.agentToken(eng.id)}` // hooks carry whole tool outputs: 8 MB there
  const hook2 = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: 'x'.repeat(2 * 1024 * 1024) }) })
  assert.equal(hook2.status, 200)
  const hook = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x'.repeat(9 * 1024 * 1024) }) })
  assert.equal(hook.status, 413)
  const mcp = await fetch(`http://127.0.0.1:${hq.ports.mcp}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${hq.agentToken(eng.id)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: big })
  assert.equal(mcp.status, 413)
  assert.equal((await hq.api('state')).status, 200) // and HQ is still fine
})

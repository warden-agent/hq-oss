// The tools server (mcp.ts) asked directly: which of HQ's tools each kind of agent is offered, and who is let in at all. A tool an agent is not
// offered is one it cannot call, so the lists below are what keeps an engineer from creating tickets or a TPM from opening a PR. Nothing in mcp.ts is
// changed for these. Real SQLite in a temp HQ_HOME, the real server on a port the OS picks, and the client Claude Code's side of the protocol uses.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-mcptools-'))
process.env.HQ_HOME = path.join(root, 'hq'); process.env.HQ_MCP_PORT = '0'
const { migrate, run } = await import('./db.ts')
migrate()
const { sha } = await import('./util.ts')
const { startMcpServer } = await import('./mcp.ts')
type Role = import('./roles.ts').Role

const srv = startMcpServer(); await new Promise((r) => srv.once('listening', r))
const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
after(() => { srv.close(); srv.closeAllConnections(); fs.rmSync(root, { recursive: true, force: true }) })

let n = 0
/** An agent's row with the hash of a token of its own, as a launch leaves it (agents.ts). Returns the token. */
function agent(role: Role): string {
  const id = `${role}-${++n}`, token = `token-of-${id}`
  run(`INSERT INTO agents(id, role, model_alias, tmux_session, cwd, token_hash, status, in_plan_mode, started_at, last_event_at)
    VALUES (?, ?, 'sonnet', ?, '/tmp', ?, 'working', 0, 1, 1)`, id, role, `hq-${id}`, sha(token))
  return token
}
/** The names of the tools HQ offers whoever holds this token, in the server's own order. */
async function offered(token: string): Promise<string[]> {
  const client = new Client({ name: 'hq-unit', version: '0.0.1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  try { return (await client.listTools()).tools.map((t) => t.name) } finally { await client.close() }
}
const ask = (token: string | null, where = '/mcp') => fetch(`${url}${where}`, { method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })

const COMMON = ['read_inbox', 'send_message']

test('a TPM is offered the tools that plan the work: features, tickets, their order, questions to the user, and the findings loop', async () => {
  assert.deepEqual(await offered(agent('tpm')), [...COMMON, 'write_handoff_note', 'list_findings', 'create_fix_ticket', 'list_tickets', 'start_feature', 'create_ticket',
    'update_ticket_spec', 'set_merge_order', 'assign_ticket', 'ask_user', 'cancel_ticket', 'set_dependencies', 'write_feature'])
})

test('an engineer is offered the tools of its own ticket: read it, log its handoff, report a block, propose test commands, open the PR', async () => {
  assert.deepEqual(await offered(agent('engineer')), [...COMMON, 'write_handoff_note', 'get_ticket', 'update_handoff', 'update_test_setup', 'report_blocked',
    'propose_test_command', 'update_feature_map', 'open_pr'])
})

test('the Launch helper is offered the tools that save how the app starts and is tested, and no ticket tools', async () => {
  assert.deepEqual(await offered(agent('launcher')), [...COMMON, 'save_launch', 'launch_ok', 'report_cant_start', 'save_test_setup', 'report_cant_test'])
})

test('an architect and a tester are offered the two tools every agent has, and nothing else', async () => {
  assert.deepEqual(await offered(agent('architect')), COMMON); assert.deepEqual(await offered(agent('tester')), COMMON)
})

test('no role is offered another role\'s tools: a TPM cannot open a PR, an engineer cannot create or cancel tickets, a helper can do neither', async () => {
  const tpm = await offered(agent('tpm')), eng = await offered(agent('engineer')), helper = await offered(agent('launcher'))
  for (const t of ['open_pr', 'get_ticket', 'update_handoff', 'save_launch']) assert.ok(!tpm.includes(t), `a TPM is offered ${t}`)
  for (const t of ['create_ticket', 'cancel_ticket', 'assign_ticket', 'ask_user', 'start_feature', 'create_fix_ticket', 'save_launch']) assert.ok(!eng.includes(t), `an engineer is offered ${t}`)
  for (const t of ['create_ticket', 'open_pr', 'write_handoff_note']) assert.ok(!helper.includes(t), `the Launch helper is offered ${t}`)
})

test('at the door: a wrong token, no token and a revoked token are refused with 401; a good token asking elsewhere is not found', async () => {
  const good = agent('engineer'), gone = agent('engineer')
  run('UPDATE agents SET token_revoked_at = 1 WHERE token_hash = ?', sha(gone))
  for (const t of ['not-a-token', null, gone]) {
    const r = await ask(t); assert.equal(r.status, 401, String(t)); assert.deepEqual(await r.json(), { error: 'unauthorized' })
  }
  assert.equal((await ask(good, '/elsewhere')).status, 404)
  assert.equal((await ask(good)).status, 200)
})

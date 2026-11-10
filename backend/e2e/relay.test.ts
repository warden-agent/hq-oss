// Bug 78 end to end (see harness.ts): an agent reaches HQ's tools through the relay HQ wrote into its mcp.json, started here
// the way Claude Code starts it. The backend goes away and comes back; the tools are still there with nobody doing anything,
// and a call made in between waits and goes through once.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startHq, waitFor, pendingAfter, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })
const said = (r: unknown): string => (r as { content: { text: string }[] }).content.map((c) => c.text).join('\n')

test('Bug 78: an agent keeps HQ\'s tools while the backend is away, and a call made meanwhile goes through when it is back', async () => {
  const repo = (await hq.api('repos', { path: hq.repo('relay') })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'relay', request: 'Build it' })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  const conf = JSON.parse(fs.readFileSync(path.join(hq.hqHome, 'agents', eng.id, 'mcp.json'), 'utf8')).mcpServers.hq
  assert.equal(conf.type, 'stdio'); assert.ok(!JSON.stringify(conf).includes(hq.agentToken(eng.id))) // its token stays in its own file

  const client = new Client({ name: 'hq-e2e', version: '0.0.1' }); let stderr = ''
  const relay = new StdioClientTransport({ command: conf.command, args: conf.args, env: conf.env, stderr: 'pipe' })
  relay.stderr!.on('data', (d) => { stderr += d })
  await client.connect(relay)
  try {
    const tools = (await client.listTools()).tools.map((x) => x.name)
    assert.ok(tools.includes('open_pr') && tools.includes('get_ticket') && !tools.includes('create_ticket'), tools.join(' ')) // the engineer's own tools
    assert.match(said(await client.callTool({ name: 'get_ticket', arguments: {} })), /\(S\): One/)

    await hq.down()
    const held = client.callTool({ name: 'update_handoff', arguments: { kind: 'milestone', text: 'written while HQ was away' } })
    assert.equal(await pendingAfter(held, 2500), true) // it waits: no error, no lost connection
    await hq.up()
    assert.equal(said(await held), 'Handoff recorded.')

    const ticket = said(await client.callTool({ name: 'get_ticket', arguments: {} })) // and the tools are simply still there
    assert.equal(ticket.split('written while HQ was away').length - 1, 1) // recorded once
    const waited = await waitFor('HQ\'s record of the wait', async () => (await hq.api(`events?agent=${eng.id}&limit=50`)).json.find((e: any) => e.kind === 'mcp.waited'))
    const p = JSON.parse(waited.payload); assert.equal(p.call, 'update_handoff'); assert.ok(p.ms >= 2000, String(p.ms))
    assert.match(stderr, /isn't answering/); assert.match(stderr, /is back after/)

    await hq.api(`agents/${eng.id}/stop`, {}) // a stopped session's token is no good: the relay says so and stays up
    const gone = await client.callTool({ name: 'get_ticket', arguments: {} }).then(() => '', (e) => String(e.message))
    assert.match(gone, /ended this session's access/)
  } finally { await client.close() }
})

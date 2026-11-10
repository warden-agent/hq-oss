// Bug 78: the relay each agent's Claude Code starts as its "hq" MCP server (mcprelay.mjs). Here it runs against a stand-in
// backend that the test can take away, kill halfway through a call, or have refuse the token.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

const RELAY = path.join(import.meta.dirname, 'mcprelay.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-relay-'))
const tokenFile = path.join(tmp, 'token'); fs.writeFileSync(tokenFile, 'tok-123\n')
const ends: (() => void)[] = []
after(() => { for (const f of ends) f(); fs.rmSync(tmp, { recursive: true, force: true }) })

type Msg = Record<string, any>
type Seen = { headers: http.IncomingHttpHeaders; msg: Msg }
const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
})
const until = async <T>(what: string, fn: () => T | undefined | false, ms = 5000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 20)) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A stand-in backend on `port`. `answer` gets each message and says what to do: a result to send back (as events, the way the
 *  real server answers, or as plain JSON), 'die' to drop the connection without answering, or a status to refuse it with. */
type Answer = { result: unknown; plain?: boolean } | 'die' | { status: number; body: string }
function backend(port: number, answer: (m: Msg, n: number) => Answer) {
  const seen: Seen[] = []
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c }); req.on('end', () => {
      const msg = JSON.parse(body) as Msg; seen.push({ headers: req.headers, msg })
      if (msg.id === undefined) { res.writeHead(202); res.end(); return }
      const a = answer(msg, seen.filter((s) => s.msg.id !== undefined).length)
      if (a === 'die') { req.socket.destroy(); return }
      if ('status' in a) { res.writeHead(a.status, { 'content-type': 'application/json' }); res.end(a.body); return }
      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: a.result })
      if (a.plain) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(reply); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`event: message\ndata: ${reply}\n\n`)
    })
  })
  const up = new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()))
  const stop = () => { srv.closeAllConnections(); srv.close() }; ends.push(stop)
  return { seen, up, stop, calls: () => seen.filter((s) => s.msg.id !== undefined) }
}
/** The relay as Claude Code runs it: a message per line in, a message per line out. */
function relay(port: number, file = tokenFile) {
  const p: ChildProcess = spawn(process.execPath, [RELAY], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HQ_MCP_URL: `http://127.0.0.1:${port}/mcp`, HQ_TOKEN_FILE: file, HQ_RELAY_RETRY_MS: '50', HQ_RELAY_PROGRESS_MS: '150' } })
  const got: Msg[] = []; let buf = '', err = ''
  p.stdout!.on('data', (d) => { buf += d; const ls = buf.split('\n'); buf = ls.pop()!; for (const l of ls) if (l.trim()) got.push(JSON.parse(l)) })
  p.stderr!.on('data', (d) => { err += d })
  ends.push(() => { try { p.kill('SIGKILL') } catch { /* gone */ } })
  return { p, got, err: () => err, send: (m: Msg) => p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'),
    answer: (id: number) => until(`the answer to ${id}`, () => got.find((m) => m.id === id && ('result' in m || 'error' in m))) }
}
const call = (id: number, name = 'read_inbox') => ({ id, method: 'tools/call', params: { name, arguments: {}, _meta: { progressToken: id } } })

test('a call goes to the backend with the agent\'s token, and its answer comes back', async () => {
  const port = await freePort(), b = backend(port, (m) => m.method === 'initialize' ? { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } }
    : m.method === 'tools/list' ? { result: { tools: [{ name: 'read_inbox' }] }, plain: true } : { result: { content: [{ type: 'text', text: 'No new messages.' }] } })
  await b.up; const r = relay(port)
  r.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
  assert.equal((await r.answer(1)).result.protocolVersion, '2025-06-18')
  r.send({ method: 'notifications/initialized' })
  r.send({ id: 2, method: 'tools/list' }); assert.deepEqual((await r.answer(2)).result.tools, [{ name: 'read_inbox' }]) // a plain JSON answer
  r.send(call(3)); assert.equal((await r.answer(3)).result.content[0].text, 'No new messages.') // an answer sent as an event
  assert.equal(b.seen[0]!.headers.authorization, 'Bearer tok-123')
  assert.equal(b.seen[0]!.headers['mcp-protocol-version'], undefined); assert.equal(b.seen.at(-1)!.headers['mcp-protocol-version'], '2025-06-18')
  await until('the note to be passed on', () => b.seen.some((s) => s.msg.method === 'notifications/initialized'))
  assert.equal(b.seen.at(-1)!.headers['x-hq-waited-ms'], undefined) // nothing had to wait
  assert.equal(r.got.length, 3) // one answer each, nothing else on stdout
})

test('a call made while the backend is down waits for it, saying so, and goes through once when it is back', async () => {
  const port = await freePort(), r = relay(port)
  r.send(call(7, 'open_pr'))
  const note = await until('a progress note', () => r.got.find((m) => m.method === 'notifications/progress'))
  assert.equal(note.params.progressToken, 7); assert.match(note.params.message, /Waiting for HQ to come back/)
  assert.equal(r.got.some((m) => m.id === 7), false) // no answer yet, and no error
  r.send({ id: 8, method: 'ping' }); assert.deepEqual((await r.answer(8)).result, {}) // the relay itself is there
  const b = backend(port, () => ({ result: { content: [{ type: 'text', text: 'Pushed.' }] } })); await b.up
  assert.equal((await r.answer(7)).result.content[0].text, 'Pushed.')
  assert.equal(b.calls().length, 1) // the backend got it once
  assert.ok(Number(b.calls()[0]!.headers['x-hq-waited-ms']) >= 150, String(b.calls()[0]!.headers['x-hq-waited-ms']))
  const notes = r.got.filter((m) => m.method === 'notifications/progress').map((m) => m.params.progress)
  assert.deepEqual(notes, notes.map((_, i) => i + 1)) // counting up, as progress must
  assert.match(r.err(), /isn't answering/); assert.match(r.err(), /is back after/)
  r.send(call(9)); await r.answer(9); assert.equal(b.calls().at(-1)!.headers['x-hq-waited-ms'], undefined) // the next one doesn't wait
})

test('a tool call the backend had received when it went down isn\'t sent again: the agent is told to check', async () => {
  const port = await freePort(), b = backend(port, (m, n) => m.method === 'tools/call' || n === 2 ? 'die' : { result: { tools: [] } }); await b.up
  const r = relay(port)
  r.send(call(1, 'open_pr')); const a = await r.answer(1)
  assert.equal(a.result.isError, true); assert.match(a.result.content[0].text, /may or may not have gone through\. Check first/)
  r.send({ id: 2, method: 'tools/list' }) // asking twice changes nothing: that one is asked again
  assert.deepEqual((await r.answer(2)).result, { tools: [] })
  assert.deepEqual(b.calls().map((s) => s.msg.method), ['tools/call', 'tools/list', 'tools/list'])
})

test('a token HQ no longer takes, and any other refusal, come back as errors; the relay stays up', async () => {
  const port = await freePort(), b = backend(port, (_m, n) => n === 1 ? { status: 401, body: '{"error":"unauthorized"}' }
    : n === 2 ? { status: 500, body: '{"error":"HQ error"}' } : { result: {} }); await b.up
  const r = relay(port, path.join(tmp, 'no-such-token'))
  r.send(call(1)); assert.match((await r.answer(1)).error.message, /ended this session's access/)
  r.send(call(2)); assert.equal((await r.answer(2)).error.message, 'HQ answered 500: HQ error.')
  r.send(call(3)); assert.deepEqual((await r.answer(3)).result, {})
  r.p.stdin!.write('not json\n\n'); r.send({ id: 4, method: 'ping' }); await r.answer(4) // a line it can't read doesn't stop it
})

test('a cancelled call stops waiting and never reaches the backend', async () => {
  const port = await freePort(), r = relay(port)
  r.send(call(5, 'open_pr')); await sleep(120)
  r.send({ method: 'notifications/cancelled', params: { requestId: 5, reason: 'the user pressed Escape' } }); await sleep(120)
  const b = backend(port, () => ({ result: {} })); await b.up; await sleep(250)
  assert.equal(b.seen.length, 0); assert.equal(r.got.some((m) => m.id === 5), false)
  r.send(call(6)); await r.answer(6); assert.equal(b.calls().length, 1)
})

test('it ends when its Claude Code closes stdin, and not before', async () => {
  const port = await freePort(), r = relay(port)
  r.send(call(1)); await sleep(300); assert.equal(r.p.exitCode, null) // still holding a call for a backend that's down
  const gone = new Promise<number | null>((res) => r.p.once('exit', (c) => res(c)))
  r.p.stdin!.end(); assert.equal(await gone, 0)
})

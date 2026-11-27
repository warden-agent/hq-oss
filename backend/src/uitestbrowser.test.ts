// Bug 453: a scenario starts in a browser that remembers nothing of the one before. The UI tester's browser relay (uitestbrowser.mjs) and the scenario tools'
// ask for a fresh browser (uitestmcp.mjs), run for real here with stand-ins for Playwright MCP (a script that answers each line and writes down what it got)
// and for the tester's host (a small server that writes down what it was asked): what the relay passes on, what it keeps, the order things happen in, and what
// happens when a browser can't be closed. The real browser in its sandbox, with the real host, is in uitester.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const RELAY = path.join(import.meta.dirname, 'uitestbrowser.mjs'), TOOLS = path.join(import.meta.dirname, 'uitestmcp.mjs')
const require = createRequire(import.meta.url)
const sdk = (): string => { const p = require.resolve('@modelcontextprotocol/sdk/server/mcp.js'), at = '@modelcontextprotocol/sdk'; return p.slice(0, p.indexOf(at) + at.length) }
const zod = (): string => path.dirname(require.resolve('zod'))
/** A short folder, as the browser's own is: a socket's path may be 104 bytes at most (own-tmp.mjs gives the run one of its own for that). */
const folder = (): string => fs.mkdtempSync(path.join(process.env.HQ_SHORT_TMPDIR ?? '/tmp', 'hq-ut-test-'))
const until = async <T>(what: string, f: () => T | Promise<T>, ms = 10_000): Promise<T> => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error(`timed out waiting for ${what}`)
}

// The stand-in for Playwright MCP: answers every line with what it was asked and the order it came in, and writes each one down (LOG). A browser_close is
// answered as MODE says: at once, with an error, never, or once the file GATE is there (so a test can act while the close is under way).
const FAKE = `const fs = require('node:fs'), rl = require('node:readline').createInterface({ input: process.stdin })
const log = (s) => fs.appendFileSync(process.env.LOG, s + '\\n'), out = (o) => console.log(JSON.stringify({ jsonrpc: '2.0', ...o }))
let n = 0
log('pid ' + process.pid)
rl.on('line', (l) => {
  const m = JSON.parse(l), name = m.params && m.params.name; n++
  if (name !== 'browser_close') { log('call ' + (name || m.method)); return out({ id: m.id, result: { saw: name || m.method, order: n } }) }
  log('close-in')
  const done = () => { log('close-out'); out({ id: m.id, result: { content: [{ type: 'text', text: 'closed' }] } }) }
  if (process.env.MODE === 'silent') return
  if (process.env.MODE === 'error') return out({ id: m.id, result: { isError: true, content: [{ type: 'text', text: '### Error\\nBrowser is busy' }] } })
  if (process.env.MODE !== 'gate') return done()
  const t = setInterval(() => { if (fs.existsSync(process.env.GATE)) { clearInterval(t); done() } }, 10)
})
rl.on('close', () => process.exit(0))
`
type Relay = { dir: string; sock: string; proc: ChildProcessWithoutNullStreams; send: (m: unknown) => void; next: () => Promise<any>; ask: () => Promise<string>; log: () => string[]
  open: () => void; end: () => Promise<void> }
/** The relay with the stand-in under it. */
function relay(mode = 'ok', env: Record<string, string> = {}, dir = folder()): Relay {
  const fake = path.join(dir, 'fake.js'), log = path.join(dir, 'log'), gate = path.join(dir, 'gate'), sock = path.join(dir, 'fresh.sock')
  fs.writeFileSync(fake, FAKE); fs.writeFileSync(log, '')
  const proc = spawn(process.execPath, [RELAY, sock, process.execPath, fake], { env: { ...process.env, MODE: mode, LOG: log, GATE: gate, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines: string[] = [], waiting: ((l: string) => void)[] = []
  readline.createInterface({ input: proc.stdout }).on('line', (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l) })
  const ended = new Promise<void>((r) => proc.on('close', () => r()))
  return { dir, sock, proc, send: (m) => { proc.stdin.write(`${JSON.stringify(m)}\n`) }, log: () => fs.readFileSync(log, 'utf8').split('\n').filter((l) => l && !l.startsWith('pid ')),
    next: () => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no line from the relay within 10 s')), 10_000), got = (l: string) => { clearTimeout(t); resolve(JSON.parse(l)) }
      const l = lines.shift(); if (l !== undefined) got(l); else waiting.push(got)
    }),
    ask: () => asks(sock), open: () => fs.writeFileSync(gate, ''),
    end: async () => { proc.stdin.end(); await ended; fs.rmSync(dir, { recursive: true, force: true }) } }
}
/** One ask on the relay's socket, as the scenario tools make it: what it said. */
const asks = (sock: string): Promise<string> => new Promise((resolve, reject) => {
  let said = ''; const c = net.connect(sock, () => c.write('fresh\n')); c.on('data', (d) => { said += d }); c.on('end', () => resolve(said.trim())); c.on('error', reject)
})
const call = (id: number | string, name: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })
const listening = (r: Relay) => until('the relay\'s socket', () => fs.existsSync(r.sock))

test('the relay passes every message on as it is, both ways; asked, it closes the browser itself, once, and keeps the answer', async () => {
  const r = relay(); await listening(r)
  try {
    r.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }); assert.deepEqual(await r.next(), { jsonrpc: '2.0', id: 1, result: { saw: 'initialize', order: 1 } })
    assert.equal(await r.ask(), 'ok'); assert.deepEqual(r.log(), ['call initialize']) // no browser open yet (a session's first scenario): nothing to close
    r.send(call(2, 'browser_navigate')); assert.deepEqual((await r.next()).result, { saw: 'browser_navigate', order: 2 })
    assert.equal(await r.ask(), 'ok'); assert.deepEqual(r.log().slice(1), ['call browser_navigate', 'close-in', 'close-out'])
    assert.equal(await r.ask(), 'ok'); assert.equal(r.log().filter((l) => l === 'close-in').length, 1, 'closed already: not asked twice')
    // the close's answer stayed with the relay: the next line the tester gets is the answer to its own next step (the fourth thing the browser tools were sent)
    r.send(call(3, 'browser_snapshot')); assert.deepEqual(await r.next(), { jsonrpc: '2.0', id: 3, result: { saw: 'browser_snapshot', order: 4 } })
    // what it must not keep: a message of the tester's own, even one whose id reads like the relay's
    r.send(call('hq-fresh-1', 'browser_click')); assert.deepEqual(await r.next(), { jsonrpc: '2.0', id: 'hq-fresh-1', result: { saw: 'browser_click', order: 5 } })
    assert.equal(await r.ask(), 'ok'); assert.equal(r.log().filter((l) => l === 'close-in').length, 2, 'used again since: closed again')
  } finally { await r.end() }
})

test('a step the tester sends while the browser is closing waits for the close, so it never lands in the browser that is going', async () => {
  const r = relay('gate'); await listening(r)
  try {
    r.send(call(1, 'browser_navigate')); await r.next()
    const asked = r.ask(); await until('the close to reach the browser tools', () => r.log().includes('close-in'))
    r.send(call(2, 'browser_navigate')); r.open() // the next scenario's first step, then the close is let through
    assert.equal(await asked, 'ok'); assert.deepEqual(await r.next(), { jsonrpc: '2.0', id: 2, result: { saw: 'browser_navigate', order: 3 } })
    assert.deepEqual(r.log(), ['call browser_navigate', 'close-in', 'close-out', 'call browser_navigate'])
  } finally { await r.end() }
})

test('a browser that doesn\'t close, or refuses to: the relay says why, and goes on passing messages', async () => {
  const silent = relay('silent', { HQ_UITEST_CLOSE_MS: '1000' }); await listening(silent)
  try {
    silent.send(call(1, 'browser_navigate')); await silent.next()
    assert.equal(await silent.ask(), "failed the browser didn't close within 1 s")
    silent.send(call(2, 'browser_snapshot')); assert.equal((await silent.next()).id, 2)
  } finally { await silent.end() }
  const refused = relay('error'); await listening(refused)
  try {
    refused.send(call(1, 'browser_navigate')); await refused.next()
    assert.equal(await refused.ask(), 'failed Browser is busy')
    assert.equal(await refused.ask(), 'failed Browser is busy', 'still open: the next ask tries again')
  } finally { await refused.end() }
})

test('the relay ends with its tester, and the browser tools with it', async () => {
  const r = relay(); await listening(r)
  r.send(call(1, 'browser_navigate')); await r.next()
  const pid = Number(/^pid (\d+)$/m.exec(fs.readFileSync(path.join(r.dir, 'log'), 'utf8'))![1]); assert.doesNotThrow(() => process.kill(pid, 0))
  const code = new Promise((resolve) => r.proc.on('exit', resolve)); r.proc.stdin.end()
  assert.equal(await code, 0)
  await until('the browser tools to be gone', () => { try { process.kill(pid, 0); return false } catch { return true } })
  fs.rmSync(r.dir, { recursive: true, force: true })
})

/** The tester's host, stood in for: what it was asked, in order, and what `seen()` said as each ask came. */
async function hostStandIn(seen: () => unknown = () => null) {
  const asked: { what: string; body: any; seen: unknown }[] = []
  const server = http.createServer((q, s) => { let b = ''; q.on('data', (c) => { b += c }); q.on('end', () => {
    asked.push({ what: q.url!.slice(1), body: JSON.parse(b || '{}'), seen: seen() })
    s.end(JSON.stringify(q.url === '/start' ? { ok: true, url: 'http://localhost:1/' } : { ok: false, why: 'x' })) }) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { asked, ctrl: (server.address() as net.AddressInfo).port, end: () => new Promise((r) => server.close(r)) }
}
/** HQ's scenario tools, started as Claude Code starts them. */
async function tools(spec: Record<string, unknown>) {
  const client = new Client({ name: 'hq-test', version: '0.0.1' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [TOOLS, JSON.stringify({ sdk: sdk(), zod: zod(), ...spec })], stderr: 'pipe' }))
  const start = async (id: string) => { const r = await client.callTool({ name: 'start_scenario', arguments: { id } }) as { content: { text?: string }[]; isError?: boolean }
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError } }
  return { start, end: () => client.close() }
}

test('start_scenario has the browser closed first, then the app reset; with no relay to ask (no socket given) it resets the app as before', async () => {
  const r = relay(); await listening(r)
  const host = await hostStandIn(() => r.log().filter((l) => l === 'close-out').length), t = await tools({ ctrl: host.ctrl, ask: r.sock })
  try {
    assert.deepEqual(await t.start('s-01'), { text: 'The app is reset. Its address is http://localhost:1/ — open it with browser_navigate.', isError: false })
    r.send(call(1, 'browser_navigate')); await r.next() // the tester uses the browser in s-01
    assert.equal((await t.start('s-02')).isError, false)
    assert.deepEqual(host.asked, [{ what: 'start', body: { id: 's-01' }, seen: 0 }, { what: 'start', body: { id: 's-02' }, seen: 1 }]) // closed before the reset began
  } finally { await t.end(); await r.end(); await host.end() }
  const plain = await hostStandIn(), bare = await tools({ ctrl: plain.ctrl })
  try { assert.equal((await bare.start('s-03')).isError, false); assert.deepEqual(plain.asked, [{ what: 'start', body: { id: 's-03' }, seen: null }]) } finally { await bare.end(); await plain.end() }
})

test('a browser that can\'t be closed is a reset that failed: the tester is told to stop, the host is told why, and the app is not reset for it', async () => {
  const dir = folder(), host = await hostStandIn()
  // nobody to ask: the browser tools never started, or are gone
  const none = await tools({ ctrl: host.ctrl, ask: path.join(dir, 'fresh.sock'), askMs: 300 })
  try {
    const why = "the tester's browser couldn't be closed (its browser tools aren't running)"
    assert.deepEqual(await none.start('s-01'), { text: `HQ couldn't reset the app: ${why}. Stop now.`, isError: true })
    assert.deepEqual(host.asked, [{ what: 'cant', body: { id: 's-01', why }, seen: null }])
  } finally { await none.end(); fs.rmSync(dir, { recursive: true, force: true }) }
  // the browser tools refuse
  const r = relay('error'); await listening(r); const t = await tools({ ctrl: host.ctrl, ask: r.sock })
  try {
    r.send(call(1, 'browser_navigate')); await r.next()
    assert.match((await t.start('s-02')).text, /^HQ couldn't reset the app: the tester's browser couldn't be closed \(Browser is busy\)\. Stop now\.$/)
    assert.deepEqual(host.asked.map((a) => a.what), ['cant', 'cant']); assert.equal(host.asked[1]!.body.id, 's-02')
  } finally { await t.end(); await r.end(); await host.end() }
})

test('the relay may still be starting as a session\'s first scenario begins: start_scenario waits for its socket', async () => {
  const dir = folder(), host = await hostStandIn(), t = await tools({ ctrl: host.ctrl, ask: path.join(dir, 'fresh.sock'), askMs: 15_000 })
  let r: Relay | null = null
  try {
    const started = t.start('s-01') // nobody is listening yet
    r = relay('ok', {}, dir)
    assert.equal((await started).isError, false); assert.deepEqual(host.asked.map((a) => a.what), ['start'])
  } finally { await t.end(); await r?.end(); await host.end() }
})

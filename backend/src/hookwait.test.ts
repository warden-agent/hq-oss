// Bug 85: the PermissionRequest hook (hookwait.mjs), run here as Claude Code runs it (the hook's JSON in, HQ's answer out), against a
// stand-in backend that the test can keep away, bring up late, cut halfway through an answer, or have refuse the token.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, 'hookwait.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-hookwait-'))
const ends: (() => void)[] = []
after(() => { for (const f of ends) f(); fs.rmSync(tmp, { recursive: true, force: true }) })

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
})
const until = async <T>(what: string, fn: () => T | undefined | false, ms = 5000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 20)) }
}
const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
const REQUEST = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } })

/** A stand-in for HQ's hooks server, which takes the token in the X-HQ-Token header (Bug 87), or with `old`, only in the path as
 *  backends did before (anything else is a 404 there). `answer` gets the nth request it takes: 'die' drops it unanswered, else a
 *  status and body. `seen`: what it took, as `<token>|<body>`. */
function backend(port: number, answer: (n: number) => 'die' | { status: number; body: string }, old = false) {
  const seen: string[] = []
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c }); req.on('end', () => {
      const header = req.headers['x-hq-token'], inPath = /^\/hooks\/([^/]+)$/.exec(req.url ?? '')?.[1]
      const token = old ? inPath : req.url === '/hooks' ? header : undefined
      if (!token) { res.writeHead(404); res.end(); return }
      seen.push(`${token}|${body}`); const a = answer(seen.length)
      if (a === 'die') { req.socket.destroy(); return }
      res.writeHead(a.status, { 'content-type': 'application/json' }); res.end(a.body)
    })
  })
  const up = new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()))
  const stop = () => { srv.closeAllConnections(); srv.close() }; ends.push(stop)
  return { seen, up, stop }
}
/** An agent's folder with its token file, as HQ makes it. */
function agentFolder(token: string | null = 'tok-85'): { dir: string; tokenFile: string } {
  const dir = fs.mkdtempSync(path.join(tmp, 'agent-')), tokenFile = path.join(dir, 'token')
  if (token) fs.writeFileSync(tokenFile, token + '\n')
  return { dir, tokenFile }
}
/** One hook run, as Claude Code starts it from the command in settings.json. */
function hook(port: number, tokenFile: string, limitS: number) {
  const p = spawn(process.execPath, [SCRIPT, `http://127.0.0.1:${port}/hooks`, tokenFile, String(limitS)],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HQ_HOOKWAIT_RETRY_MS: '50' } })
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d })
  ends.push(() => { try { p.kill('SIGKILL') } catch { /* gone */ } })
  const done = new Promise<{ code: number | null; out: string; err: string }>((r) => p.on('close', (code) => r({ code, out, err })))
  p.stdin.end(REQUEST)
  return done
}
const decision = (out: string) => JSON.parse(out).hookSpecificOutput.decision as { behavior: string; message?: string }

test('HQ up: the hook\'s JSON goes to HQ with the agent\'s token, and HQ\'s answer comes back as it is', async () => {
  const port = await freePort(), b = backend(port, () => ({ status: 200, body: ALLOW })); await b.up
  const a = agentFolder(), r = await hook(port, a.tokenFile, 30)
  assert.equal(r.code, 0); assert.equal(r.out, ALLOW)
  assert.deepEqual(b.seen, [`tok-85|${REQUEST}`])
  assert.ok(!fs.existsSync(path.join(a.dir, 'hq-unreachable')))
})

test('a backend from before Bug 87, which reads the token only from the path, is answered too', async () => {
  const port = await freePort(), b = backend(port, () => ({ status: 200, body: ALLOW }), true); await b.up
  const a = agentFolder(), r = await hook(port, a.tokenFile, 30)
  assert.equal(r.out, ALLOW); assert.deepEqual(b.seen, [`tok-85|${REQUEST}`])
})

test('HQ down: the request waits, then goes through once HQ is back; it isn\'t refused and nothing is left behind', async () => {
  const port = await freePort(), a = agentFolder(), r = hook(port, a.tokenFile, 30)
  // Something must be listening for the script to have tried: a backend that drops the first requests unanswered shows the retries,
  // the same way a restart does halfway through an answer.
  const b = backend(port, (n) => n < 3 ? 'die' : { status: 200, body: ALLOW }); await b.up
  const got = await r
  assert.equal(got.out, ALLOW); assert.equal(b.seen.length, 3)
  assert.ok(b.seen.every((s) => s === `tok-85|${REQUEST}`))
  assert.ok(!fs.existsSync(path.join(a.dir, 'hq-unreachable')))
})

test('HQ away past the limit: the agent is told to stop and wait (not a fault, not a no), and a note for HQ is left', async () => {
  const port = await freePort(), a = agentFolder(), started = Date.now()
  const r = await hook(port, a.tokenFile, 1)
  assert.ok(Date.now() - started >= 900, 'it waited')
  const d = decision(r.out); assert.equal(d.behavior, 'deny')
  assert.match(d.message!, /unreachable/); assert.match(d.message!, /end your turn/); assert.match(d.message!, /HQ sends you a message when it's back/)
  assert.ok(!r.out.includes('tok-85') && !r.err.includes('tok-85'), 'the token is never shown') // Bug 87
  assert.ok(fs.existsSync(path.join(a.dir, 'hq-unreachable')))
})

test('a 502 (what a proxy says for a backend that is down) is waited out too', async () => {
  const port = await freePort(), b = backend(port, (n) => n < 2 ? { status: 502, body: '' } : { status: 200, body: ALLOW }); await b.up
  const a = agentFolder(), r = await hook(port, a.tokenFile, 30)
  assert.equal(r.out, ALLOW); assert.equal(b.seen.length, 2)
})

test('what must not wait: a refused token or a missing token file ends the session\'s requests at once; other errors are said once', async () => {
  const port = await freePort(), b = backend(port, (n) => n === 1 ? { status: 403, body: '{"error":"bad token"}' } : { status: 500, body: '' }); await b.up
  const a = agentFolder()
  const refused = await hook(port, a.tokenFile, 30)
  assert.equal(decision(refused.out).behavior, 'deny'); assert.match(decision(refused.out).message!, /ended this session's access/)
  const broken = await hook(port, a.tokenFile, 30)
  assert.match(decision(broken.out).message!, /HTTP 500/); assert.equal(b.seen.length, 2) // no retry of either
  const gone = agentFolder(null), noToken = await hook(port, gone.tokenFile, 30)
  assert.match(decision(noToken.out).message!, /ended this session's access/); assert.equal(b.seen.length, 2) // never sent
  for (const f of [a, gone]) assert.ok(!fs.existsSync(path.join(f.dir, 'hq-unreachable')))
})

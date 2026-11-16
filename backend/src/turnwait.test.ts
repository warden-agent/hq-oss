// Bug 112: the Bash PreToolUse hook of engineers and the Launch helper (turnwait.mjs), run here as Claude Code runs it (the hook's JSON in, HQ's answer out),
// against a stand-in backend that the test can keep away, bring up late, cut halfway through an answer, hold, or have refuse the token.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, 'turnwait.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-turnwait-'))
const ends: (() => void)[] = []
after(() => { for (const f of ends) f(); fs.rmSync(tmp, { recursive: true, force: true }) })

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
})
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Still unanswered after `ms`? */
const pendingAfter = (p: Promise<unknown>, ms: number): Promise<boolean> => Promise.race([p.then(() => false), tick(ms).then(() => true)])
const bash = (command: string, more: Record<string, unknown> = {}, mode = 'acceptEdits') =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', permission_mode: mode, tool_input: { command, ...more } })

/** A stand-in for HQ's hooks server. `answer` gets the nth request it takes: 'die' drops it unanswered (a restart), 'hold' keeps it open (waiting its turn)
 *  until `release()`, else a status and body. `seen`: what it took, as `<token>|<body>`; `dropped`: how many held requests the hook itself gave up on. */
function backend(port: number, answer: (n: number) => 'die' | 'hold' | { status: number; body: string }) {
  const seen: string[] = [], held: http.ServerResponse[] = []; let dropped = 0
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c }); req.on('end', () => {
      if (req.url !== '/hooks' || !req.headers['x-hq-token']) { res.writeHead(404); res.end(); return }
      seen.push(`${String(req.headers['x-hq-token'])}|${body}`); const a = answer(seen.length)
      if (a === 'die') { req.socket.destroy(); return }
      if (a === 'hold') { held.push(res); res.on('close', () => { if (!res.writableEnded) dropped++ }); return }
      res.writeHead(a.status, { 'content-type': 'application/json' }); res.end(a.body)
    })
  })
  const up = new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()))
  const stop = () => { srv.closeAllConnections(); srv.close() }; ends.push(stop)
  const release = () => { for (const res of held.splice(0)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') } }
  return { seen, up, stop, release, dropped: () => dropped }
}
/** HQ's folder as the hook sees it: an agent's token file, and the file of each project's test command. */
function hqFolder(o: { token?: string | null; cmds?: string } = {}): { tokenFile: string; cmdsFile: string } {
  const dir = fs.mkdtempSync(path.join(tmp, 'hq-')), tokenFile = path.join(dir, 'token'), cmdsFile = path.join(dir, 'test-cmds.json')
  if (o.token !== null) fs.writeFileSync(tokenFile, (o.token ?? 'tok-112') + '\n')
  if (o.cmds !== undefined) fs.writeFileSync(cmdsFile, o.cmds)
  return { tokenFile, cmdsFile }
}
/** One hook run, as Claude Code starts it from the command in settings.json. `took`: how long until it answered. */
function hook(port: number, f: { tokenFile: string; cmdsFile: string }, input: string, o: { awayS?: number; totalS?: number; repo?: string } = {}) {
  const args = [SCRIPT, `http://127.0.0.1:${port}/hooks`, f.tokenFile, String(o.awayS ?? 30), String(o.totalS ?? 60), f.cmdsFile, o.repo ?? 'repo-a']
  const p = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HQ_HOOKWAIT_RETRY_MS: '50' } }), started = Date.now()
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d })
  ends.push(() => { try { p.kill('SIGKILL') } catch { /* gone */ } })
  const done = new Promise<{ code: number | null; out: string; err: string; took: number }>((r) => p.on('close', (code) => r({ code, out, err, took: Date.now() - started })))
  p.stdin.end(input)
  return done
}
const HELD = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'from HQ' } })

test('HQ up: the hook\'s JSON goes to HQ with the agent\'s token in the header, and HQ\'s answer comes back as it is, once HQ gives it', async () => {
  const port = await freePort(), b = backend(port, (n) => n === 1 ? { status: 200, body: HELD } : 'hold'); await b.up
  const f = hqFolder(), input = bash('npm test'), r = await hook(port, f, input)
  assert.equal(r.code, 0); assert.equal(r.out, HELD); assert.deepEqual(b.seen, [`tok-112|${input}`])
  assert.ok(!r.out.includes('tok-112') && !r.err.includes('tok-112'), 'the token is never shown') // Bug 87
  const held = hook(port, f, input) // HQ keeps it in its line (Bug 76): the hook waits as long as HQ does, and asks only once
  assert.equal(await pendingAfter(held, 600), true); b.release()
  assert.equal((await held).out, '{}'); assert.equal(b.seen.length, 2)
})

test('HQ down: a build or a full test run waits and asks again until HQ answers; any other command goes ahead at once', async () => {
  const port = await freePort(), f = hqFolder({ cmds: JSON.stringify({ 'repo-a': 'node scripts/check.mjs --all', 'repo-b': './verify.sh' }) })
  for (const light of ['git status', 'npm run lint', 'node --test test/a.test.js', './verify.sh']) { // the last is another project's test command
    const r = await hook(port, f, bash(light)); assert.equal(r.out, '{}', light); assert.equal(r.code, 0); assert.ok(r.took < 2000, `${light}: ${r.took} ms`)
  }
  // a server started in the background and a command in plan mode never take a turn (heavy.ts), so they don't wait for HQ either
  assert.equal((await hook(port, f, bash('npm test', { run_in_background: true }))).out, '{}'); assert.equal((await hook(port, f, bash('npm test', {}, 'plan'))).out, '{}')
  const runs = [bash('npm test'), bash('cd web && npm run build'), bash('node scripts/check.mjs --all 2>&1 | tail -5')] // the last: this project's own test command
  const waiting = runs.map((input) => hook(port, f, input))
  for (const w of waiting) assert.equal(await pendingAfter(w, 400), true, 'no answer while HQ is away: the command hasn\'t started')
  const b = backend(port, () => ({ status: 200, body: '{}' })); await b.up // HQ is back
  for (const w of waiting) { const r = await w; assert.equal(r.out, '{}'); assert.equal(r.code, 0) }
  assert.deepEqual(b.seen.sort(), runs.map((input) => `tok-112|${input}`).sort()) // each reached HQ, so each takes its place in HQ's line
})

test('a restart while HQ holds a command in its line: the dropped request is asked again, not taken for an answer', async () => {
  const port = await freePort(), b = backend(port, (n) => n < 3 ? 'die' : { status: 200, body: '{}' }); await b.up
  const input = bash('npm test'), r = await hook(port, hqFolder(), input)
  assert.equal(r.out, '{}'); assert.deepEqual(b.seen, [input, input, input].map((i) => `tok-112|${i}`))
  const light = await hook(port, hqFolder(), bash('ls')) // HQ went while it asked: a small command isn't worth the wait
  assert.equal(light.out, '{}'); assert.equal(b.seen.length, 4)
  const port2 = await freePort(), proxy = backend(port2, (n) => n < 2 ? { status: 502, body: '' } : { status: 200, body: '{}' }); await proxy.up
  assert.equal((await hook(port2, hqFolder(), input)).out, '{}'); assert.equal(proxy.seen.length, 2) // a 502 is "down" too
})

test('nothing waits for good: after the limit without HQ the run goes ahead, and a hook HQ holds too long lets go of its place', async () => {
  const port = await freePort(), f = hqFolder()
  const r = await hook(port, f, bash('npm test'), { awayS: 1 })
  assert.equal(r.out, '{}'); assert.equal(r.code, 0); assert.ok(r.took >= 900 && r.took < 5000, `waited ${r.took} ms`)
  const b = backend(port, () => 'hold'); await b.up
  const kept = await hook(port, f, bash('npm test'), { totalS: 1 })
  assert.equal(kept.out, '{}'); assert.ok(kept.took >= 900 && kept.took < 5000, `held ${kept.took} ms`)
  for (let i = 0; i < 100 && !b.dropped(); i++) await tick(20)
  assert.equal(b.dropped(), 1, 'HQ sees the hook go, and gives its place away')
})

test('what must not wait: a token HQ ended, a missing token file, an error from HQ, a file of test commands that can\'t be read', async () => {
  const port = await freePort(), b = backend(port, (n) => n === 1 ? { status: 403, body: '{"error":"bad token"}' } : { status: 500, body: '' }); await b.up
  const f = hqFolder(), input = bash('npm test')
  for (const n of [1, 2]) { const r = await hook(port, f, input); assert.equal(r.out, '{}'); assert.equal(r.code, 0); assert.equal(b.seen.length, n) } // asked once each
  const gone = await hook(port, hqFolder({ token: null }), input); assert.equal(gone.out, '{}'); assert.equal(b.seen.length, 2) // never sent
  b.stop()
  const down = await freePort()
  for (const cmds of [undefined, 'not json', '[]', '{"repo-a":7}']) { // HQ down and no command on file: only the program's name says what's heavy
    assert.equal((await hook(down, hqFolder({ cmds }), bash('./verify.sh'))).out, '{}', String(cmds))
    assert.equal(await pendingAfter(hook(down, hqFolder({ cmds }), input, { awayS: 2 }), 500), true, String(cmds))
  }
  assert.equal((await hook(down, hqFolder(), 'not json')).out, '{}') // a hook it can't read
})

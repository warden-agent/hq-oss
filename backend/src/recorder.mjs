// The recorder: everything HQ writes down while a scenario runs against an app, with no model and no tokens. It runs inside HQ's test sandbox, in a
// throwaway checkout, next to the app: localhost only, none of the user's credentials. HQ's scripted runner (scenariorun.mjs) and the UI tester's host
// both drive a browser through it. One clock: everything is stamped with this process's Date.now(), on HQ's machine.
// - The app starts from the project's test setup (testsetup.ts): its production start, on a clean seed. The seed command runs once, on state paths HQ has
//   emptied first, and what it wrote is kept (out/seed/); every reset stops the app, puts that copy back and starts the app again. Library reads its files
//   only when it starts, so swapping them under a running server would do nothing.
// - A small proxy stands in front of the app's page: the browser only ever sees the proxy's address, which stays the same across resets. Every request
//   through it is one line in api.jsonl: method, path, status, when, how long, and a hash of the body (never the body). Streams (Server-Sent Events) are
//   piped as they come and marked.
// - Every line the app prints goes to server.log, stamped. Console errors and failed requests from the browser page go to browser.jsonl.
// - After each action, once the app has gone quiet, the state paths are copied to snapshots/<n>/ when they changed (snaps.jsonl says which). HQ diffs
//   them afterwards (timeline.ts).
// Plain Node, no imports from HQ. Each of the app's parts runs in a process group of its own, so a reset ends all of it with no `ps` (Bug 170: `npm start`
// kept its port), and it still ends with the caller, as appstart.mjs says.
// spec: { parts: [{ name, cwd, run, port, build? }], show, startMs, root, out, snapshot: [paths in root], seed: command }
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { startApp, stopApp } from './appstart.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** How long the app must have had no request in flight and none new before an action counts as settled, and the most a settle waits. Not a flag: a wait. */
const QUIET_MS = Number(process.env.HQ_SETTLE_QUIET_MS) || 300
const SETTLE_MAX_MS = Number(process.env.HQ_SETTLE_MAX_MS) || 10_000
const STREAM = /^text\/event-stream\b/i

/** Runs a shell command in `cwd`; resolves with its exit code and the last of its output. */
function sh(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const k = spawn(command, { cwd, shell: '/bin/bash', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' } })
    let out = ''; const take = (b) => { out = (out + b.toString()).slice(-3000) }
    k.stdout.on('data', take); k.stderr.on('data', take)
    const t = setTimeout(() => { out += `\n(stopped after ${Math.round(timeoutMs / 1000)} s)`; try { k.kill('SIGKILL') } catch { /* gone */ } }, timeoutMs)
    k.on('error', (e) => { clearTimeout(t); resolve({ code: -1, output: e.message }) })
    k.on('exit', (code, sig) => { clearTimeout(t); resolve({ code: code ?? (sig ? 1 : 0), output: out.trim() }) })
  })
}
/** A state path's own files, and for a SQLite file its -wal and -shm, which hold what isn't in the main file yet. */
const withSidecars = (rel) => [rel, `${rel}-wal`, `${rel}-shm`, `${rel}-journal`]
/** Copies the state paths from `from` to `to` (both roots), only what exists. */
function copyState(paths, from, to) {
  for (const rel of paths.flatMap(withSidecars)) {
    const src = path.join(from, rel); if (!fs.existsSync(src)) continue
    const dst = path.join(to, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.cpSync(src, dst, { recursive: true })
  }
}
const clearState = (paths, root) => { for (const rel of paths.flatMap(withSidecars)) fs.rmSync(path.join(root, rel), { recursive: true, force: true }) }
/** A fingerprint of the state paths: every file's path and contents. */
function stateHash(paths, root) {
  const h = createHash('sha256')
  const walk = (abs, rel) => {
    let st; try { st = fs.statSync(abs) } catch { return }
    if (st.isDirectory()) { for (const n of fs.readdirSync(abs).sort()) walk(path.join(abs, n), `${rel}/${n}`); return }
    h.update(`${rel}\0`); h.update(fs.readFileSync(abs)); h.update('\0')
  }
  for (const rel of paths.flatMap(withSidecars)) walk(path.join(root, rel), rel)
  return h.digest('hex')
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

/** Starts recording: seeds the state, builds and starts the app, puts the proxy in front. `{ rec }` when it's up, else `{ kind, why, output? }`:
 *  'no_seed' (the seed command failed), 'no_build', 'no_start' or 'skipped' (as startApp says). */
export async function startRecording(spec) {
  const root = spec.root
  // The logs' folder: spec.out, until `cut` names another (the UI tester's host gives each scenario its own). The seed's copy stays in spec.out.
  let out = spec.out, files = {}, serverLog = -1
  const openLogs = (dir) => {
    out = dir; fs.mkdirSync(path.join(out, 'snapshots'), { recursive: true })
    files = Object.fromEntries(['actions', 'api', 'browser', 'snaps'].map((n) => [n, fs.openSync(path.join(out, `${n}.jsonl`), 'a')]))
    serverLog = fs.openSync(path.join(out, 'server.log'), 'a')
  }
  const log = (n, o) => { try { fs.writeSync(files[n], `${JSON.stringify(o)}\n`) } catch { /* closed: the run is over */ } }
  const onLine = (part, line, at) => { try { fs.writeSync(serverLog, `${at}\t${part}\t${line.slice(0, 2000)}\n`) } catch { /* closed */ } }
  const closeLogs = () => { for (const fd of [...Object.values(files), serverLog]) { try { fs.closeSync(fd) } catch { /* closed */ } } }
  openLogs(spec.out)

  // The seed: written once by its command on empty state paths, then kept to put back at every reset.
  const seedDir = path.join(spec.out, 'seed')
  clearState(spec.snapshot, root)
  const s = await sh(spec.seed, root, 120_000)
  if (s.code !== 0) { closeLogs(); return { kind: 'no_seed', why: `the seed command failed (code ${s.code})`, output: s.output } }
  if (!spec.snapshot.some((rel) => fs.existsSync(path.join(root, rel)))) {
    closeLogs(); return { kind: 'no_seed', why: `the seed command wrote none of ${spec.snapshot.join(', ')}`, output: s.output }
  }
  copyState(spec.snapshot, root, seedDir)
  for (const p of spec.parts.filter((x) => x.build)) {
    const b = await sh(p.build, p.cwd, 10 * 60_000)
    if (b.code !== 0) { closeLogs(); return { kind: 'no_build', why: `building its ${p.name} part failed (\`${p.build}\`, code ${b.code})`, output: b.output } }
  }

  let app = await startApp(spec, { onLine, group: true })
  if (!app.port) { await stopApp(app.kids); closeLogs(); return { kind: app.kind, why: app.why, output: app.output } }
  let target = app.port, down = false // `down`: during a reset, when there is no app to send a request to

  // The proxy: every request is piped to the app as it comes, and its reply back; a stream's line is written when its reply starts, the rest when it ends.
  let seq = 0, inflight = 0, lastActivity = Date.now(), action = null, era = 0 // `era`: which log folder is open (cut): a call is written where it began, or not at all
  const busy = new Set()
  const server = http.createServer((req, res) => {
    const call = { i: ++seq, at: Date.now(), method: req.method, path: req.url, action }, chunks = [], began = era
    inflight++; busy.add(call.i); lastActivity = Date.now()
    let done = false
    const finish = (extra) => {
      if (done) return; done = true
      if (busy.delete(call.i)) inflight--
      lastActivity = Date.now(); const end = Date.now()
      if (began !== era) return // it began in an earlier scenario (a stream the last page left open, ended by this one's reset): not this recording's
      log('api', { ...call, ...extra, end, ms: end - call.at, body: chunks.length ? createHash('sha256').update(Buffer.concat(chunks)).digest('hex').slice(0, 16) : null })
    }
    req.on('data', (c) => { if (chunks.length < 1000) chunks.push(c) })
    if (down) { res.writeHead(503, { 'content-type': 'text/plain' }).end('HQ is resetting the app'); return finish({ status: 503, resetting: true }) }
    const up = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: { ...req.headers, host: `localhost:${target}` } }, (r) => {
      const type = String(r.headers['content-type'] ?? ''), stream = STREAM.test(type)
      const headers = { ...r.headers }
      if (typeof headers.location === 'string') headers.location = headers.location.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${target}`), '') // stay on the proxy
      res.writeHead(r.statusCode ?? 502, headers)
      if (stream) { if (busy.delete(call.i)) inflight-- } // an open stream is not work in flight: it never ends by itself
      r.pipe(res)
      const over = () => finish({ status: r.statusCode, type: type.split(';')[0] || null, stream })
      r.on('end', over); r.on('error', over); res.on('close', over)
    })
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`HQ's proxy couldn't reach the app: ${e.code ?? e.message}`)
      finish({ status: 502, error: e.code ?? e.message })
    })
    req.on('aborted', () => up.destroy())
    req.pipe(up)
  })
  server.on('upgrade', (req, socket, head) => { // a WebSocket: passed through, written down once
    log('api', { i: ++seq, at: Date.now(), end: Date.now(), ms: 0, method: req.method, path: req.url, action, status: 101, stream: true, body: null })
    const up = net.connect(target, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries({ ...req.headers, host: `localhost:${target}` }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
      if (head?.length) up.write(head); up.pipe(socket); socket.pipe(up)
    })
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy())
  })
  const proxyPort = await freePort()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(proxyPort, '127.0.0.1', resolve) })
  const sockets = new Set(); server.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)) })

  let snaps = 0, lastHash = null
  /** Copies the state paths when they changed since the last snapshot. Returns its number. */
  const snapshot = (label) => {
    const n = snaps++, hash = stateHash(spec.snapshot, root), changed = hash !== lastHash
    if (changed) copyState(spec.snapshot, root, path.join(out, 'snapshots', String(n).padStart(4, '0')))
    log('snaps', { n, at: Date.now(), label, changed, hash: hash.slice(0, 16), action }); lastHash = hash
    return n
  }
  let marks = 0
  const rec = {
    url: `http://127.0.0.1:${proxyPort}`,
    seedDir,
    /** The ports a browser on this app may open: the proxy's and the app's parts' (a reset starts them on the same ones). */
    ports: () => [proxyPort, ...Object.values(app.ports ?? {})],
    /** Stamps the start or end of an action. A start makes it the action later requests belong to. */
    mark(label, phase, extra = {}) {
      if (phase === 'start') action = ++marks
      log('actions', { at: Date.now(), phase, label, action, ...extra }); return action
    },
    /** Waits until no request is in flight and none has started for a while (at most SETTLE_MAX_MS), then snapshots. */
    async settleAndSnapshot(label) { // quiet counts from the action's end too: a page may send its request a moment after a click (a debounce)
      const t0 = Date.now()
      while (Date.now() - t0 < SETTLE_MAX_MS) { if (inflight === 0 && Date.now() - Math.max(lastActivity, t0) >= QUIET_MS) break; await sleep(50) }
      return snapshot(label)
    },
    /** One action: stamped, run, settled and snapshotted. `fn`'s error is passed on after the end is stamped. */
    async action(label, fn) {
      rec.mark(label, 'start'); let err = null
      try { await fn() } catch (e) { err = e }
      await rec.settleAndSnapshot(label)
      rec.mark(label, 'end', err ? { ok: false, why: String(err.message ?? err).split('\n')[0].slice(0, 300) } : { ok: true })
      if (err) throw err
    },
    /** From here on everything is written to `dir`, a folder of its own (made here): one scenario of many against the same app, with its own actions and
     *  snapshots counted from the start. The caller resets next, so the folder's first snapshot is the seed. */
    cut(dir) { closeLogs(); openLogs(dir); era++; snaps = 0; lastHash = null; marks = 0; action = null },
    /** Something the caller's browser said that HQ didn't see itself (a console error the browser tools reported): one line in browser.jsonl. */
    seen(o) { log('browser', { at: Date.now(), ...o, action }) },
    /** Console errors, uncaught errors and failed requests of a Playwright page the caller owns. */
    attach(page) {
      page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) log('browser', { at: Date.now(), kind: 'console', text: m.text().slice(0, 500), action }) })
      page.on('pageerror', (e) => log('browser', { at: Date.now(), kind: 'console', text: String(e.message).slice(0, 500), action }))
      page.on('requestfailed', (r) => {
        const why = r.failure()?.errorText ?? ''; if (/ERR_ABORTED/.test(why)) return // the page moved on before it finished
        let p = r.url(), host = null; try { const u = new URL(p); p = u.pathname + u.search; host = u.hostname } catch { /* as it is */ }
        if (host && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) return log('browser', { at: Date.now(), kind: 'outside', host, action }) // no internet in here: a font, an analytics script
        log('browser', { at: Date.now(), kind: 'failed_request', method: r.request?.()?.method?.() ?? r.method(), path: p, text: why.replace(/^net::/, ''), action })
      })
    },
    /** Stops the app, puts the seed back, starts it again on the same ports behind the same proxy address, and takes the first snapshot of what follows. */
    async reset() {
      rec.mark('reset', 'start'); down = true
      await stopApp(app.kids, Object.values(app.ports ?? {}))
      clearState(spec.snapshot, root); copyState(spec.snapshot, seedDir, root)
      const again = await startApp(spec, { ports: app.ports, onLine, group: true })
      if (!again.port) { await stopApp(again.kids); rec.mark('reset', 'end', { ok: false, why: again.why }); throw new Error(`the app didn't start again after the reset: ${again.why}`) }
      app = again; target = again.port; down = false; lastHash = null
      const n = snapshot('reset'); rec.mark('reset', 'end', { ok: true }); return n
    },
    /** Ends the app and the proxy, and closes the logs. */
    async stop() {
      server.close(); for (const c of sockets) c.destroy()
      await stopApp(app.kids, Object.values(app.ports ?? {}))
      closeLogs()
    },
  }
  snapshot('start')
  return { rec }
}

// Starts an app's parts as its launch recipe says, inside HQ's test sandbox, for whatever then opens its pages: HQ's look before a merge (smokerun.mjs) and
// the tester's browser tools (testermcp.mjs). Plain Node, no imports from HQ. The parts are children in the caller's process group, so whoever ran the caller
// ends them with it; or, for a caller that stops and starts the app again itself (`group`), each in a group of its own that ends with the caller.
// spec: { parts: [{ name, cwd, run, port: number | 'auto' }], show, startMs }
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** A part in a process group of its own (Bug 170): a stop then reaches everything the part started with no `ps`, which HQ's test sandbox refuses, so
 *  `npm start` (a shell running npm running node) goes whole and frees its port. A watcher in the group reads a pipe from this process and ends the group
 *  when the pipe closes, so the part still ends when this process ends, however it ends (SIGKILL included), as it did in this process's group. */
const OWN_GROUP = 'exec 3<&0 0</dev/null; (read -r -u 3 _; kill -KILL 0) & exec 3<&-; exec /bin/bash -c "$1"'
const grouped = new WeakSet()
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const taken = (port) => Promise.all(['127.0.0.1', '::1'].map((host) => new Promise((resolve) => {
  const s = net.connect({ host, port }), end = (b) => { s.destroy(); resolve(b) }
  s.once('connect', () => end(true)); s.once('error', () => end(false)); s.setTimeout(500, () => end(false))
}))).then((a) => a.some(Boolean))
const answers = async (port) => {
  try { const r = await fetch(`http://localhost:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }); await r.body?.cancel(); return true } catch { return false }
}

/** Starts the parts and waits for the page's port to answer and every other part to listen on its own. `{ port, kids, ports }` when it's up. `o.ports`:
 *  the port of each part, as a start before this one picked them (a restart). `o.onLine(part, line, at)`: every line the parts print, as it arrives.
 *  `o.group`: each part in a process group of its own, for stopApp to end whole. Otherwise `{ kind: 'skipped', why }` (a port the project
 *  hard-wires is taken: nothing about the code) or `{ kind: 'no_start', why, output }` (a part stopped, or one didn't answer in time), with `kids` to end. */
export async function startApp(spec, o = {}) {
  const kids = [], tails = new Map()
  const tail = (p) => { const t = (tails.get(p.name) ?? '').trim(); return t ? `${spec.parts.length > 1 ? `[${p.name}]\n` : ''}${t}` : '' }
  const output = () => spec.parts.map(tail).filter(Boolean).join('\n').slice(-3000)
  // Ports: one the project hard-wires must be free (the user's own preview of this app may hold it: then HQ can't look, and says so); the rest are picked here.
  const ports = { ...o.ports }
  for (const p of spec.parts) {
    if (p.port === 'auto' || o.ports) continue
    if (await taken(p.port)) return { kind: 'skipped', why: `port ${p.port}, which its ${p.name} part always uses, is taken (the app may be running in the preview)`, kids }
    ports[p.name] = p.port
  }
  for (const p of spec.parts) if (ports[p.name] === undefined) ports[p.name] = await freePort()
  const shared = Object.fromEntries(Object.entries(ports).map(([n, p]) => [`HQ_PORT_${n.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, String(p)]))
  let exited = null
  for (const p of spec.parts) { // as the preview's supervisor starts them (supervise.mjs): bash, PORT, the other parts' ports, no browser of its own
    const env = { ...process.env, ...shared, PORT: String(ports[p.name]), BROWSER: 'none' }
    const k = o.group ? spawn('/bin/bash', ['-c', OWN_GROUP, 'hq-part', p.run], { cwd: p.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(p.run, { cwd: p.cwd, shell: '/bin/bash', env, stdio: ['ignore', 'pipe', 'pipe'] })
    if (o.group) { grouped.add(k); k.stdin.on('error', () => {}) } // the watcher's pipe: nothing is written to it, it only closes
    let part = '' // a line split across two reads is passed on whole
    const keep = (buf) => {
      const s = buf.toString().replace(ANSI, ''); tails.set(p.name, ((tails.get(p.name) ?? '') + s).slice(-3000))
      if (!o.onLine) return
      const lines = (part + s).split('\n'); part = lines.pop() ?? ''; const at = Date.now()
      for (const l of lines) if (l.trim()) o.onLine(p.name, l.trimEnd(), at)
    }
    k.stdout.on('data', keep); k.stderr.on('data', keep)
    k.on('exit', (code, sig) => { exited ??= { part: p.name, code: code ?? sig } }); k.on('error', (e) => { exited ??= { part: p.name, code: e.message } })
    kids.push(k)
  }
  // Up when the page's own port answers; an app that picks its port itself (Vite) prints it, and that counts after 3 s, as in the preview.
  const printed = () => [...(tails.get(spec.show) ?? '').matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/g)].map((m) => Number(m[1]))
  // Bug 388: every other part must be listening on its port too, moved or not: an api still opening its database left the look a page whose calls got 502s,
  // on main as well, so nothing looked new and the look passed. Bug 374: a moved part that takes its port from somewhere HQ didn't see asks for the old
  // one and is refused it; kept alive by a watcher (nodemon), it would leave an app that "started" with that part missing. A part already up costs a connect.
  const need = spec.parts.map((p) => p.name).filter((n) => n !== spec.show)
  let missing = null
  for (const t0 = Date.now(); ;) {
    if (exited) return { kind: 'no_start', why: `its ${exited.part} part stopped (${exited.code}) while the app was starting`, output: output(), kids }
    if (Date.now() - t0 > spec.startMs) {
      const secs = Math.round(spec.startMs / 1000)
      return { kind: 'no_start', why: missing ? `its ${missing} part wasn't listening on port ${ports[missing]} after ${secs} s` : `nothing answered on port ${ports[spec.show]} within ${secs} s`,
        output: output(), kids }
    }
    for (const c of [ports[spec.show], ...(Date.now() - t0 > 3000 ? printed() : [])]) {
      if (!await answers(c)) continue
      missing = null; for (const n of need) if (!await taken(ports[n])) { missing = n; break }
      if (!missing) return { port: c, kids, ports }
      break
    }
    await sleep(200)
  }
}

/** Every process under `pid`, deepest last. */
function under(pid) {
  const r = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }); if (r.error || !r.stdout) return []
  const kids = new Map()
  for (const [c, p] of r.stdout.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))) kids.set(p, [...(kids.get(p) ?? []), c])
  const out = [], todo = [pid]
  while (todo.length) { const p = todo.shift(); for (const c of kids.get(p) ?? []) { out.push(c); todo.push(c) } }
  return out
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
/** Ends the parts startApp started, each with everything under it (`npm start` runs a shell that runs node: the shell alone would leave the server
 *  holding its port), and waits until `ports` no longer answer. SIGTERM first, SIGKILL to what's left after `graceMs`. A part in a group of its own goes
 *  as its whole group (a negative pid), even when its first process has already ended; any other, with what `ps` finds under it. */
export async function stopApp(kids, ports = [], graceMs = 3000) {
  const all = kids.flatMap((k) => !k.pid ? [] : grouped.has(k) ? [-k.pid] : k.exitCode === null && k.signalCode === null ? [k.pid, ...under(k.pid)] : [])
  for (const p of all) { try { process.kill(p, 'SIGTERM') } catch { /* gone */ } }
  for (const t0 = Date.now(); all.some(alive) && Date.now() - t0 < graceMs;) await sleep(50)
  for (const p of all.filter(alive)) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } }
  for (const t0 = Date.now(); Date.now() - t0 < graceMs;) { if (!(await Promise.all(ports.map(taken))).some(Boolean)) break; await sleep(50) }
}

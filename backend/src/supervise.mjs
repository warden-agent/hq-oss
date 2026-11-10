// The live preview's supervisor: runs one app's parts (an API and a web page, say) in the preview's tmux pane. HQ writes a spec
// (apprun.ts supervisorSpec) and runs `node supervise.mjs <spec.json>`. Installs run first, one at a time; then every part
// starts. Output is prefixed with the part's name when there's more than one. As soon as any part exits, the others are
// stopped and this exits non-zero, so the pane dies and HQ reports the app as crashed (spike S2, 2026-10-30): a half-running
// app never looks fine.
// Bug 77: when this ends, however it ends (HQ's Stop, a part that exited, its terminal gone), everything the app started
// ends with it: see `mine`. A signal to the process group alone left behind what ignored it, what was slow, and whatever had
// put itself in a group or session of its own (a browser a server opened, a shell job, a daemon).
// Plain Node with no imports from HQ: it runs with the backend's node but outside the backend.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const many = spec.parts.length > 1
const say = (name, line) => console.log(many ? `[${name}] ${line}` : line)
const lines = (name) => (buf) => { for (const l of buf.toString().split('\n')) if (l.trim()) say(name, l) }
const kids = []
let ending = false

/** How long what the app started gets to shut down by itself (SIGTERM) before it is killed. */
const GRACE_MS = Number(process.env.HQ_PREVIEW_GRACE_MS) || 5000
const me = process.pid
/** Every running process: its parent, group, terminal and when it began (which tells a reused pid from the one seen before). Null when ps can't be run. */
function procs() {
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,tty=,stat=,lstart='], { encoding: 'utf8', maxBuffer: 1 << 26 })
  if (r.error || !r.stdout) return null
  return r.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 6 && Number(f[0]) > 0 && Number(f[0]) !== r.pid && !f[4].startsWith('Z'))
    .map(([pid, ppid, pgid, tty, , ...began]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), tty, began: began.join(' ') }))
}
const seen = new Map() // pid → when it began: everything found under this app so far
/** What this app started and still runs: everything under this process now; everything that ever was (a server's helper stays
 *  the app's after the server that started it has gone); and, when this leads the pane, whatever is in its process group or on
 *  its terminal, with all of that under those. Run by hand in someone's terminal, the last two would be their shell: left out. */
function mine() {
  const all = procs(); if (!all) return null
  const self = all.find((p) => p.pid === me), kidsOf = new Map()
  for (const p of all) kidsOf.set(p.ppid, [...(kidsOf.get(p.ppid) ?? []), p])
  const leads = !!self && self.pgid === me, tty = leads && !/^\?+$/.test(self.tty) && all.find((p) => p.pid === self.ppid)?.tty !== self.tty ? self.tty : null
  const out = new Map(), todo = all.filter((p) => p.pid !== me && (p.ppid === me || seen.get(p.pid) === p.began || (leads && p.pgid === me) || (tty && p.tty === tty)))
  while (todo.length) { const p = todo.pop(); if (p.pid === me || out.has(p.pid)) continue; out.set(p.pid, p); todo.push(...(kidsOf.get(p.pid) ?? [])) }
  for (const [pid, began] of seen) if (out.get(pid)?.began !== began) seen.delete(pid) // gone, or its pid is someone else's now
  for (const p of out.values()) seen.set(p.pid, p.began)
  return [...out.values()]
}
const signal = (ps, sig) => { for (const p of ps) { try { process.kill(p.pid, sig) } catch { /* gone */ } } }
/** For HQ's Events tab: what had to be stopped outside the app's own process group, and what had to be killed. */
function report(o) { try { fs.writeFileSync(path.join(path.dirname(process.argv[2]), 'stopped.json'), JSON.stringify({ at: Date.now(), ...o })) } catch { /* HQ's folder is gone */ } }

/** Ends the app: SIGTERM to everything it started, SIGKILL to what is still there after the grace, then this exits. */
function end(code) {
  if (ending) return; ending = true
  const told = new Set(), outside = new Set(), t0 = Date.now()
  let killed = [], rounds = 0
  const look = () => {
    const left = mine()
    if (!left) { // no ps: the old way, the group and nothing more
      for (const k of kids) { try { k.kill('SIGTERM') } catch { /* gone */ } }
      try { process.kill(-me, 'SIGTERM') } catch { /* not a group leader */ }
      return void setTimeout(() => process.exit(code), 300)
    }
    for (const p of left) if (p.pgid !== me) outside.add(p.pid)
    if (!left.length || rounds >= 5) { report({ outside: outside.size, killed, left: left.map((p) => p.pid) }); return process.exit(code) }
    if (Date.now() - t0 < GRACE_MS) { // what appears meanwhile (a shutdown script, say) is told once too
      const fresh = left.filter((p) => !told.has(p.pid)); for (const p of fresh) told.add(p.pid)
      signal(fresh, 'SIGTERM'); return void setTimeout(look, 150)
    }
    if (!rounds) killed = left.map((p) => p.pid)
    rounds++; signal(left, 'SIGKILL'); setTimeout(look, 200)
  }
  look()
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => end(0))
// Bug 47: Node opens stderr lazily, by reopening the terminal. After tmux hangs the terminal up (its server stopped), that open()
// blocks for good, and then no signal handler ever runs: e2e runs left dozens of these behind. So both are opened now, while the
// terminal is alive, and a failed write (the terminal is gone) ends this like a hang-up. Orphaned (tmux gone, no signal): end too.
for (const s of [process.stdout, process.stderr]) s.on('error', () => end(0))
setInterval(() => { if (process.ppid === 1) end(0) }, 2000).unref()
// It also keeps note of what runs under the app, so a helper whose parent exits later is still known as the app's: every 2 s while the app starts (when
// helpers come and go), every 5 s after the first minute. One look is a `ps`, about 40 ms on a busy Mac.
const began = Date.now()
const note = () => { if (ending) return; mine(); setTimeout(note, Date.now() - began < 60_000 ? 2000 : 5000).unref() }
setTimeout(note, 2000).unref()

function sh(part, command, env) {
  const k = spawn(command, { cwd: part.cwd, shell: '/bin/bash', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  k.stdout.on('data', lines(part.name)); k.stderr.on('data', lines(part.name)); return k
}
/** Remembers a finished install for this folder, so the next start skips it until the lockfile changes. */
function remember(part) {
  let marks = {}; try { marks = JSON.parse(fs.readFileSync(spec.marksFile, 'utf8')) } catch { /* first one */ }
  marks[part.cwd] = part.mark; fs.writeFileSync(spec.marksFile, JSON.stringify(marks, null, 1))
}

console.log(spec.header)
for (const part of spec.parts) {
  if (!part.install || ending) continue
  say(part.name, `Installing packages (${part.install})…`)
  const k = sh(part, part.install, {}); kids.push(k)
  const code = await new Promise((resolve) => k.on('exit', (c, s) => resolve(c ?? (s ? 1 : 0))))
  kids.splice(kids.indexOf(k), 1)
  if (ending) break
  if (code !== 0) { say(part.name, `The install failed (code ${code}).`); end(code || 1); break }
  remember(part)
}
if (!ending) {
  for (const part of spec.parts) {
    const k = sh(part, part.run, part.env); kids.push(k)
    k.on('exit', (code, sig) => { if (!ending) say(part.name, `stopped (${code ?? sig})`); end(code || 1) }) // even a clean exit: the app should keep running
  }
}

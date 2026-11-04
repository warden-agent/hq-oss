// The live preview's supervisor: runs one app's parts (an API and a web page, say) in the preview's tmux pane. HQ writes a spec
// (apprun.ts supervisorSpec) and runs `node supervise.mjs <spec.json>`. Installs run first, one at a time; then every part
// starts. Output is prefixed with the part's name when there's more than one. As soon as any part exits, the others are
// stopped and this exits non-zero, so the pane dies and HQ reports the app as crashed (spike S2, 2026-10-30): a half-running
// app never looks fine. Parts stay in this process group, so HQ's Stop (SIGTERM to the group) reaches all of them.
// Plain Node with no imports from HQ: it runs with the backend's node but outside the backend.
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const many = spec.parts.length > 1
const say = (name, line) => console.log(many ? `[${name}] ${line}` : line)
const lines = (name) => (buf) => { for (const l of buf.toString().split('\n')) if (l.trim()) say(name, l) }
const kids = []
let ending = false
function end(code) {
  if (ending) return; ending = true
  for (const k of kids) { try { k.kill('SIGTERM') } catch { /* gone */ } }
  try { process.kill(-process.pid, 'SIGTERM') } catch { /* not a group leader */ } // what `cd web && npm run dev` started, not only its bash
  setTimeout(() => process.exit(code), 300)
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => end(0))
// Bug 47: Node opens stderr lazily, by reopening the terminal. After tmux hangs the terminal up (its server stopped), that open()
// blocks for good, and then no signal handler ever runs: e2e runs left dozens of these behind. So both are opened now, while the
// terminal is alive, and a failed write (the terminal is gone) ends this like a hang-up. Orphaned (tmux gone, no signal): end too.
for (const s of [process.stdout, process.stderr]) s.on('error', () => end(0))
setInterval(() => { if (process.ppid === 1) end(0) }, 2000).unref()

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
  if (code !== 0) { say(part.name, `The install failed (code ${code}).`); process.exit(code || 1) }
  remember(part)
}
if (!ending) {
  for (const part of spec.parts) {
    const k = sh(part, part.run, part.env); kids.push(k)
    k.on('exit', (code, sig) => { if (!ending) say(part.name, `stopped (${code ?? sig})`); end(code || 1) }) // even a clean exit: the app should keep running
  }
}

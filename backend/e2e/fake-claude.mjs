#!/usr/bin/env node
// Stand-in for the Claude Code binary in HQ's e2e tests (HQ_CLAUDE_BIN): no model, no tokens. It reports SessionStart to HQ
// the way Claude Code's command hook does, locks its --worktree the way Claude Code does, then idles until killed. A killed
// Claude Code leaves that lock behind, and so does this. The tests act as the agent themselves, with its token.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const args = process.argv.slice(2)
// `--version`, as HQ asks it at start and before each launch (Bug 97): the harness says which one, and by default it's the one HQ was checked on
if (args.includes('--version')) { console.log(`${process.env.HQ_FAKE_VERSION ?? '0.0.0'} (Claude Code)`); process.exit(0) }
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const settings = JSON.parse(fs.readFileSync(flag('--settings'), 'utf8'))
const worktree = flag('--worktree')
if (worktree) {
  const wt = path.join(process.cwd(), '.claude', 'worktrees', worktree)
  try { execFileSync('git', ['-C', process.cwd(), 'worktree', 'lock', '--reason', `claude session ${worktree} (pid ${process.pid} start ${new Date().toUTCString()})`, wt], { stdio: 'pipe' }) }
  catch (e) { console.error(`fake-claude: could not lock ${wt}: ${String(e.stderr ?? e).trim()}`) }
}
// Runs HQ's own SessionStart command, as Claude Code does: the token comes from the agent's header file (Bug 87)
const start = { hook_event_name: 'SessionStart', session_id: flag('--session-id'), transcript_path: null, cwd: process.cwd(), source: 'startup', model: 'fake' }
execFileSync('/bin/sh', ['-c', settings.hooks.SessionStart[0].hooks[0].command], { input: JSON.stringify(start), stdio: ['pipe', 'ignore', 'inherit'] })
console.log(`fake-claude ${flag('--name') ?? ''} up (pid ${process.pid})`)
// Claude Code 2.1.300's screen when it waits at its prompt (Bug 25 tests): the input box and a footer with no "esc to interrupt"
if (process.env.HQ_FAKE_IDLE_SCREEN) console.log(`\n✻ Baked for 2s · done\n\n${'─'.repeat(60)}\n❯ \n${'─'.repeat(60)}\n  ⏸ manual mode on · ? for shortcuts · ← for agents`)
// Claude Code's own status file (Bug 62, presence.ts), which the tests then change as Claude Code would: hq.session()
const sessions = path.join(process.env.HOME, '.claude', 'sessions'); fs.mkdirSync(sessions, { recursive: true })
fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: flag('--session-id'), status: 'busy', statusUpdatedAt: Date.now() }))
// A screen a test draws (hq.screen()), shown whenever it changes: a dialog's menu, say
const drawn = process.env.HQ_FAKE_SCREEN_DIR && path.join(process.env.HQ_FAKE_SCREEN_DIR, `${flag('--session-id')}.txt`); let shown = ''
setInterval(() => { if (!drawn) return; let t = ''; try { t = fs.readFileSync(drawn, 'utf8') } catch { return } if (t !== shown) { shown = t; process.stdout.write(`\x1b[2J\x1b[H${t}`) } }, 200)
// A command a test starts as this agent's Bash command (hq.spawn()): like Claude Code, a shell child of this process in a process group of its own (Bug 96)
const asked = process.env.HQ_FAKE_SCREEN_DIR && path.join(process.env.HQ_FAKE_SCREEN_DIR, `${flag('--session-id')}.spawn`)
setInterval(() => {
  if (!asked) return; let cmd = ''; try { cmd = fs.readFileSync(asked, 'utf8'); fs.rmSync(asked) } catch { return }
  const c = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' }); fs.writeFileSync(`${asked}ed`, String(c.pid))
}, 100)

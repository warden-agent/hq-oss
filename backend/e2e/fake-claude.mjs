#!/usr/bin/env node
// Stand-in for the Claude Code binary in HQ's e2e tests (HQ_CLAUDE_BIN): no model, no tokens. It reports SessionStart to HQ
// the way Claude Code's command hook does, locks its --worktree the way Claude Code does, then idles until killed. A killed
// Claude Code leaves that lock behind, and so does this. The tests act as the agent themselves, with its token.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const settings = JSON.parse(fs.readFileSync(flag('--settings'), 'utf8'))
const hookUrl = settings.hooks.UserPromptSubmit[0].hooks[0].url
const worktree = flag('--worktree')
if (worktree) {
  const wt = path.join(process.cwd(), '.claude', 'worktrees', worktree)
  try { execFileSync('git', ['-C', process.cwd(), 'worktree', 'lock', '--reason', `claude session ${worktree} (pid ${process.pid} start ${new Date().toUTCString()})`, wt], { stdio: 'pipe' }) }
  catch (e) { console.error(`fake-claude: could not lock ${wt}: ${String(e.stderr ?? e).trim()}`) }
}
await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: flag('--session-id'), transcript_path: null, cwd: process.cwd(), source: 'startup', model: 'fake' }) })
console.log(`fake-claude ${flag('--name') ?? ''} up (pid ${process.pid})`)
// Claude Code 2.1.300's screen when it waits at its prompt (Bug 25 tests): the input box and a footer with no "esc to interrupt"
if (process.env.HQ_FAKE_IDLE_SCREEN) console.log(`\n✻ Baked for 2s · done\n\n${'─'.repeat(60)}\n❯ \n${'─'.repeat(60)}\n  ⏸ manual mode on · ? for shortcuts · ← for agents`)
setInterval(() => {}, 1 << 30)

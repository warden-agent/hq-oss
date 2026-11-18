// Bug 180: what the stuck loop (stuck.ts) keeps on an agent, its last screen and its "seen once" marks, goes once the agent has ended, however
// it ended. Real SQLite in a temp HQ_HOME; a stand-in tmux on PATH (every terminal there, at Claude Code's idle prompt), so no real tmux is called.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-stuck-'))
process.env.HQ_HOME = path.join(root, 'hq'); process.env.HQ_IDLE_FIX_S = '0'
const bin = path.join(root, 'bin'); fs.mkdirSync(bin)
fs.writeFileSync(path.join(root, 'screen'), '─'.repeat(20) + '\n❯ \n  ⏸ manual mode on\n')
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
case "$1" in
  has-session) [ -e "${root}/gone-$3" ] && exit 1; exit 0 ;;
  display-message) echo 0 ;;
  capture-pane) cat "${root}/screen" ;;
esac
exit 0
`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
const { migrate, run } = await import('./db.ts')
migrate()
const { update, stopAgent, lost } = await import('./agents.ts')
const { tick, trackedIds } = await import('./stuck.ts')

const add = (id: string) => run(`INSERT INTO agents(id, role, model_alias, tmux_session, cwd, token_hash, status, in_plan_mode, started_at, last_event_at)
  VALUES (?, 'engineer', 'sonnet', ?, '/tmp', ?, 'working', 0, 1, 1)`, id, `hq-${id}`, id)
/** Until the clock has moved on: a screen unchanged since the last look then counts as still for a moment (staticMs > 0). */
const pause = async () => { const t = Date.now(); while (Date.now() <= t + 1) await new Promise((r) => setImmediate(r)) }

test('an ended agent leaves nothing behind in the stuck loop; a running one keeps its entry', async () => {
  for (const id of ['eng-a', 'eng-b', 'eng-c', 'eng-d']) add(id)
  await tick() // each screen seen once
  await pause(); fs.writeFileSync(path.join(root, 'gone-hq-eng-c'), '')
  await tick() // a, b, d: idle on a second look (seen once); c: its terminal missed once
  assert.deepEqual(trackedIds(), ['eng-a', 'eng-b', 'eng-c', 'eng-d'])
  update('eng-a', { status: 'exited', ended_why: 'session:prompt_input_exit' }) // its session ended
  await stopAgent('eng-b', 'user') // Stop
  lost('eng-c') // gone without HQ stopping it
  await tick()
  assert.deepEqual(trackedIds(), ['eng-d'], 'only the agent still running is kept')
})

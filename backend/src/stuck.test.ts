// Bug 180: what the stuck loop (stuck.ts) keeps on an agent, its last screen and its "seen once" marks, goes once the agent has ended, however
// it ended. Real SQLite in a temp HQ_HOME; a stand-in tmux on PATH (every terminal there, at Claude Code's idle prompt), so no real tmux is called.
// Bug 328: the loop's clock, one look at a time, on a look of the test's own and mocked timers.
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
[ "$1" = -S ] || exit 9 # every call names HQ's socket (Bug 242)
shift 2
case "$1" in
  has-session) [ -e "${root}/gone-$3" ] && exit 1; exit 0 ;;
  display-message) echo 0 ;;
  capture-pane) cat "${root}/screen" ;;
esac
exit 0
`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
const { migrate, run, q } = await import('./db.ts')
migrate()
const { update, stopAgent, lost } = await import('./agents.ts')
const { tick, trackedIds, startStuckLoop } = await import('./stuck.ts')
const { beats } = await import('./beats.ts')

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

test('Bug 328: a look that takes longer than the period is not overlapped, and the next starts a whole period after it ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }) // setImmediate stays real: it lets the ended look's promises settle
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
  let started = 0, end: (e?: Error) => void = () => {}
  const look = () => { started++; return new Promise<void>((res, rej) => { end = (e) => (e ? rej(e) : res()) }) }
  const beat0 = beats().stuck, stop = startStuckLoop(look, 1000)
  try {
    t.mock.timers.tick(999); assert.equal(started, 0); t.mock.timers.tick(1); assert.equal(started, 1)
    t.mock.timers.tick(5000); await settle(); assert.equal(started, 1, 'no second look while the first is under way (five periods)')
    end(); await settle(); assert.equal(beats().stuck, beat0 + 1)
    t.mock.timers.tick(999); assert.equal(started, 1, 'the next waits a whole period after the last one ended'); t.mock.timers.tick(1); assert.equal(started, 2)
    end(new Error('tmux broke')); await settle() // a look that throws is logged, and the loop goes on
    assert.equal(q<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'stuck.error'")[0]!.n, 1); assert.equal(beats().stuck, beat0 + 2)
    t.mock.timers.tick(1000); assert.equal(started, 3)
  } finally { stop() }
  end(); await settle(); t.mock.timers.tick(5000); assert.equal(started, 3, 'stopped: no look after the one under way')
})

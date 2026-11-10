// Bugs 95/96: the runs an agent waits on in the background, how HQ finds their process, and when one counts as frozen.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-bgruns-')))
process.env.HQ_HOME = path.join(tmp, 'hq'); process.env.HQ_AGENT_TMP = path.join(tmp, 'a-')
const { migrate, run, setSetting } = await import('./db.ts'); migrate()
const { addRun, clockMs, endRuns, groupOf, hasRuns, judge, outputBytes, parseRows, rebuildRuns, runsOf, waitingText, watchedTask } = await import('./bgruns.ts')
const { bus, emit } = await import('./events.ts')
const { release, startTurns, take, turns } = await import('./heavy.ts')
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('what HQ watches: a command that went to the background without being asked, and a test run or build put there on purpose; never a server', () => {
  const resp = (extra = {}) => ({ stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bfoaj5ytl', ...extra })
  assert.equal(watchedTask({ command: 'npm run test-backend', timeout: 600000 }, resp({ timedOutAfterMs: 600000 }), null), 'bfoaj5ytl') // a real run
  assert.equal(watchedTask({ command: 'node -e 1' }, resp(), null), 'bfoaj5ytl', 'moved so a message could reach the agent: it was meant to finish too')
  assert.equal(watchedTask({ command: 'npm test', run_in_background: true }, resp(), null), 'bfoaj5ytl')
  assert.equal(watchedTask({ command: 'npm run test:unit -- --watch=false', run_in_background: true }, resp(), null), 'bfoaj5ytl')
  assert.equal(watchedTask({ command: './run-tests.sh', run_in_background: true }, resp(), './run-tests.sh'), 'bfoaj5ytl', "the project's own test command")
  for (const command of ['npm run dev', 'python3 -m http.server 8000', 'node server.js', 'npx vitest --watch', 'vite build --watch', 'tsc -b -w', 'npm run test -- --watch'])
    assert.equal(watchedTask({ command, run_in_background: true }, resp(), null), null, `not watched: ${command}`)
  assert.equal(watchedTask({ command: 'npm test', timeout: 600000 }, { stdout: 'ok', interrupted: false }, null), null, 'it finished: nothing in the background')
  assert.equal(watchedTask({ command: 'npm test' }, undefined, null), null)
})

test('ps times: elapsed and CPU, on a Mac and on Linux', () => {
  assert.equal(clockMs('0:00.06'), 60); assert.equal(clockMs('123:45.67'), 7_425_670); assert.equal(clockMs('01:02:03'), 3_723_000); assert.equal(clockMs('2-00:00:01'), 172_801_000)
  assert.deepEqual(parseRows(' 91492 90201 91492   00:41   0:00.06\nbad\n', 100_000), [{ pid: 91492, ppid: 90201, pgid: 91492, start: 59_000, cpu: 60 }])
})

test("a run's process: the group Claude Code started for it, under the agent's own Claude Code, by start time, with the CPU of all it runs", () => {
  const T = 1_800_000_000_000, CLAUDE = 90201
  const rows = [
    { pid: CLAUDE, ppid: 90200, pgid: CLAUDE, start: T - 600_000, cpu: 4_280 },
    { pid: 91000, ppid: CLAUDE, pgid: 91000, start: T - 300_000, cpu: 9_000 }, // caffeinate, or an older command
    { pid: 91492, ppid: CLAUDE, pgid: 91492, start: T - 1000, cpu: 60 }, // the run's shell
    { pid: 91493, ppid: 91492, pgid: 91492, start: T - 1000, cpu: 50 }, // npm
    { pid: 91494, ppid: 91493, pgid: 91600, start: T - 900, cpu: 2_000 }, // a test child in a group of its own
    { pid: 91700, ppid: CLAUDE, pgid: CLAUDE, start: T, cpu: 10 }, // Claude Code's own helper, in its group
    { pid: 80000, ppid: 1, pgid: 80000, start: T, cpu: 10 }, // someone else's program that began at the same second
  ]
  assert.deepEqual(groupOf(rows, CLAUDE, { at: T }), { pgid: 91492, cpu: 2_110 })
  assert.equal(groupOf(rows, CLAUDE, { at: T - 60_000 }), null, 'nothing began then')
  assert.equal(groupOf(rows, 12345, { at: T }), null, "another agent's Claude Code")
  assert.equal(groupOf(rows.filter((r) => r.pid !== 91492 && r.pid !== 91493), CLAUDE, { at: T }), null, "Claude Code's own group is never taken")
  // the pane a wrapper (a shell, `env`) with Claude Code its child, in the same group: the same command
  const wrapped = [{ pid: 90100, ppid: 1, pgid: CLAUDE, start: T - 600_000, cpu: 0 }, ...rows.map((r) => r.pid === CLAUDE ? { ...r, ppid: 90100 } : r)]
  assert.deepEqual(groupOf(wrapped, 90100, { at: T }), { pgid: 91492, cpu: 2_110 })
})

test('frozen: no CPU (beyond a frozen process\'s odd tick) and no output since it last moved', () => {
  const r = { task: 'b1', use: 'u', command: 'npm test', at: 0, cpu: -1, bytes: -1, quietSince: 0, missed: 0 }
  assert.equal(judge(r, { cpu: 500, bytes: 0 }, 1_000), 0, 'the first look is the baseline')
  assert.equal(judge(r, { cpu: 900, bytes: 0 }, 61_000), 60_000, 'a few ms of CPU now and then is still frozen')
  assert.equal(judge(r, { cpu: 1_400, bytes: 0 }, 121_000), 120_000, 'it adds up from the last move, not the last look')
  assert.equal(judge(r, { cpu: 1_500, bytes: 0 }, 181_000), 0, 'a second of CPU since: it moved')
  assert.equal(judge(r, { cpu: 1_500, bytes: 10 }, 241_000), 0, 'and so does output')
  assert.equal(judge(r, { cpu: 1_500, bytes: 10 }, 301_000), 60_000)
})

test("the output file: under the agent's own Claude Code temp folder, by session and task", () => {
  const dir = path.join(`${process.env.HQ_AGENT_TMP}eng-1`, `claude-${process.getuid?.() ?? 0}`, '-r-x', 'sess-1', 'tasks'); fs.mkdirSync(dir, { recursive: true })
  assert.equal(outputBytes({ id: 'eng-1', claude_session_id: 'sess-1' }, 'b2'), -1)
  fs.writeFileSync(path.join(dir, 'b2.output'), 'ok 1\n'); assert.equal(outputBytes({ id: 'eng-1', claude_session_id: 'sess-1' }, 'b2'), 5)
})

test('the list: what the box says, ended by its notice, and read back from the events log after a restart', () => {
  const t = Date.now()
  run(`INSERT INTO agents(id, role, model_alias, claude_session_id, tmux_session, cwd, token_hash, status, in_plan_mode, started_at)
    VALUES ('eng-r', 'engineer', 'sonnet', 's', 'hq-eng-r', '/r', 'x', 'idle', 0, ?)`, t)
  emit({ agentId: 'eng-r', source: 'hook', kind: 'hook.SessionStart', payload: {} })
  addRun('eng-r', { task: 'bOld', use: 'u0', command: 'npm run lint', at: t }); endRuns('eng-r', ['bOld'], 'done')
  addRun('eng-r', { task: 'bA', use: 'u1', command: 'npm run test-backend 2>&1 | grep -E "^# (tests|pass|fail)"', at: t })
  addRun('eng-r', { task: 'bB', use: 'u2', command: 'npm run build', at: t + 5 })
  assert.equal(waitingText('eng-r'), 'Waiting on: npm run build (+1 more)')
  rebuildRuns()
  assert.deepEqual(runsOf('eng-r').map((r) => [r.task, r.use, r.at]), [['bA', 'u1', t], ['bB', 'u2', t + 5]])
  endRuns('eng-r', ['bA', 'bB', 'bNotOurs'], 'done'); assert.equal(hasRuns('eng-r'), false); assert.equal(waitingText('eng-r'), null)
  addRun('eng-r', { task: 'bC', use: 'u3', command: 'npm test', at: t }); emit({ agentId: 'eng-r', source: 'hook', kind: 'hook.SessionStart', payload: {} })
  rebuildRuns(); assert.equal(hasRuns('eng-r'), false, 'a new session started since: nothing of the old one is waited on')
})

test("Bug 96 gap 3: a build or test run's turn stays taken while it goes on in the background, and comes back when it ends", () => {
  startTurns(); setSetting('heavy_at_once', 1)
  take({ id: 'eng-h:use1', who: 'eng h', what: 'tests', agentId: 'eng-h', lane: 'main', limitMs: 60_000 })
  emit({ agentId: 'eng-h', source: 'system', kind: 'bg.started', payload: { task: 'bH', use: 'use1', command: 'npm test', at: Date.now() } })
  emit({ agentId: 'eng-h', source: 'hook', kind: 'hook.PostToolUse:Bash', payload: { use: 'use1', bg: 'bH' } })
  emit({ agentId: 'eng-h', source: 'hook', kind: 'hook.Stop', payload: {} })
  bus.emit('noop'); assert.deepEqual(turns().running, ['eng h'], 'not given back when the command returned, nor when the turn ended')
  emit({ agentId: 'eng-h', source: 'system', kind: 'bg.ended', payload: { task: 'bH', why: 'done' } })
  assert.deepEqual(turns().running, [], 'given back when the run ended')
  take({ id: 'eng-h:use2', who: 'eng h', what: 'tests', agentId: 'eng-h', lane: 'main', limitMs: 60_000 })
  emit({ agentId: 'eng-h', source: 'hook', kind: 'hook.PostToolUse:Bash', payload: { use: 'use2' } })
  assert.deepEqual(turns().running, [], 'a command that finished gives it back as before'); release('eng-h:use2')
})

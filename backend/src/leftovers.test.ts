// Bug 75: what an agent's command leaves running in HQ's worktrees is stopped, and nothing anyone is using is.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-leftovers-')))
process.env.HQ_HOME = path.join(tmp, 'hq')
const { bashBegan, bashEnded, busySince, inHq, leftoverGroups, parsePs, rootsToAsk, stopLeftovers, sweepAgentTmp } = await import('./leftovers.ts')
const { AGENT_TMP, agentTmpDir } = await import('./config.ts')
const { cwdsOf } = await import('./procs.ts')
const { migrate, run } = await import('./db.ts'); migrate()
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); for (const a of ['eng-live', 'eng-done', 'eng-unknown']) fs.rmSync(agentTmpDir(a), { recursive: true, force: true }) })

type P = { pid: number; ppid: number; pgid: number; tty?: string; stat?: string; cwd?: string; age?: number }
const NOW = 1_800_000_000_000
const W = '/r/.claude/worktrees', dirs = [{ root: W, names: new Set(['SHOP-1', 'SHOP-13']), skip: new Set<string>() }]
const SELF = 100
/** HQ's backend (pid 100) under tmux, plus the processes given. */
function find(ps: P[], d = dirs) {
  const all: P[] = [{ pid: 90, ppid: 1, pgid: 90 }, { pid: 95, ppid: 90, pgid: 95, tty: 'ttys009' }, { pid: SELF, ppid: 95, pgid: 95, tty: 'ttys009' }, ...ps]
  const procs = all.map((p) => ({ pid: p.pid, ppid: p.ppid, pgid: p.pgid, uid: 501, tty: p.tty ?? '??', stat: p.stat ?? 'S', start: NOW - (p.age ?? 60) * 1000 }))
  return leftoverGroups(procs, new Map(all.filter((p) => p.cwd).map((p) => [p.pid, p.cwd!])), d, SELF)
}
const wt = (name: string, sub = '') => path.join(W, name, sub)
// A live engineer: its pane (a terminal), claude in the worktree, and a Bash command running there
const engineer: P[] = [{ pid: 300, ppid: 90, pgid: 300, tty: 'ttys001' }, { pid: 301, ppid: 300, pgid: 300, tty: 'ttys001', cwd: wt('SHOP-13') }]

test('a server orphaned when its command ended is a leftover, with its whole group and what it started', () => {
  const r = find([...engineer, { pid: 200, ppid: 1, pgid: 190, cwd: wt('SHOP-13', 'server') }, { pid: 201, ppid: 1, pgid: 190, cwd: wt('SHOP-13') },
    { pid: 210, ppid: 200, pgid: 210, cwd: '/' }]) // it started a child in a group of its own, somewhere else
  assert.deepEqual(r.map((x) => [x.pgid, x.pids, x.folder]), [[190, [200, 201], 'SHOP-13'], [210, [210], 'SHOP-13']])
})

test('nothing an agent is using: a Bash command under way, what it started, a run_in_background server', () => {
  assert.deepEqual(find([...engineer, { pid: 310, ppid: 301, pgid: 310, cwd: wt('SHOP-13') }, { pid: 311, ppid: 310, pgid: 310, cwd: wt('SHOP-13') }]), [])
  // a server orphaned while the command that started it still runs shares that command's group: it waits for the command to end
  assert.deepEqual(find([...engineer, { pid: 310, ppid: 301, pgid: 310, cwd: wt('SHOP-13') }, { pid: 312, ppid: 1, pgid: 310, cwd: wt('SHOP-13') }]), [])
})

test("only HQ's folders: the user's own worktrees, a sibling name and other folders are left alone", () => {
  const orphan = (cwd: string) => find([{ pid: 400, ppid: 1, pgid: 400, cwd }]).length
  assert.equal(orphan(wt('mine')), 0) // the user's own claude --worktree
  assert.equal(orphan(wt('SHOP-10')), 0) // not SHOP-1
  assert.equal(orphan('/r'), 0); assert.equal(orphan('/elsewhere'), 0)
  assert.equal(orphan(wt('SHOP-1', 'a/b')), 1); assert.equal(orphan(wt('launch-mh2x')), 1); assert.equal(orphan(wt('hq-test-SHOP-9')), 1)
  assert.equal(find([{ pid: 400, ppid: 1, pgid: 400, cwd: wt('SHOP-13') }], [{ ...dirs[0]!, skip: new Set(['SHOP-13']) }]).length, 0) // its owner is using it
})

test('while a command runs in a worktree: an orphan as new as the command may be its own daemon and waits; an older one goes', () => {
  const busy = [{ ...dirs[0]!, busy: new Map([['SHOP-13', NOW - 30_000]]) }] // SHOP-13's engineer began a command 30 s ago
  const pids = (ps: P[]) => find(ps, busy).flatMap((x) => x.pids)
  assert.deepEqual(pids([{ pid: 600, ppid: 1, pgid: 600, cwd: wt('SHOP-13'), age: 20 }]), []) // started by that command
  assert.deepEqual(pids([{ pid: 601, ppid: 1, pgid: 601, cwd: wt('SHOP-13'), age: 31 }]), []) // ps rounds to the second: too close to call
  assert.deepEqual(pids([{ pid: 602, ppid: 1, pgid: 602, cwd: wt('SHOP-13'), age: 40 }, { pid: 603, ppid: 602, pgid: 602, age: 5 }]), [602, 603]) // an earlier command's
  assert.deepEqual(pids([{ pid: 604, ppid: 1, pgid: 604, cwd: wt('SHOP-1'), age: 20 }]), [604]) // another ticket's engineer isn't running anything
})

test("where the live preview runs: an orphan from the app's start-up is kept; what the engineer's commands leave there goes", () => {
  const span = (to: number) => [{ ...dirs[0]!, app: new Map<string, [number, number]>([['SHOP-13', [NOW - 600_000, to]]]) }]
  const tried = span(NOW - 580_000) // Try it on SHOP-13 began 10 min ago and the app answered 20 s later
  const pane: P[] = [{ pid: 700, ppid: 90, pgid: 700, tty: 'ttys005' }, { pid: 701, ppid: 700, pgid: 700, tty: 'ttys005', cwd: wt('SHOP-13') }] // the app itself
  const pids = (ps: P[], d = tried) => find([...pane, ...ps], d).flatMap((x) => x.pids)
  assert.deepEqual(pids([{ pid: 710, ppid: 1, pgid: 710, cwd: wt('SHOP-13'), age: 595 }]), []) // a database the app put in the background
  assert.deepEqual(pids([{ pid: 711, ppid: 1, pgid: 711, cwd: wt('SHOP-13'), age: 120 }]), [711]) // a test run's server, from a revise round
  assert.deepEqual(pids([{ pid: 712, ppid: 1, pgid: 712, cwd: wt('SHOP-13'), age: 900 }]), [712]) // from before Try it
  assert.deepEqual(pids([{ pid: 713, ppid: 1, pgid: 713, cwd: wt('SHOP-1'), age: 595 }]), [713]) // the preview isn't on this ticket
  // still starting (installing packages, say): anything since it began may be the app's
  const both = [{ pid: 714, ppid: 1, pgid: 714, cwd: wt('SHOP-13'), age: 5 }, { pid: 715, ppid: 1, pgid: 715, cwd: wt('SHOP-13'), age: 900 }]
  assert.deepEqual(pids(both, span(Infinity)), [715])
  // a narrowed look covers its agent's worktree only, not every Launch helper's and test run's folder
  const only = [{ root: W, names: new Set(['SHOP-13']), skip: new Set<string>(), only: true }]
  assert.deepEqual(['SHOP-13', 'SHOP-1', 'launch-mh2x', 'hq-test-SHOP-9'].map((n) => !!inHq(only, wt(n))), [true, false, false, false])
})

test('which commands are running: each ends by its id, at the end of the turn, or when its own time limit has passed', () => {
  const T = NOW, a = 'eng-test-1'
  assert.equal(busySince(a, T), 0)
  bashBegan(a, { use: 'u1' }, T); bashBegan(a, { use: 'u2', timeout: 300_000 }, T + 5000)
  assert.equal(busySince(a, T + 6000), T) // the oldest
  bashEnded(a, { use: 'u1' }, T + 7000); assert.equal(busySince(a, T + 7000), T + 5000)
  bashEnded(a, { use: 'gone' }, T + 8000); assert.equal(busySince(a, T + 8000), T + 5000) // some other command's end
  bashEnded(a, { use: 'u2' }, T + 9000); assert.equal(busySince(a, T + 9000), 0)

  // HQ refused a command after its PreToolUse (planning): no end ever comes, and later commands begin and end as usual
  bashBegan(a, { use: 'refused' }, T); bashBegan(a, { use: 'u3' }, T + 60_000); bashEnded(a, { use: 'u3' }, T + 61_000)
  assert.equal(busySince(a, T + 61_000), T) // still counted: it could be running for all HQ knows
  assert.equal(busySince(a, T + 136_000), 0) // the default limit (2 min) and a margin have passed
  bashBegan(a, { use: 'refused2', timeout: 600_000 }, T); bashBegan(a, { use: 'sub1', sub: true }, T + 1000)
  bashEnded(a, { turn: true }, T + 2000); assert.equal(busySince(a, T + 2000), T + 1000) // the turn ended; a subagent's command can outlive it
  bashEnded(a, { use: 'sub1' }, T + 3000); assert.equal(busySince(a, T + 3000), 0)

  // hooks with no ids (the test harness): first in, first out
  bashBegan(a, {}, T); bashBegan(a, {}, T + 1000); bashEnded(a, {}, T + 2000); assert.equal(busySince(a, T + 2000), T + 1000)
  bashEnded(a, {}, T + 3000); bashEnded(a, {}, T + 4000); assert.equal(busySince(a, T + 4000), 0)
  bashBegan(a, { timeout: 99_999_999 }, T); assert.equal(busySince(a, T + 614_000), T); assert.equal(busySince(a, T + 616_000), 0) // never past Claude Code's 10 min
})

test('Bug 100: a command\'s end says when it began, so the look after it asks only about what began since', () => {
  const T = NOW, a = 'eng-test-100'
  bashBegan(a, { use: 'u1' }, T); bashBegan(a, { use: 'u2' }, T + 5000)
  assert.equal(bashEnded(a, { use: 'u2' }, T + 6000), T + 5000) // by its id, not the oldest
  assert.equal(bashEnded(a, { use: 'other' }, T + 7000), null) // HQ never heard it begin: the look can't be narrowed
  assert.equal(bashEnded(a, { use: 'u1' }, T + 8000), T); assert.equal(bashEnded(a, {}, T + 9000), null) // nothing running
  bashBegan(a, { use: 'u3' }, T + 10_000); bashBegan(a, { use: 'u4' }, T + 11_000); bashBegan(a, { use: 's1', sub: true }, T + 9500)
  assert.equal(bashEnded(a, { turn: true }, T + 12_000), T + 10_000) // the turn's own commands, not the subagent's
  assert.equal(bashEnded(a, { turn: true }, T + 13_000), null) // a turn that ended no command: no look
  assert.equal(bashEnded(a, { use: 's1' }, T + 14_000), T + 9500)

  const at = (pid: number, age: number, o: Partial<{ ppid: number; tty: string; stat: string }> = {}) =>
    ({ pid, ppid: o.ppid ?? 1, pgid: pid, uid: 501, tty: o.tty ?? '??', stat: o.stat ?? 'S', start: NOW - age * 1000 })
  const procs = [at(1, 99_999, { ppid: 0 }), at(10, 3), at(11, 9), at(12, 30), at(13, 3, { tty: 'ttys001' }), at(14, 3, { ppid: 13 }), at(15, 3, { stat: 'Z' })]
  assert.deepEqual(rootsToAsk(procs), [10, 11, 12]) // a full look: every orphan with no terminal
  // the command began 10 s ago: what it can have left began after that, or up to 2 s before (ps rounds to the second); an older
  // orphan (another command's, a daemon of the user's) isn't asked about, nor one with a terminal, a live parent, or a zombie
  assert.deepEqual(rootsToAsk(procs, NOW - 10_000), [10, 11]); assert.deepEqual(rootsToAsk(procs, NOW - 12_500), [10, 11])
  assert.deepEqual(rootsToAsk(procs, NOW), []) // nothing new: no lsof at all
})

test('never: a terminal anywhere in the tree (tmux, the user\'s shells), HQ itself, zombies, a live parent', () => {
  assert.equal(find([{ pid: 500, ppid: 1, pgid: 500, cwd: wt('SHOP-13') }, { pid: 501, ppid: 500, pgid: 501, tty: 'ttys002' }]).length, 0) // a tmux server started there
  assert.equal(find([{ pid: 502, ppid: 1, pgid: 502, tty: 'ttys003', cwd: wt('SHOP-13') }]).length, 0)
  assert.equal(find([{ pid: 503, ppid: 1, pgid: 95, cwd: wt('SHOP-13') }]).length, 0) // in HQ's own group
  assert.equal(find([{ pid: 504, ppid: 1, pgid: 504, stat: 'Z', cwd: wt('SHOP-13') }]).length, 0)
  assert.equal(find([{ pid: 505, ppid: 95, pgid: 505, cwd: wt('SHOP-13') }]).length, 0) // the user started it from a terminal that's still open
  assert.equal(find([{ pid: 506, ppid: 1, pgid: 1, cwd: wt('SHOP-13') }]).length, 0)
})

test('ps and lsof listings: fixed fields, start times, Linux\'s "?" and " (deleted)"', () => {
  assert.deepEqual(parsePs(' 12   1  12 501 ??  Ss   08-10:55:43\n13 12 12 501 ? R+ 01:02:03\n14 13 14 501 ?? S 00:07\n15 1 15 501 ?? Z -\nbad line\n', NOW), [
    { pid: 12, ppid: 1, pgid: 12, uid: 501, tty: '??', stat: 'Ss', start: NOW - (((8 * 24 + 10) * 60 + 55) * 60 + 43) * 1000 },
    { pid: 13, ppid: 12, pgid: 12, uid: 501, tty: '?', stat: 'R+', start: NOW - 3723_000 }, { pid: 14, ppid: 13, pgid: 14, uid: 501, tty: '??', stat: 'S', start: NOW - 7000 },
    { pid: 15, ppid: 1, pgid: 15, uid: 501, tty: '??', stat: 'Z', start: NOW }]) // no time given: counted as new
  const cwds = cwdsOf(`p12\nfcwd\nn${wt('SHOP-13')} (deleted)\np13\nfcwd\nn/x\n`)
  assert.equal(cwds.get(12), wt('SHOP-13')); assert.deepEqual(inHq(dirs, cwds.get(12)!), { name: 'SHOP-13', busy: 0, app: null }); assert.equal(inHq(dirs, cwds.get(13)!), null)
})

// Bug 77: on main the app runs in the project's own folder, so a run's leftovers are known by the mark they inherited, not by where they work
const { markFor, marksOf, runCandidates, runsLeft } = await import('./leftovers.ts')
test("a finished preview run's orphans are leftovers; a running app's, another HQ's, the user's own and ones in another project are not", () => {
  const was = markFor('repo-a', 1000), on = markFor('repo-a', 2000)
  const runs = new Map([['repo-a', { name: 'garden', roots: ['/p/garden'], live: on }], ['repo-b', { name: 'site', roots: ['/p/site', '/link/site'], live: null }]])
  const P = (pid: number, ppid: number, pgid = pid, tty = '??') => ({ pid, ppid, pgid, uid: 501, tty, stat: 'S', start: NOW - 60_000 })
  const procs = [P(700, 1), P(701, 700), P(710, 1), P(720, 1), P(730, 1), P(740, 1), P(750, 1), P(760, 95), P(770, 1), P(771, 770), P(780, 1), P(790, 1, 790, 'ttys004')]
  const cwds = new Map([[700, '/p/garden/api'], [710, '/p/garden'], [720, '/p/site'], [730, '/elsewhere'], [740, '/p/garden'], [750, '/link/site/x'], [770, '/p/garden'],
    [780, '/p/garden'], [790, '/p/garden']])
  const cands = runCandidates(procs, cwds, runs)
  assert.deepEqual([...cands.keys()], [700, 710, 720, 740, 750, 770, 780]) // not 730 (in no project), 760 (it has a parent), 790 (a terminal)
  assert.deepEqual(cands.get(700), [700, 701])
  const marks = new Map([[701, was], // its parent's own isn't shown (a /bin/sh wrapper on a Mac): the child's says whose both are
    [710, on], [720, was], [740, `ffffffff.repo-a.1000`], [750, markFor('repo-b', 500)], [770, was], [771, on]]) // 780 carries none: the user's own
  assert.deepEqual([...runsLeft(cands, cwds, runs, marks, new Set())], [[700, 'garden'], [750, 'site']])
  assert.deepEqual([...runsLeft(cands, cwds, runs, marks, new Set([was]))], [[750, 'site']]) // a run being started: its row isn't written yet
  // and the usual rules still hold for them: the whole tree, never one with a terminal in it
  const left = (ps: ReturnType<typeof P>[]) => leftoverGroups([P(90, 1), P(SELF, 90, 95, 'ttys009'), ...ps], cwds, dirs, SELF, new Map([[700, 'garden']])).map((x) => [x.pids, x.folder])
  assert.deepEqual(left([P(700, 1), P(701, 700), P(780, 1)]), [[[700], 'garden'], [[701], 'garden']])
  assert.deepEqual(left([P(700, 1), P(701, 700, 701, 'ttys005')]), [])
})

test('for real: the mark a program inherited is read back from it, here and on Linux', async () => {
  const mark = markFor('repo-real', 123), env = { ...process.env, HQ_PREVIEW_RUN: mark }
  const marked = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { env, detached: true, stdio: 'ignore' })
  const child = spawn('sh', ['-c', `"${process.execPath}" -e "setInterval(() => {}, 1e6)" -- via-a-shell & wait`], { env, detached: true, stdio: 'ignore' })
  const plain = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { detached: true, stdio: 'ignore' })
  after(() => { for (const p of [marked, child, plain]) try { process.kill(-p.pid!, 'SIGKILL') } catch { /* gone */ } })
  await new Promise((r) => setTimeout(r, 500))
  const inner = Number(execFileSync('ps', ['-axo', 'pid=,ppid=']).toString().split('\n').map((l) => l.trim().split(/\s+/)).find((f) => Number(f[1]) === child.pid)?.[0] ?? 0)
  const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }); await new Promise((r) => gone.once('exit', r)) // one that ended between the look and the question
  const marks = await marksOf([marked.pid!, inner, plain.pid!, gone.pid!])
  assert.equal(marks.get(marked.pid!), mark); assert.equal(marks.get(inner), mark, 'a grandchild, through a shell'); assert.equal(marks.has(plain.pid!), false)
  assert.equal((await marksOf([])).size, 0)
})

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const pidOf = (arg: string) => Number(execFileSync('ps', ['-axo', 'pid=,ppid=,args=']).toString().split('\n').map((l) => l.trim().split(/\s+/))
  .find((f) => f.slice(2).join(' ') === `sleep ${arg}`)?.[0] ?? 0)
const ppidOf = (pid: number) => Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim())

test('for real: an orphaned server in a ticket worktree is stopped; one still owned, and one in the user\'s own worktree, are not', async (t) => {
  const root = path.join(tmp, 'repo', '.claude', 'worktrees'), mine = path.join(root, 'T-1'), users = path.join(root, 'theirs')
  fs.mkdirSync(mine, { recursive: true }); fs.mkdirSync(users, { recursive: true })
  const orphan = (cwd: string, arg: string) => new Promise<number>((res) => spawn('sh', ['-c', `sleep ${arg} &`], { cwd, detached: true, stdio: 'ignore' })
    .once('exit', () => setTimeout(() => res(pidOf(arg)), 200))) // like `cmd &` in a Bash command that ended
  const left = await orphan(mine, '61.71'), theirs = await orphan(users, '61.72')
  const held = spawn('sleep', ['61.73'], { cwd: mine, detached: true, stdio: 'ignore' }) // its parent (this test) is alive
  after(() => { for (const p of [left, theirs, held.pid!]) try { process.kill(p, 'SIGKILL') } catch { /* gone */ } })
  assert.ok(left && theirs && held.pid)
  if (ppidOf(left) !== 1) return t.skip(`orphans go to pid ${ppidOf(left)} here, not init`)
  const r = await stopLeftovers([{ root, names: new Set(['T-1']), skip: new Set() }])
  assert.deepEqual(r.stuck, []); assert.ok(r.stopped.some((x) => x.pids.includes(left) && x.folder === 'T-1'))
  assert.equal(alive(left), false); assert.equal(alive(theirs), true); assert.equal(alive(held.pid!), true)
})

test('Bug 81: an agent\'s own temp folder goes once the agent has; a running one\'s stays, and nothing else in its folder is touched', async () => {
  const add = (id: string, status: string) => run("INSERT INTO agents(id, role, model_alias, token_hash, status, started_at) VALUES (?, 'engineer', 'sonnet', 'h', ?, 0)", id, status)
  add('eng-live', 'working'); add('eng-done', 'exited')
  for (const a of ['eng-live', 'eng-done', 'eng-unknown']) { fs.mkdirSync(path.join(agentTmpDir(a), 'claude-501', 'node-coverage-1'), { recursive: true })
    fs.writeFileSync(path.join(agentTmpDir(a), 'claude-501', 'node-coverage-1', 'coverage.json'), 'x') }
  const other = `${path.dirname(AGENT_TMP)}/hqffffff-eng-done`; fs.mkdirSync(other, { recursive: true }); after(() => fs.rmSync(other, { recursive: true, force: true }))
  assert.deepEqual((await sweepAgentTmp()).sort(), ['eng-done', 'eng-unknown'])
  for (const [a, there] of [['eng-live', true], ['eng-done', false], ['eng-unknown', false]] as const) assert.equal(fs.existsSync(agentTmpDir(a)), there, a)
  assert.equal(fs.existsSync(other), true) // another HQ's
  // Claude Code uses it for commands only up to about 30 bytes, and engineers can't read home
  if (!process.env.HQ_AGENT_TMP) assert.ok(agentTmpDir('launch-1234abcd').length <= 30 && AGENT_TMP.startsWith('/tmp/hq'), AGENT_TMP)
})

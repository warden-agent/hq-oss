// The harness itself: the fake Claude Code starts and reports in, the tests can act as an agent through its hooks and MCP
// tools, the plan gate holds and answers, and nothing reaches the live HQ.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { startHq, waitFor, sh, exitPlanMode, lockOf, leftoverGroups, claimPorts, PORT_BLOCKS, type Hq, pending } from './harness.ts'
import { pidsUnder } from '../src/procs.ts'
import { PORT_TAKEN_EXIT } from '../src/ports.ts'
import { EPHEMERAL_FROM } from '../src/apprun.ts'
import { slotWindow } from '../src/slotports.ts'

let hq: Hq
let steady = 0 // the pipes this process holds open while only the file's own test HQ runs (see `settled`)
before(async () => { hq = await startHq(); steady = pipes() })
after(async () => { await hq?.stop() })

test('fake agents report in, hooks and MCP work as the agent, the plan gate holds until answered', async () => {
  const dir = hq.repo('smoke')
  const repo = (await hq.api('repos', { path: dir })).json; assert.equal(repo.kind, 'local')
  const f = (await hq.api('features', { repoId: repo.id, title: 'Smoke', request: 'Make a thing' })).json
  const tpm = await waitFor('the TPM to report in', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  assert.equal(tpm.role, 'tpm')
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Add b', size: 'S', spec: 'Add b.txt' })).json
  const launched = await hq.api(`tickets/${t.id}/launch`, {}); assert.equal(launched.status, 200, JSON.stringify(launched.json))
  const eng = await waitFor('the engineer to report in', async () => (await hq.state()).agents.find((a: any) => a.id === launched.json.id && a.status === 'working'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key)
  assert.match(lockOf(dir, wt) ?? '', new RegExp(`^claude session ${t.key} \\(pid \\d+ `)) // locked like Claude Code does

  const got = await hq.mcp(eng.id, 'get_ticket'); assert.equal(got.isError, false); assert.match(got.text, new RegExp(`# ${t.key} \\(S\\): Add b`))
  const held = hq.hook(eng.id, exitPlanMode('Plan: add b.txt'))
  await waitFor('its plan to be up for review', async () => (await hq.state()).reviews.some((r: any) => r.ticket_id === t.id && r.status === 'open'))
  assert.equal(await pending(held), true) // held for a verdict
  const review = await waitFor('the review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open'))
  assert.equal((await hq.api(`reviews/${review.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  const answer = await held
  assert.equal(answer.hookSpecificOutput.decision.behavior, 'allow'); assert.equal(answer.hookSpecificOutput.decision.updatedInput.plan, 'Plan: add b.txt')

  // Isolation: the agents live on the harness's own tmux server, and HQ's trust entries went to the harness's home only. Bug 241: shown on that server
  // alone (its pane is that server's child); a look at the default server for comparison was a call on the user's live one.
  assert.match(hq.tmux('ls'), new RegExp(`hq-${eng.id}`))
  const [server, pane] = hq.tmux('display-message', '-p', '-t', `hq-${eng.id}`, '#{pid} #{pane_pid}').trim().split(' ').map(Number)
  assert.ok(server! > 0 && pane! > 0); assert.equal(Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pane)], { encoding: 'utf8' }).trim()), server)
  const trusted = (file: string) => fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? {}) : []
  assert.ok(trusted(path.join(hq.home, '.claude.json')).some((p) => p.startsWith(path.dirname(hq.home))))
  assert.ok(!trusted(path.join(os.homedir(), '.claude.json')).some((p) => p.startsWith(path.dirname(hq.home))))
})

test('a Stop HQ answers with a message goes on like Claude Code: the turn ends again, and the agent is idle', async () => {
  const dir = hq.repo('stop-again'); const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'Stop again', request: 'Make a thing' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const status = async () => (await hq.state()).agents.find((a: any) => a.id === tpm.id).status
  await hq.api(`agents/${tpm.id}/message`, { body: 'One more thing.', reason: 'fyi' }) // the fake has no mod: the Stop hook carries it
  const r = await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  assert.equal(r.decision, 'block'); assert.equal(await status(), 'idle') // the first answer, and the Stop that ended the turn it started
  assert.deepEqual(await hq.hookOnce(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' }), {}) // nothing left to hand over
})

test('Bug 159: an agent\'s status file is there, whole, before it shows as started; hq.session() passes over another one being written', async () => {
  const dir = hq.repo('status-file'); const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'Status file', request: 'Make a thing' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const sessions = path.join(hq.home, '.claude', 'sessions'), read = () => fs.readdirSync(sessions).filter((x) => x.endsWith('.json') && x !== '99999.json')
    .map((x) => JSON.parse(fs.readFileSync(path.join(sessions, x), 'utf8'))).find((j) => j.sessionId === tpm.claude_session_id)
  const started = (await hq.api('events?limit=500')).json.find((e: any) => e.kind === 'hook.SessionStart' && e.agent_id === tpm.id)
  assert.ok(read()?.statusUpdatedAt <= started.created_at, 'written before HQ heard of the session, so never newer than an alert raised after')
  fs.writeFileSync(path.join(sessions, '99999.json'), '') // another agent's, half-written
  await hq.session(tpm.id, 'idle', 1234); assert.deepEqual([read().status, read().statusUpdatedAt], ['idle', 1234])
  assert.deepEqual(fs.readdirSync(sessions).filter((x) => !x.endsWith('.json')), [], 'no temp file left')
  await assert.rejects(hq.session('nobody', 'idle'), /status file/) // a test is told, rather than changing nothing
})

test('stopping a test HQ twice never reaches a tmux server outside its own folder', async () => {
  // A tmux that records every call and refuses kill-server unless it names a socket first, so even a regression here can't reach the user's server.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-faketmux-')), calls = path.join(bin, 'calls')
  const real = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim()
  const script = ['#!/bin/sh', `echo "$*" >> '${calls}'`, `case " $* " in *" kill-server "*) [ "$1" = -S ] || { echo 'refused: no -S' >&2; exit 1; } ;; esac`, `exec '${real}' "$@"`]
  fs.writeFileSync(path.join(bin, 'tmux'), script.join('\n') + '\n', { mode: 0o755 })
  const hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}` } })
  hq.tmux('new-session', '-d', '-s', 'probe', 'sleep 60') // its own server, as an agent's would start it
  await hq.stop(); await hq.stop() // the second used to run a bare kill-server after its folder had gone: the default server
  const kills = fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.split(' ').includes('kill-server'))
  assert.ok(kills.length >= 1, 'it stopped its own server')
  const own = (process.env.HQ_SHORT_TMPDIR ?? '/tmp').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') // own-tmp.mjs gives the run a folder of its own there
  for (const k of kills) assert.match(k, new RegExp(`^-S ${own}/hq-e2e-\\S+/tmux-\\d+/default kill-server$`), k)
  fs.rmSync(bin, { recursive: true, force: true })
})


test('Bug 242: every tmux call the backend makes names its own socket: launching, the terminal view, a restart finding its agent again', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-socktmux-')), calls = path.join(bin, 'calls')
  const real = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\necho "$*" >> '${calls}'\nexec '${real}' "$@"\n`, { mode: 0o755 }) // writes each call down
  const own = await startHq({ env: { PATH: `${bin}:${process.env.PATH}` } }); let ws: WebSocket | null = null
  try {
    const repo = (await own.api('repos', { path: own.repo('sock') })).json, a = (await own.api(`repos/${repo.id}/message`, { body: 'hello' })).json.agent
    const tpm = await waitFor('the TPM', async () => (await own.state()).agents.find((x: any) => x.id === a.id && x.status === 'working'))
    await own.screen(tpm, 'SCREEN-242 on its own server')
    const token = fs.readFileSync(path.join(own.hqHome, 'ui-token'), 'utf8').trim(), seen: any[] = []
    const w = new WebSocket(`ws://127.0.0.1:${own.ports.ui}/ws`, { headers: { authorization: `Bearer ${token}` } }); ws = w
    w.on('message', (raw) => seen.push(JSON.parse(String(raw))))
    await new Promise<void>((ok, no) => { w.once('open', () => ok()); w.once('error', no) })
    w.send(JSON.stringify({ type: 'term.open', agentId: tpm.id, cols: 120, rows: 30 })) // the Agent tab's terminal
    const drawn = () => seen.filter((m) => m.type === 'term' && m.agentId === tpm.id).map((m) => m.data).join('')
    await waitFor('the terminal view to show its screen', () => drawn().includes('SCREEN-242') || null)
    assert.equal(seen.some((m) => m.type === 'term.exit'), false, drawn())
    await own.restart() // a new backend finds the agent on the same server
    await waitFor('the TPM after the restart', async () => (await own.state()).agents.find((x: any) => x.id === tpm.id && x.status === 'working'))
    assert.match(own.tmux('ls'), new RegExp(`hq-${tpm.id}`))
  } finally { ws?.close(); await own.stop() }
  const lines = fs.readFileSync(calls, 'utf8').trim().split('\n'), socks = new Set(lines.map((l) => l.split(' ').slice(0, 2).join(' ')))
  for (const verb of ['new-session', 'set-hook', 'attach-session', 'has-session', 'display-message']) assert.ok(lines.some((l) => l.split(' ').includes(verb)), verb)
  const short = (process.env.HQ_SHORT_TMPDIR ?? '/tmp').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  assert.equal(socks.size, 1, [...socks].join('\n')); assert.match([...socks][0]!, new RegExp(`^-S ${short}/hq-e2e-\\S+/tmux-\\d+/default$`))
  fs.rmSync(bin, { recursive: true, force: true })
})

// Bug 199: a test HQ's teardown kills the process groups that name its folder or work in it. A group with a process older than the
// test HQ is someone else's (a shell that cd'd into the folder, a terminal's job), and it's left alone; what the test HQ started isn't.
test('Bug 199: which groups are a test HQ\'s leftovers: never one with a process older than the test HQ', () => {
  const root = '/t/hq-e2e-abc', born = 10_000, row = (pid: number, pgid: number, start: number, cmd = 'x') => ({ pid, pgid, start, cmd })
  const rows = [row(1, 1, 0, `init ${root}`), row(5, 5, 9_000, 'zsh'), row(6, 5, 12_000, `tail ${root}/hq/log`), // a shell of the user's, older
    row(7, 7, 11_000, `node supervise.mjs ${root}/hq/previews/x.json`), row(8, 7, 11_500, 'node server.js'), // the test HQ's preview
    row(9, 9, 11_000, 'npm test'), row(20, 20, 3_000, 'tmux -S /private/tmp/tmux-501/default new-session'), row(21, 20, 12_000, 'sleep 9')]
  assert.deepEqual(leftoverGroups(rows, root, new Set([9, 21]), 100, born).sort(), [7, 9]) // 9 works inside the folder; 20 is the live tmux server's
  assert.deepEqual(leftoverGroups(rows, root, new Set([9]), 9, born), [7]) // never the test's own group
})
test('Bug 199: stopping a test HQ leaves alone a process group that was there before it, even with a process working in its folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-b199-')), go = path.join(dir, 'go')
  const old = spawn('/bin/sh', ['-c', `while [ ! -s "${go}" ]; do sleep 0.1; done; (cd "$(cat "${go}")" && exec sleep 120) & wait`], { detached: true, stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 2100)) // real-time: older than the test HQ by whole seconds, as ps counts them
    const mine = await startHq()
    fs.writeFileSync(go, mine.root)
    const lsof = () => { try { return execFileSync('lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: 1 << 26 }) } catch (e) { return String((e as { stdout?: string }).stdout ?? '') } }
    const inRoot = await waitFor('the old group\'s process to work in the test HQ\'s folder', () => pidsUnder(lsof(), mine.root)[0])
    await mine.stop()
    assert.doesNotThrow(() => process.kill(old.pid!, 0), 'the older group is still there')
    assert.doesNotThrow(() => process.kill(inRoot, 0), 'and so is its process in the folder')
  } finally { try { process.kill(-old.pid!, 'SIGKILL') } catch { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }) }
})

// Bug 113: a test file whose teardown never ended held CI for 16 minutes. stubborn.mjs makes the backend misbehave.
const STUBBORN = pathToFileURL(path.join(import.meta.dirname, 'stubborn.mjs')).href
const stubborn = (how: string, more: NodeJS.ProcessEnv = {}) => startHq({ env: { NODE_OPTIONS: `--import=${STUBBORN}`, HQ_STUBBORN: how, ...more } })
const pipes = () => process.getActiveResourcesInfo().filter((r) => r === 'PipeWrap').length
/** The pipes of test HQs that earlier tests stopped have closed. Counted at the start of a test instead, the last test's two could still be closing
 *  (always, on Linux), and a count taken then is two too high: "nothing of it keeps this process alive, 4 !== 6". */
const settled = () => waitFor("earlier tests' test HQs to let go of their pipes", () => pipes() === steady, 5000)
test('Bug 113: a backend that won\'t stop on SIGTERM is killed after 10 s, and the test is told', async () => {
  const hq = await stubborn('term'), t0 = Date.now()
  await assert.rejects(hq.stop(), /didn't stop within 10 s of SIGTERM, so it was killed/)
  assert.ok(Date.now() - t0 < 20_000, `stopped in ${Date.now() - t0} ms`)
})
test('Bug 113: a process that keeps the backend\'s output can\'t keep the test file running: its pipes close, and the test is told', async () => {
  await settled(); const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-stubborn-')), 'pid'), before = pipes()
  const hq = await stubborn('pipe', { HQ_STUBBORN_PID: pidFile }), pid = Number(fs.readFileSync(pidFile, 'utf8'))
  try {
    assert.equal(pipes(), before + 2, "the backend's output and errors")
    await assert.rejects(hq.stop(), /still held its output 3 s after it stopped/)
    process.kill(pid, 0) // still running: only the harness's end of its pipes went
    await waitFor('nothing of it to keep this process alive', () => pipes() === before, 2000)
  } finally { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } fs.rmSync(path.dirname(pidFile), { recursive: true, force: true }) }
})
test('Bug 113: backends that stop cleanly, a restarted one\'s first run too, stop with nothing said', async () => {
  const hq = await startHq(); await hq.restart(); await hq.stop()
})

test('Bug 166: a backend that doesn\'t listen in time is stopped, with its tmux server, its folders and its pipes, before the start fails', async () => {
  await settled(); const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-deaf-')), 'pids'), before = pipes(), t0 = Date.now()
  // This start's tmux folder goes into a folder of the test's own. Every test HQ of every test file puts its folder into the shared one, so a
  // count of that one changed whenever another file started or stopped a test HQ meanwhile ("its tmux folder went, 13 !== 12", now and then).
  const short = fs.mkdtempSync(path.join(process.env.HQ_SHORT_TMPDIR ?? '/tmp', 'hq-b166-')), was = process.env.HQ_SHORT_TMPDIR
  process.env.HQ_SHORT_TMPDIR = short
  try {
    await assert.rejects(startHq({ env: { NODE_OPTIONS: `--import=${STUBBORN}`, HQ_STUBBORN: 'deaf', HQ_STUBBORN_PID: pidFile }, startMs: 3000 }),
      /timed out waiting for the backend to listen on its ports/)
    assert.ok(Date.now() - t0 < 15_000, `failed in ${Date.now() - t0} ms`)
    const { backend, tmux } = JSON.parse(fs.readFileSync(pidFile, 'utf8')), alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    assert.equal(alive(backend), false, 'the backend was stopped'); assert.equal(alive(tmux), false, 'its tmux server was stopped')
    assert.equal(pipes(), before, 'nothing of it keeps this process alive'); assert.deepEqual(fs.readdirSync(short), [], 'its tmux folder went')
  } finally {
    if (was === undefined) delete process.env.HQ_SHORT_TMPDIR; else process.env.HQ_SHORT_TMPDIR = was
    try { for (const pid of Object.values(JSON.parse(fs.readFileSync(pidFile, 'utf8'))) as number[]) process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    fs.rmSync(path.dirname(pidFile), { recursive: true, force: true }); fs.rmSync(short, { recursive: true, force: true })
  }
})

// A test that fails keeps what its test HQ printed, in a file of its own. Before, every test HQ of every test file wrote the one
// hq-e2e-last.log, so the log left after a failure was nearly always another test's.
test('a failed test keeps what its test HQ printed during it, in a file named in its output; a passing test leaves none, and old ones go', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-faillog-')), outer = path.join(dir, 'outer'), file = path.join(dir, 'boxes.test.ts')
  const kept = path.join(outer, 'hq-e2e-failed', path.basename(path.resolve(import.meta.dirname, '../..')))
  const write = (two: number) => fs.writeFileSync(file, `import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'harness.ts')).href)}
let hq
before(async () => { hq = await startHq() }); after(async () => { await hq.stop() })
test('this one passes', async () => { assert.equal((await hq.api('state')).status, 200) })
test('this one: 1 is not 2', async () => { await hq.restart(); assert.equal(1, ${two}) })
`)
  const run = () => { // a runner of its own, as `node --test` starts one: this file runs under a runner itself
    const env: NodeJS.ProcessEnv = { ...process.env, HQ_OUTER_TMPDIR: outer, HQ_E2E_LOG_TAIL: '4' }; delete env.NODE_TEST_CONTEXT; delete env.CI
    return spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-timeout=120000', '--test-force-exit', file], { env, encoding: 'utf8', timeout: 100_000 })
  }
  try {
    fs.mkdirSync(outer); write(2)
    const r = run(); assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(fs.readdirSync(kept), ['boxes--this-one-1-is-not-2.log'], 'the failed test has one, the passing one none')
    const log = fs.readFileSync(path.join(kept, 'boxes--this-one-1-is-not-2.log'), 'utf8')
    assert.match(log, /^this one: 1 is not 2\nExpected values to be strictly equal/)
    assert.equal(log.split('HQ backend up.').length - 1, 1, `only what was printed since the test began (the restart, not the first start):\n${log}`)
    assert.ok(r.stdout.includes(`what the test HQ printed during this test: ${path.join(kept, 'boxes--this-one-1-is-not-2.log')}`), r.stdout)
    assert.match(r.stdout, /\[the test HQ's output, "this one: 1 is not 2"\]/) // HQ_E2E_LOG_TAIL: the end of it in the run's own output too
    write(1); const again = run(); assert.equal(again.status, 0, again.stdout + again.stderr)
    assert.deepEqual(fs.readdirSync(kept), [], "the file's old one went when the file ran again")
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// One real failure, then a row of false ones: a test that failed while its test HQ's backend was down left it down for the rest of the file.
test('a test that ends with its test HQ down does not take the tests after it with it: the backend is started again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-leftdown-')), file = path.join(dir, 'down.test.ts')
  fs.writeFileSync(file, `import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'harness.ts')).href)}
let hq
before(async () => { hq = await startHq() }); after(async () => { await hq.stop() })
test('fails with the backend down', async () => { await hq.down(); assert.equal(1, 2); await hq.up() })
test('the next test finds it up', async () => { assert.equal((await hq.api('state')).status, 200) })
test('one that takes it down and up itself is left alone', async () => { await hq.down(); await hq.up(); assert.equal((await hq.api('state')).status, 200) })
`)
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HQ_OUTER_TMPDIR: dir, HQ_E2E_LOG_TAIL: '0' }; delete env.NODE_TEST_CONTEXT; delete env.CI
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-timeout=120000', '--test-force-exit', file], { env, encoding: 'utf8', timeout: 100_000 })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /^ℹ pass 2$/m, r.stdout); assert.match(r.stdout, /^ℹ fail 1$/m, r.stdout)
    assert.equal(r.stdout.split('the backend was started again for the tests after it').length - 1, 1, r.stdout) // said once, by the test that left it down
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// Bug 158: a connection of a test's own failed at once with "database is locked" whenever HQ was writing: now and then, on a busy machine.
test("Bug 158: tests reach HQ's database only through hq.db(), which waits out HQ's write lock as HQ's own connection does", () => {
  const dir = import.meta.dirname, files = fs.readdirSync(dir).filter((f) => /\.(ts|mts|mjs)$/.test(f) && f !== 'harness.ts')
  assert.ok(files.length > 50 && files.includes('auto.test.ts'), `the scan found ${files.length} files: it no longer reads the tests`)
  const own = files.filter((f) => /new DatabaseSync\(|['"`]sqlite3['"`]/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
  assert.deepEqual(own, [], 'open it with hq.db(): a plain open fails with "database is locked" while HQ writes')
  const db = hq.db(); try { assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000) } finally { db.close() }
})

/** Something else listening on `port`, as another test HQ's hooks server would. */
const squat = (port: number): Promise<net.Server> => new Promise((resolve, reject) => {
  const s = net.createServer((c) => c.end('HTTP/1.1 404 Not Found\r\ncontent-length: 2\r\n\r\n{}')); s.on('error', reject); s.listen(port, '127.0.0.1', () => resolve(s))
})
const closed = (s: net.Server) => new Promise((r) => s.close(r))
const freeNow = async (): Promise<number> => { const s = await squat(0), p = (s.address() as net.AddressInfo).port; await closed(s); return p }

test('lockOf asks git again when a lock went while git was reading it, and only then', () => {
  const dir = hq.repo('lockrace'), wt = path.join(dir, 'wt'), bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-fakegit-')), count = path.join(bin, 'count')
  sh(dir, 'worktree', 'add', '-q', '-b', 'side', wt); sh(dir, 'worktree', 'lock', '--reason', 'held by a test', wt)
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), PATH = process.env.PATH
  /** A git that fails its first `fails` calls with `says`, then is the real one. */
  const fake = (fails: number, says: string) => { fs.rmSync(count, { force: true }); fs.writeFileSync(path.join(bin, 'git'),
    `#!/bin/sh\nn=$(($(cat '${count}' 2>/dev/null || echo 0) + 1)); echo $n > '${count}'\nif [ $n -le ${fails} ]; then echo "${says}" >&2; exit 128; fi\nexec '${real}' "$@"\n`, { mode: 0o755 }) }
  const calls = () => Number(fs.readFileSync(count, 'utf8'))
  const gone = "fatal: failed to read '.git/worktrees/wt/locked': No such file or directory" // git's own words (bugs.test.ts in Linux CI)
  try {
    process.env.PATH = `${bin}:${PATH}`
    fake(2, gone); assert.equal(lockOf(dir, wt), 'held by a test'); assert.equal(calls(), 3)
    fake(0, gone); assert.equal(lockOf(dir, wt), 'held by a test'); assert.equal(calls(), 1) // the usual case: asked once
    fake(1, 'fatal: not a git repository'); assert.throws(() => lockOf(dir, wt), /not a git repository/); assert.equal(calls(), 1) // any other failure is the test's to see
    fake(9, gone); assert.throws(() => lockOf(dir, wt), /failed to read/); assert.equal(calls(), 5) // and not for ever
  } finally { process.env.PATH = PATH; fs.rmSync(bin, { recursive: true, force: true }) }
})

const listens = (port: number, host = '127.0.0.1') => new Promise<boolean>((resolve) => {
  const c = net.connect({ host, port }); c.once('connect', () => { c.destroy(); resolve(true) }); c.once('error', () => resolve(false))
})
test("Bugs 321, 325: a test HQ's ports are a block of its own, below the ports the OS hands out; no other process gets the block while it lives", async () => {
  const [lo, hi] = hq.env.HQ_PREVIEW_PORTS!.split('-').map(Number) as [number, number], first = lo - 4, block = (first - PORT_BLOCKS.from) / PORT_BLOCKS.size
  assert.equal(hi - lo, 9); assert.ok(Number.isInteger(block) && block >= 0 && block < PORT_BLOCKS.count, `${lo}-${hi}`)
  // Where the blocks are: under every OS's own range (Linux's is the lower), over HQ's windows for engineers, and not HQ's default 3090–3099
  const last = PORT_BLOCKS.from + PORT_BLOCKS.count * PORT_BLOCKS.size - 1
  assert.ok(last < EPHEMERAL_FROM, `${last}`); assert.ok(PORT_BLOCKS.count >= 200)
  assert.ok(PORT_BLOCKS.from > Math.max(...Array.from({ length: 200 }, (_, ui) => slotWindow(ui)[1])))
  // The block: the claim, held by this process; then HQ's own three, where its servers listen (Bug 325: no longer ports the OS picked, which
  // it hands to someone else while a test has its backend down); then the ten for HQ's apps, left free
  assert.equal(await listens(first), true)
  assert.deepEqual([hq.ports.ui, hq.ports.hooks, hq.ports.mcp], [first + 1, first + 2, first + 3]); for (const p of Object.values(hq.ports)) assert.equal(await listens(p), true, `${p}`)
  for (let p = lo; p <= hi; p++) assert.equal(await listens(p), false, `${p}`)

  // Another process that asks for this very block gets another one, whole
  const harness = JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'harness.ts')).href)
  const ask = `const h = await import(${harness}); const c = await h.claimPorts([], ${block}); console.log(c.block + ' ' + c.own[0] + '-' + c.range.split('-')[1]); c.release()`
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT // a plain script, not a test file of this run
  const [theirs, range] = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', ask], { env, encoding: 'utf8' }).trim().split(' ')
  assert.notEqual(Number(theirs), block); const [lo2, hi2] = range!.split('-').map(Number) as [number, number]
  assert.equal(hi2 - lo2, 12); assert.ok(hi2 < first || lo2 - 1 > hi, `${range} against ${first}-${hi}`)
  // So does this one; a block given back can be claimed again
  const second = await claimPorts([], block); assert.notEqual(second.block, block)
  assert.deepEqual(second.own, [1, 2, 3].map((i) => PORT_BLOCKS.from + second.block * PORT_BLOCKS.size + i)); assert.equal(Number(second.range.split('-')[0]), second.own[2] + 1)
  second.release(); const again = await claimPorts([], second.block); assert.equal(again.block, second.block)
  // A block with something of the user's listening inside it is passed over, and its claim is not kept
  const inside = PORT_BLOCKS.from + again.block * PORT_BLOCKS.size + 6; again.release()
  const users = net.createServer(); await new Promise<void>((r) => users.listen(inside, '::1', r)) // on IPv6 alone, as a dev server may be (Bug 44)
  try {
    const third = await claimPorts([], again.block); third.release(); assert.notEqual(third.block, again.block)
    assert.equal(await listens(inside - 6), false, 'the claim of the block it passed over is given back')
    // Nor is a block that holds a port the test gave its test HQ itself
    const next = (again.block + 1) % PORT_BLOCKS.count, given = PORT_BLOCKS.from + next * PORT_BLOCKS.size + 3
    const fourth = await claimPorts([given], next); fourth.release(); assert.notEqual(fourth.block, next)
  } finally { await new Promise((r) => users.close(r)) }
})

test('Bug 325: a test HQ comes back on the same ports after its backend was down, with other programs asking the OS for ports meanwhile', async () => {
  const before = { ...hq.ports }; await hq.down()
  try {
    // What took its port on Linux: listeners on "any port" while it was down. Sixty of them here, held together; none can be given one of its three
    const others = await Promise.all(Array.from({ length: 60 }, () => new Promise<net.Server>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => r(s)) })))
    try { for (const s of others) assert.ok(!Object.values(before).includes((s.address() as net.AddressInfo).port)) } finally { await Promise.all(others.map(closed)) }
  } finally { await hq.up() }
  assert.deepEqual(hq.ports, before); assert.equal((await hq.api('state')).status, 200)
})

test('Bug 92: a port taken before the backend listens gets new ports, so MCP calls reach HQ\'s MCP server', async () => {
  const taken = await freeNow(), other = await squat(taken)
  const hq = await startHq({ ports: { mcp: taken } })
  try {
    assert.notEqual(hq.ports.mcp, taken, 'it moved off the taken port')
    assert.equal(new Set(Object.values(hq.ports)).size, 3, 'three different ports')
    const said = `HQ can't start: one of its ports is not free.\n  port ${taken} (agents' tools (MCP), HQ_MCP_PORT) is in use by `
    assert.ok(hq.log().includes(said), 'the first try did hit it, and stopped')
    const repo = (await hq.api('repos', { path: hq.repo('ports') })).json
    const f = (await hq.api('features', { repoId: repo.id, title: 'Ports', request: 'Make a thing' })).json
    await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
    const r = await hq.mcp(f.tpm_agent_id, 'list_tickets'); assert.equal(r.isError, false, r.text)
  } finally { await hq.stop(); await closed(other) }
})

test('Bug 92: a restart whose port was taken meanwhile says so, rather than running without that server', async () => {
  const hq = await startHq()
  try {
    await hq.down(); const other = await squat(hq.ports.mcp)
    // The error also says what the program HQ found there is and what started it: here this test process itself, started by the test runner
    const said = new RegExp(`was taken while it was down:[^]*port ${hq.ports.mcp} \\(agents' tools[^]*its holder now[^\\n]*\\n\\s*${process.pid}\\s+${process.ppid}\\s[^]*`
      + `started by:\\n\\s*${process.ppid}\\s[^]*this test process is pid ${process.pid}$`)
    try { await assert.rejects(hq.up(), said) } finally { await closed(other) }
    await hq.up(); assert.equal((await hq.api('state')).status, 200, 'and it starts once the port is free')
  } finally { await hq.stop() }
})

test('Bug 118: a second backend on a running HQ\'s ports stops before it touches anything, naming each port and its holder', async () => {
  const hq = await startHq()
  try {
    const started = () => { // a backend that got past its port check would go on to say so
      const db = hq.db({ readOnly: true })
      try { return db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'backend.started'").get()!.n } finally { db.close() }
    }
    const before = started()
    const r = spawnSync(process.execPath, ['--experimental-strip-types', 'src/index.ts'], { cwd: path.resolve(import.meta.dirname, '..'), env: hq.env, encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.status, PORT_TAKEN_EXIT, r.stderr)
    assert.match(r.stderr, /^HQ can't start: its ports are not free\.$/m)
    const roles = { ui: 'the page and its API, HQ_UI_PORT', hooks: "agents' hooks, HQ_HOOKS_PORT", mcp: "agents' tools (MCP), HQ_MCP_PORT" }
    for (const [name, role] of Object.entries(roles)) {
      const line = `  port ${hq.ports[name as keyof typeof roles]} (${role}) is in use by node (pid `
      assert.ok(r.stderr.split('\n').some((l) => l.startsWith(line) && /\(pid \d+\)$/.test(l)), `${line}…\n${r.stderr}`)
    }
    assert.doesNotMatch(r.stdout, /HQ backend up/)
    assert.equal(started(), before, 'it stopped before writing anything')
    assert.equal((await hq.api('state')).status, 200, 'the running HQ carries on')
  } finally { await hq.stop() }
})

test('Bug 434: a port browsers and fetch refuse stops HQ at start-up, naming the port and its variable; the usual ports start it', async () => {
  const hq = await startHq()
  try {
    const started = () => { // a backend that got past its port check would go on to say so
      const db = hq.db({ readOnly: true })
      try { return db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'backend.started'").get()!.n } finally { db.close() }
    }
    await hq.down(); const before = started()
    const r = spawnSync(process.execPath, ['--experimental-strip-types', 'src/index.ts'], { cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...hq.env, HQ_UI_PORT: '6000', HQ_MCP_PORT: '6665' }, encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.status, PORT_TAKEN_EXIT, r.stderr)
    assert.match(r.stderr, /^HQ can't start: web browsers and fetch refuse to connect to some of its ports\.\n {2}port 6000 \(the page and its API, HQ_UI_PORT\)\n/m)
    assert.match(r.stderr, /^ {2}port 6665 \(agents' tools \(MCP\), HQ_MCP_PORT\)$/m)
    assert.doesNotMatch(r.stderr, new RegExp(`port ${hq.ports.hooks}`), 'its hooks port is a usual one')
    assert.doesNotMatch(r.stdout, /HQ backend up/)
    assert.equal(started(), before, 'it stopped before writing anything')
    await hq.up(); assert.equal((await hq.api('state')).status, 200, 'its own ports start it')
  } finally { await hq.stop() }
})

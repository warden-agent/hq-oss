// The harness itself: the fake Claude Code starts and reports in, the tests can act as an agent through its hooks and MCP
// tools, the plan gate holds and answers, and nothing reaches the live HQ.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { startHq, waitFor, exitPlanMode, pendingAfter, lockOf, leftoverGroups, type Hq } from './harness.ts'
import { pidsUnder } from '../src/procs.ts'
import { PORT_TAKEN_EXIT } from '../src/ports.ts'

let hq: Hq
before(async () => { hq = await startHq() })
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
  assert.equal(await pendingAfter(held, 500), true) // held for a verdict
  const review = await waitFor('the review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open'))
  assert.equal((await hq.api(`reviews/${review.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  const answer = await held
  assert.equal(answer.hookSpecificOutput.decision.behavior, 'allow'); assert.equal(answer.hookSpecificOutput.decision.updatedInput.plan, 'Plan: add b.txt')

  // Isolation: the agents live on the harness's own tmux server, and HQ's trust entries went to the harness's home only.
  assert.match(hq.tmux('ls'), new RegExp(`hq-${eng.id}`))
  const live = (() => { const e = { ...process.env }; delete e.TMUX_TMPDIR; delete e.TMUX; try { return execFileSync('tmux', ['ls'], { env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' } })()
  assert.doesNotMatch(live, new RegExp(`hq-${eng.id}`))
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
    await new Promise((r) => setTimeout(r, 2100)) // older than the test HQ by whole seconds, as ps counts them
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
test('Bug 113: a backend that won\'t stop on SIGTERM is killed after 10 s, and the test is told', async () => {
  const hq = await stubborn('term'), t0 = Date.now()
  await assert.rejects(hq.stop(), /didn't stop within 10 s of SIGTERM, so it was killed/)
  assert.ok(Date.now() - t0 < 20_000, `stopped in ${Date.now() - t0} ms`)
})
test('Bug 113: a process that keeps the backend\'s output can\'t keep the test file running: its pipes close, and the test is told', async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-stubborn-')), 'pid'), before = pipes()
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
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-deaf-')), 'pids'), before = pipes(), t0 = Date.now()
  const folders = () => fs.readdirSync(process.env.HQ_SHORT_TMPDIR ?? '/tmp').filter((d) => d.startsWith('hq-e2e-')).length, had = folders()
  try {
    await assert.rejects(startHq({ env: { NODE_OPTIONS: `--import=${STUBBORN}`, HQ_STUBBORN: 'deaf', HQ_STUBBORN_PID: pidFile }, startMs: 3000 }),
      /timed out waiting for the backend to listen on its ports/)
    assert.ok(Date.now() - t0 < 15_000, `failed in ${Date.now() - t0} ms`)
    const { backend, tmux } = JSON.parse(fs.readFileSync(pidFile, 'utf8')), alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    assert.equal(alive(backend), false, 'the backend was stopped'); assert.equal(alive(tmux), false, 'its tmux server was stopped')
    assert.equal(pipes(), before, 'nothing of it keeps this process alive'); assert.equal(folders(), had, 'its tmux folder went')
  } finally {
    try { for (const pid of Object.values(JSON.parse(fs.readFileSync(pidFile, 'utf8'))) as number[]) process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    fs.rmSync(path.dirname(pidFile), { recursive: true, force: true })
  }
})

/** Something else listening on `port`, as another test HQ's hooks server would. */
const squat = (port: number): Promise<net.Server> => new Promise((resolve, reject) => {
  const s = net.createServer((c) => c.end('HTTP/1.1 404 Not Found\r\ncontent-length: 2\r\n\r\n{}')); s.on('error', reject); s.listen(port, '127.0.0.1', () => resolve(s))
})
const closed = (s: net.Server) => new Promise((r) => s.close(r))
const freeNow = async (): Promise<number> => { const s = await squat(0), p = (s.address() as net.AddressInfo).port; await closed(s); return p }

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
    try { await assert.rejects(hq.up(), new RegExp(`was taken while it was down:[^]*port ${hq.ports.mcp} \\(agents' tools`)) } finally { await closed(other) }
    await hq.up(); assert.equal((await hq.api('state')).status, 200, 'and it starts once the port is free')
  } finally { await hq.stop() }
})

test('Bug 118: a second backend on a running HQ\'s ports stops before it touches anything, naming each port and its holder', async () => {
  const hq = await startHq()
  try {
    const started = () => { // a backend that got past its port check would go on to say so
      const db = new DatabaseSync(path.join(hq.hqHome, 'hq.sqlite'), { readOnly: true, timeout: 5000 })
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

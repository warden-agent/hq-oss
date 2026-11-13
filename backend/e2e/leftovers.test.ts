// Bug 75 end to end (see harness.ts): a server an engineer's Bash command left running in its worktree is stopped once the
// command ends, and when the engineer stops, its project is parked, cleared or removed, or HQ restarts; nothing still in use is
// touched, nor anything the user runs in the project's own folder.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
const pids: number[] = []
// a parked engineer is asked for a handoff note first; the fake one never writes it, so HQ stops it after this long
before(async () => { hq = await startHq({ env: { HQ_FRESH_START_TIMEOUT_S: '3' } }); await hq.api('settings', { key: 'concurrency_cap', value: 20 }) })
after(async () => { for (const p of pids) try { process.kill(p, 'SIGKILL') } catch { /* gone */ } await hq?.stop() })

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
let n = 0
/** `sleep …` started with `&` from a shell that then ends, in `cwd`: orphaned to init, like a test's server. */
function orphan(cwd: string): Promise<number> {
  const arg = `61.${process.pid % 1000}${++n}`
  return new Promise((resolve) => spawn('sh', ['-c', `sleep ${arg} &`], { cwd, detached: true, stdio: 'ignore' }).once('exit', () => setTimeout(() => {
    const pid = Number(execFileSync('ps', ['-axo', 'pid=,args=']).toString().split('\n').map((l) => l.trim()).find((l) => l.endsWith(` sleep ${arg}`))?.split(/\s+/)[0] ?? 0)
    pids.push(pid); resolve(pid)
  }, 200)))
}
async function engineer(name: string) {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id)?.status === 'working')
  const wt = (await hq.state()).tickets.find((x: any) => x.id === t.id).worktree_path as string
  return { repo, eng, wt }
}
const bash = (agentId: string, ev: 'PreToolUse' | 'PostToolUse', command = 'npm test', use?: string) =>
  hq.hook(agentId, { hook_event_name: ev, tool_name: 'Bash', tool_input: { command }, ...(use ? { tool_use_id: use } : {}) })
const gone = (pid: number, ms = 12_000) => waitFor(`pid ${pid} to be stopped`, () => !alive(pid), ms)

test('a command\'s leftover goes once the command ends; nothing in use, and nothing of the user\'s, is touched', async () => {
  const { repo, eng, wt } = await engineer('left-cmd')
  const users = await orphan(repo.path) // the user's own server, in the project's folder
  const held = spawn('sleep', ['61.9'], { cwd: wt, detached: true, stdio: 'ignore' }); pids.push(held.pid!) // its parent is alive

  await bash(eng.id, 'PreToolUse'); const left = await orphan(wt) // orphaned while the engineer's command still runs
  await new Promise((r) => setTimeout(r, 4000)); assert.ok(alive(left), 'kept while a command of its engineer runs')
  await bash(eng.id, 'PostToolUse'); await gone(left)
  const ev = await waitFor('the clean-up in the event log', async () => (await hq.api('events?limit=200')).json.find((e: any) => e.kind === 'procs.leftovers_stopped'))
  assert.ok(JSON.parse(ev.payload).stopped.some((x: any) => x.pids.includes(left) && x.folder === wt.split('/').at(-1)), ev.payload)
  assert.ok(alive(users), "the user's own server in the project folder"); assert.ok(alive(held.pid!), 'one with a live parent')
  assert.ok(!(await hq.state()).attention.some((a: any) => /^leftovers_/.test(a.kind)), 'no alert when it worked')
})

test('commands one after another: an earlier one\'s leftover goes while the next runs; the next one\'s own waits for it to end', async () => {
  const { eng, wt } = await engineer('left-next')
  await bash(eng.id, 'PreToolUse', 'npm test', 'u1'); const first = await orphan(wt)
  await new Promise((r) => setTimeout(r, 3500)) // ps gives start times in whole seconds: clearly older than the next command
  await bash(eng.id, 'PostToolUse', 'npm test', 'u1'); await bash(eng.id, 'PreToolUse', 'npm run lint', 'u2') // no gap, as when Claude Code runs a list of commands
  const own = await orphan(wt); await gone(first)
  await new Promise((r) => setTimeout(r, 3000)); assert.ok(alive(own), 'what the running command started is kept')
  await bash(eng.id, 'PostToolUse', 'npm run lint', 'u2'); await gone(own)
})

test('Bug 100: commands that overlap end by their ids; the look after each finds what that one left, not the one still running', async () => {
  const { eng, wt } = await engineer('left-ids')
  await bash(eng.id, 'PreToolUse', 'npm run dev', 'a1'); const daemon = await orphan(wt) // a long command (a subagent's, say) and its daemon
  await new Promise((r) => setTimeout(r, 3500)) // ps gives start times in whole seconds: clearly older than a2
  await bash(eng.id, 'PreToolUse', 'npm test', 'a2'); await bash(eng.id, 'PostToolUse', 'npm test', 'a2') // a2 ends first: by its id, a1 still runs
  await new Promise((r) => setTimeout(r, 4000)); assert.ok(alive(daemon), 'a1 still runs: what it started is its own')
  await bash(eng.id, 'PostToolUse', 'npm run dev', 'a1'); await gone(daemon) // the look after a1 asks about everything since a1 began
})

test('a command HQ never hears the end of (refused, or its hook lost) puts the clean-up off only until the turn ends', async () => {
  const { eng, wt } = await engineer('left-refused')
  await bash(eng.id, 'PreToolUse', 'git push'); const left = await orphan(wt) // no PostToolUse follows
  await bash(eng.id, 'PreToolUse'); await bash(eng.id, 'PostToolUse')
  await new Promise((r) => setTimeout(r, 4000)); assert.ok(alive(left), 'kept: for all HQ knows the first command is still running')
  await hq.hook(eng.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' }); await gone(left)
})

test("Try it on a ticket: what the app put in the background stays; what the engineer's commands leave there still goes", async () => {
  const { repo, eng, wt } = await engineer('left-try')
  execFileSync('git', ['-C', wt, 'commit', '-q', '--allow-empty', '-m', 'done'])
  assert.equal((await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })).isError, false)
  assert.equal((await hq.mcp(eng.id, 'open_pr', { title: 'done', body: 'done\n\n## Deviations from approved plan\nNone' })).isError, false)
  const ticket = (await hq.state()).tickets.find((t: any) => t.worktree_path === wt).id
  await hq.api(`previews/${repo.id}/command`, { command: 'npm start' })
  const r = await hq.api(`previews/${repo.id}/start`, { ticket }); assert.equal(r.status, 200, JSON.stringify(r.json))
  const apps = await orphan(wt) // began while the app was starting: for all HQ knows, the app's own database
  const preview = async () => (await hq.state()).previews.find((p: any) => p.id === repo.id)
  const p = await waitFor('the app to answer', async () => { const x = await preview(); return x?.status === 'running' ? x : null }, 20_000)
  await new Promise((r) => setTimeout(r, 4000)) // ps gives start times in whole seconds: clearly after the start-up

  await bash(eng.id, 'PreToolUse'); const left = await orphan(wt); await bash(eng.id, 'PostToolUse') // the user asked for a change: tests run again
  await gone(left); assert.ok(alive(apps), "the app's own"); assert.equal((await fetch(p.url)).status, 200)
  assert.equal((await preview()).ticket_id, ticket)
  assert.equal((await hq.api(`previews/${repo.id}/start`, { ticket: null })).status, 200) // Back to main: nothing is using that folder now
  await gone(apps) // the run on the ticket is over: what it put in the background goes with it (Bug 100: not left to the next look)
})

test('stopping an engineer, or switching away from its project, stops what it left (even mid-command)', async () => {
  const a = await engineer('left-stop')
  await bash(a.eng.id, 'PreToolUse'); const left = await orphan(a.wt) // the hook for the command's end never comes
  assert.equal((await hq.api(`agents/${a.eng.id}/stop`, {})).status, 200); await gone(left, 15_000)

  const b = await engineer('left-park')
  await bash(b.eng.id, 'PreToolUse'); const left2 = await orphan(b.wt)
  await hq.api(`repos/${b.repo.id}/park`, {}) // what the UI does when the user switches to another project
  await waitFor('the engineer to stop', async () => (await hq.state()).agents.find((x: any) => x.id === b.eng.id)?.status === 'exited', 30_000)
  await gone(left2, 15_000)
})

test('Clear and Remove from HQ stop what was left in the worktrees, before the folders go', async () => {
  const c = await engineer('left-clear')
  await bash(c.eng.id, 'PreToolUse'); const left = await orphan(c.wt)
  await hq.api(`agents/${c.eng.id}/stop`, {}); assert.equal((await hq.api(`repos/${c.repo.id}/clear`, {})).status, 200)
  await gone(left, 15_000)

  const r = await engineer('left-remove')
  await bash(r.eng.id, 'PreToolUse'); const left2 = await orphan(r.wt)
  assert.equal((await hq.api(`repos/${r.repo.id}/remove`, {})).status, 200)
  await gone(left2, 15_000)
})

test('what was left while HQ was down goes when it starts again', async () => {
  const { eng, wt } = await engineer('left-restart')
  await bash(eng.id, 'PreToolUse'); const left = await orphan(wt) // HQ forgets the running command when it restarts
  await hq.restart(); await gone(left, 20_000)
})

test('Bug 81: an engineer\'s own temp folder outlives an HQ restart while it runs, and goes with what was left in it once it stops', async () => {
  const { eng } = await engineer('tmp-stop')
  const tmp = /^export CLAUDE_CODE_TMPDIR='(.+)'$/m.exec(fs.readFileSync(path.join(hq.hqHome, 'agents', eng.id, 'launch.sh'), 'utf8'))?.[1]
  assert.ok(tmp && fs.statSync(tmp).isDirectory() && (fs.statSync(tmp).mode & 0o777) === 0o700, tmp)
  const coverage = path.join(tmp, `claude-${process.getuid?.()}`, 'node-coverage-1'); fs.mkdirSync(coverage, { recursive: true })
  fs.writeFileSync(path.join(coverage, 'coverage-1.json'), 'x'.repeat(1_000_000)) // what a killed `--experimental-test-coverage` run leaves
  await hq.restart(); assert.equal(fs.existsSync(coverage), true)
  assert.equal((await hq.api(`agents/${eng.id}/stop`, {})).status, 200)
  await waitFor('the folder to go', () => !fs.existsSync(tmp), 15_000)
})

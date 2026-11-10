// The Launch helper (Bug 37), end to end with a fake Claude (see harness.ts): Launch on an app HQ can't start by itself (an API
// and a page in subfolders, the API on a port the page hard-wires) starts a helper; its steps wait for the user's OK; HQ stops
// the helper's leftover test server, runs the steps for real and tells the helper; launch_ok ends it. Later Launches need no
// helper; a held fixed port is named; "Ask Claude to fix it" briefs a new helper; "Not now" keeps the steps; saves are capped.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
const kids: ChildProcess[] = []
before(async () => { hq = await startHq() })
after(async () => { for (const k of kids) { try { process.kill(-k.pid!, 'SIGKILL') } catch { /* gone */ } } await hq?.stop() })

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
})
const preview = async (repoId: string) => (await hq.state()).previews.find((p: any) => p.id === repoId)
const page = async (url: string) => (await fetch(url)).text()
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
/** A server that just holds `port`, run from `cwd` in its own process group (like a test server the helper left behind). */
function holder(cwd: string, port: number): ChildProcess {
  const k = spawn(process.execPath, ['-e', `require('http').createServer((q, s) => s.end('someone else')).listen(${port}, '127.0.0.1')`], { cwd, detached: true, stdio: 'ignore' })
  kids.push(k); return k
}
/** The mod hands the helper its next batch and Claude Code submits it. */
async function nextBatch(agentId: string): Promise<string> {
  const b = await waitFor('a batch for the helper', async () => (await hq.modNext(agentId)).batch)
  await hq.modEvent(agentId, { kind: 'batch_received', id: b.id }); await hq.hook(agentId, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
  return b.text
}

test('Bug 37: Launch asks Claude, the user OKs its steps once, and HQ runs a two-part app from then on', async () => {
  const api = await freePort()
  const dir = hq.repo('split')
  fs.rmSync(path.join(dir, 'package.json')); fs.rmSync(path.join(dir, 'server.js')) // nothing at the root HQ could guess from
  for (const [f, t] of Object.entries({
    '.gitignore': 'node_modules/\ndata/\napi/.env\n',
    'api/server.js': "require('http').createServer((q, s) => s.end(require('fs').readFileSync(__dirname + '/.env', 'utf8').trim())).listen(process.env.PORT, '127.0.0.1')\n",
    'web/server.js': "require('http').createServer(async (q, s) => s.end('page:' + await (await fetch('http://127.0.0.1:' + process.env.HQ_PORT_API)).text())).listen(process.env.PORT, '127.0.0.1')\n",
  })) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t) }
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'split app')
  fs.writeFileSync(path.join(dir, 'api', '.env'), 'GREETING=hello from env')
  const repo = (await hq.api('repos', { path: dir })).json
  const recipe = {
    parts: [{ name: 'api', dir: 'api', run: 'node server.js', port: api }, { name: 'web', dir: 'web', run: 'node server.js', port: 'auto' }],
    show: 'web', worktree_files: ['api/.env'], notes: `The page calls the API on ${api}.`,
  }

  // Launch with nothing to run: a helper starts in its own worktree, briefed with the project
  const r = await hq.api(`previews/${repo.id}/start`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.helper_state, 'working'); assert.equal(r.json.status, 'stopped')
  const helper = r.json.helper_agent_id, wt = r.json.helper_worktree
  assert.match(helper, /^launch-/); assert.ok(fs.existsSync(path.join(wt, 'web', 'server.js'))); assert.match(wt, /\.claude\/worktrees\/launch-/)
  await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === helper && a.role === 'launcher' && a.status !== 'launching'))
  assert.match(await nextBatch(helper), /Project: split\. Work out how to start/)
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id, helper) // a second click doesn't start another
  const errs = async () => (await hq.api('events?limit=100')).json.filter((e: any) => e.kind === 'preview.error').map((e: any) => JSON.parse(e.payload))
  assert.deepEqual(await errs(), []) // Bug 39: handing over to the helper is the normal path, not a failed start

  // A recipe that doesn't fit the repo is refused and doesn't count; a good one waits for the user's OK
  const bad = await hq.mcp(helper, 'save_launch', { ...recipe, parts: [{ name: 'web', dir: 'nope', run: 'x', port: 'auto' }] })
  assert.ok(bad.isError); assert.match(bad.text, /folder nope doesn't exist/)
  const leftover = holder(path.join(wt, 'api'), api) // the helper's own test server, which its sandbox couldn't stop
  await waitFor('the leftover to listen', async () => (await fetch(`http://127.0.0.1:${api}`).catch(() => null))?.ok)
  const saved = await hq.mcp(helper, 'save_launch', recipe); assert.equal(saved.isError, false, saved.text); assert.match(saved.text, /waiting|OK/)
  let p = await preview(repo.id)
  assert.equal(p.helper_state, 'needs_ok'); assert.equal(p.helper_saves, 1); assert.deepEqual(p.draft_recipe.parts.map((x: any) => x.name), ['api', 'web']); assert.equal(p.recipe, null)
  assert.ok((await hq.state()).attention.some((a: any) => a.kind === `repo_launch:${repo.id}` && /OK them/.test(a.detail)))
  assert.match((await hq.mcp(helper, 'launch_ok')).text, /still waiting for the user's OK/)

  // OK: the leftover goes, the app runs from main, and the helper hears how it went
  assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  p = await waitFor('the app to run', async () => { const x = await preview(repo.id); return x.status === 'running' ? x : null }, 20_000)
  assert.equal(await page(p.url), 'page:GREETING=hello from env'); assert.equal(p.recipe.show, 'web'); assert.equal(p.draft_recipe, null)
  assert.ok(!alive(leftover.pid!), 'the helper\'s leftover test server was stopped')
  assert.ok(!(await hq.state()).attention.some((a: any) => a.kind === `repo_launch:${repo.id}`), 'the OK notice is resolved')
  const result = await nextBatch(helper)
  assert.match(result, /the page answered at http:\/\/localhost:\d+\/\. Last output:/); assert.match(result, /launch_ok/)
  assert.equal((await hq.mcp(helper, 'launch_ok')).isError, false)
  await waitFor('the helper to go', async () => (await hq.state()).agents.find((a: any) => a.id === helper)?.status === 'exited')
  await waitFor('its worktree to go', () => !fs.existsSync(wt))
  await waitFor('its branch to go', () => sh(dir, 'branch', '--list', 'hq-launch/*') === '') // removed just after the folder
  p = await preview(repo.id); assert.equal(p.status, 'running'); assert.equal(p.helper_state, null); assert.equal(p.helper_agent_id, null)

  // From now on Launch just runs it: no helper
  const launchers = async () => (await hq.state()).agents.filter((a: any) => a.role === 'launcher').length
  await hq.api(`previews/${repo.id}/stop`, {}); assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
  p = await waitFor('the app again', async () => { const x = await preview(repo.id); return x.status === 'running' ? x : null }, 20_000)
  assert.equal(await page(p.url), 'page:GREETING=hello from env'); assert.equal(await launchers(), 1)

  // The user's own server on the API's port: HQ names it and doesn't start a half-wired app
  await hq.api(`previews/${repo.id}/stop`, {})
  const theirs = holder(dir, api); await waitFor('their server', async () => (await fetch(`http://127.0.0.1:${api}`).catch(() => null))?.ok)
  const taken = await hq.api(`previews/${repo.id}/start`, {}); assert.equal(taken.status, 409)
  assert.match(taken.json.error, new RegExp(`port ${api} \\(api\\) is being used by node in split \\(pid ${theirs.pid}\\)\\. Stop it here, then Launch`))
  assert.deepEqual((await errs()).map((p: any) => [p.repo, /is being used by node/.test(p.error)]), [['split', true]]) // Bug 39: the refused start is on record
  process.kill(-theirs.pid!, 'SIGKILL'); await waitFor('their server to stop', async () => !(await fetch(`http://127.0.0.1:${api}`).catch(() => null)))

  // Ask Claude to fix it: a new helper gets the old steps and the app's output; "Not now" keeps its steps for later
  const fix = (await hq.api(`previews/${repo.id}/setup`, { why: 'fix' })).json
  assert.notEqual(fix.helper_agent_id, helper); assert.equal(fix.helper_saves, 0)
  await waitFor('the fix helper', async () => (await hq.state()).agents.find((a: any) => a.id === fix.helper_agent_id && a.status !== 'launching'))
  assert.match(await nextBatch(fix.helper_agent_id), /stopped working\. They were:[\s\S]*"show": "web"/)
  const moved = { ...recipe, notes: 'same commands, new words' }
  const again = await hq.mcp(fix.helper_agent_id, 'save_launch', { ...moved, parts: [recipe.parts[0], { ...recipe.parts[1], run: 'PAGE=1 node server.js' }] })
  assert.equal(again.isError, false); assert.equal((await preview(repo.id)).helper_state, 'needs_ok')
  assert.equal((await hq.api(`previews/${repo.id}/dismiss`, {})).status, 200)
  await waitFor('the fix helper to go', async () => (await hq.state()).agents.find((a: any) => a.id === fix.helper_agent_id)?.status === 'exited')
  p = await preview(repo.id); assert.equal(p.helper_state, 'needs_ok'); assert.equal(p.draft_recipe.parts[1].run, 'PAGE=1 node server.js')
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id, null) // Launch shows the waiting steps, no new helper
  assert.equal(await launchers(), 2)
  assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200) // OK'd later, with no helper around
  p = await waitFor('the OK\'d steps to run', async () => { const x = await preview(repo.id); return x.status === 'running' && x.recipe.parts[1].run === 'PAGE=1 node server.js' ? x : null }, 20_000)
  assert.equal(p.helper_state, null)
})

test('Bug 37: a helper gets four saves; report_cant_start tells the user why', async () => {
  const dir = hq.repo('capped'); const repo = (await hq.api('repos', { path: dir })).json
  const one = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port: 'auto' }], show: 'app', worktree_files: [], notes: '' }
  const h = (await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id
  await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching'))
  for (let i = 1; i <= 4; i++) assert.equal((await hq.mcp(h, 'save_launch', { ...one, notes: `try ${i}`, parts: [{ ...one.parts[0], run: `node server.js # ${i}` }] })).isError, false)
  const fifth = await hq.mcp(h, 'save_launch', one); assert.ok(fifth.isError); assert.match(fifth.text, /HQ allows 4/)
  await waitFor('the capped helper to go', async () => (await preview(repo.id)).helper_state === 'failed')
  assert.ok((await hq.state()).attention.some((a: any) => a.kind === `repo_launch:${repo.id}` && /tried 4 times/.test(a.detail)))

  const h2 = (await hq.api(`previews/${repo.id}/setup`, {})).json.helper_agent_id
  await waitFor('the second helper', async () => (await hq.state()).agents.find((a: any) => a.id === h2 && a.status !== 'launching'))
  assert.equal((await hq.mcp(h2, 'save_launch', one)).isError, false) // a guess it then gives up on
  assert.equal((await hq.mcp(h2, 'report_cant_start', { reason: 'It needs a Postgres database, which isn\'t installed.' })).isError, false)
  const p = await waitFor('can\'t start', async () => { const x = await preview(repo.id); return x.helper_state === 'cant_start' ? x : null })
  assert.match(p.helper_note, /Postgres/); assert.equal(p.draft_recipe, null) // nothing left to OK
  await waitFor('the second helper to go', async () => (await hq.state()).agents.find((a: any) => a.id === h2)?.status === 'exited')
  const h3 = (await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id // Launch tries again with a new helper
  assert.ok(h3 && h3 !== h2)
})

test('Bug 41: two Launches at once start one helper; a helper HQ lost track of is stopped with its test servers', async () => {
  const dir = hq.repo('twice'); const repo = (await hq.api('repos', { path: dir })).json
  fs.rmSync(path.join(dir, 'package.json')); sh(dir, 'commit', '-qam', 'nothing to guess from')
  const [a, b] = await Promise.all([hq.api(`previews/${repo.id}/start`, {}), hq.api(`previews/${repo.id}/start`, {})])
  assert.equal(a.status, 200, JSON.stringify(a.json)); assert.equal(b.status, 200, JSON.stringify(b.json))
  assert.ok(a.json.helper_agent_id); assert.equal(b.json.helper_agent_id, a.json.helper_agent_id)
  const started = async () => (await hq.api('events?limit=200')).json.filter((e: any) => e.kind === 'launch.helper_started' && JSON.parse(e.payload).repo === 'twice').length
  assert.equal(await started(), 1)
  const live = async () => (await hq.state()).agents.filter((x: any) => x.role === 'launcher' && x.cwd === dir && x.status !== 'exited').map((x: any) => x.id)
  assert.deepEqual(await live(), [a.json.helper_agent_id])

  // The state the race used to leave: a live helper the repo's row no longer points at, its test server still on a port
  const old = a.json.helper_agent_id, wt = a.json.helper_worktree, port = await freePort()
  await waitFor('the helper', async () => (await hq.state()).agents.find((x: any) => x.id === old && x.status !== 'launching'))
  const stray = holder(path.join(wt), port); await waitFor('the stray server', async () => (await fetch(`http://127.0.0.1:${port}`).catch(() => null))?.ok)
  const db = new DatabaseSync(path.join(hq.hqHome, 'hq.sqlite'))
  db.prepare('UPDATE previews SET helper_agent_id = NULL, helper_worktree = NULL, helper_state = NULL WHERE id = ?').run(repo.id); db.close()
  const next = (await hq.api(`previews/${repo.id}/setup`, {})).json.helper_agent_id
  assert.ok(next && next !== old)
  await waitFor('the stray helper to stop', async () => (await hq.state()).agents.find((x: any) => x.id === old)?.status === 'exited')
  assert.deepEqual(await live(), [next])
  await waitFor('its test server to stop', () => !alive(stray.pid!))
  assert.ok(!fs.existsSync(wt), 'its worktree is gone')
})

test('Bug 42: a busy port names whose program holds it, and Stop it and Launch frees it and starts the app', async () => {
  const port = await freePort(), dir = hq.repo('held'); const repo = (await hq.api('repos', { path: dir })).json
  fs.rmSync(path.join(dir, 'package.json')); sh(dir, 'commit', '-qam', 'nothing to guess from')
  const one = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port }], show: 'app', worktree_files: [], notes: '' }
  const h = (await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id
  await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching'))
  assert.equal((await hq.mcp(h, 'save_launch', one)).isError, false); assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  await waitFor('the app', async () => (await preview(repo.id)).status === 'running', 20_000)
  assert.equal((await hq.mcp(h, 'launch_ok')).isError, false)
  await waitFor('the helper to go', async () => (await preview(repo.id)).helper_agent_id === null)
  await hq.api(`previews/${repo.id}/stop`, {})
  const up = () => waitFor('the holder to listen', async () => (await fetch(`http://127.0.0.1:${port}`).catch(() => null))?.ok)
  const launch = () => hq.api(`previews/${repo.id}/start`, {})
  const freed = async () => (await hq.api('events?limit=100')).json.filter((e: any) => e.kind === 'preview.port_freed').map((e: any) => JSON.parse(e.payload))

  // Another folder: named by its folder; a pid HQ didn't show is refused and nothing stops
  const elsewhere = path.join(hq.root, 'elsewhere'); fs.mkdirSync(elsewhere)
  const other = holder(elsewhere, port); await up()
  let r = await launch(); assert.equal(r.status, 409)
  let p = await preview(repo.id)
  assert.deepEqual(p.port_holders.map((x: any) => [x.kind, x.pid, x.port, x.part, x.cmd]), [['other', other.pid, port, 'app', 'node']])
  assert.match(p.detail, new RegExp(`port ${port} \\(app\\) is being used by node in ${elsewhere.replace(/[/.]/g, '\\$&')} \\(pid ${other.pid}\\)\\. Stop it here, then Launch\\.`))
  r = await hq.api(`previews/${repo.id}/free-port`, { pids: [other.pid! + 100000] }); assert.equal(r.status, 409); assert.match(r.json.error, /Something else holds the port now/)
  assert.ok(alive(other.pid!))
  r = await hq.api(`previews/${repo.id}/free-port`, { pids: [other.pid] }); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.ok(!alive(other.pid!)); assert.equal(r.json.port_holders, null)
  await waitFor('the app on its port', async () => (await preview(repo.id)).status === 'running', 20_000)
  assert.deepEqual((await freed()).map((x: any) => [x.repo, x.port, x.pid, x.kind]), [['held', port, other.pid, 'other']])
  await hq.api(`previews/${repo.id}/stop`, {})

  // The project's own folder, with a watcher that restarts its server: named as the project; the whole group is stopped
  const watcher = spawn(process.execPath, ['-e', `const { spawn } = require('child_process')
    const serve = "require('http').createServer((q, s) => s.end('w')).listen(${port}, '127.0.0.1')"
    const go = () => spawn(process.execPath, ['-e', serve], { stdio: 'ignore' }).on('exit', () => setTimeout(go, 100)); go()`],
  { cwd: path.join(dir), detached: true, stdio: 'ignore' }); kids.push(watcher); await up()
  assert.equal((await launch()).status, 409); p = await preview(repo.id)
  assert.deepEqual(p.port_holders.map((x: any) => [x.kind, x.name, x.pgid]), [['project', 'held', watcher.pid]])
  r = await hq.api(`previews/${repo.id}/free-port`, { pids: p.port_holders.map((x: any) => x.pid) }); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.ok(!alive(watcher.pid!), 'the watcher went with its server')
  await waitFor('the app again', async () => (await preview(repo.id)).status === 'running', 20_000)
  await hq.api(`previews/${repo.id}/stop`, {})

  // A Launch helper's leftover in this repo's launch-* worktree: HQ's own
  const left = path.join(dir, '.claude', 'worktrees', 'launch-old'); fs.mkdirSync(left, { recursive: true })
  const stale = holder(left, port); await up()
  assert.equal((await launch()).status, 409); p = await preview(repo.id)
  assert.deepEqual(p.port_holders.map((x: any) => [x.kind, x.name]), [['hq', 'an old Launch helper run of held']])
  assert.match(p.detail, new RegExp(`port ${port} \\(app\\) is taken by an old Launch helper run of held \\(node, pid ${stale.pid}\\)`))
  assert.equal((await hq.api(`previews/${repo.id}/free-port`, { pids: [stale.pid] })).status, 200)
  await waitFor('the app once more', async () => (await preview(repo.id)).status === 'running', 20_000)
})

test('Bug 67: Launch on a project with no files says so, with no helper and no tokens, and one inside another repo can offer that repo', async () => {
  const outer = hq.repo('bigclone'), known = (await hq.api('repos', { path: outer })).json
  const made = await hq.api('repos/new', { name: 'wrong place', parent: outer, github: false, nested: true }); assert.equal(made.status, 200, JSON.stringify(made.json))
  const id = made.json.id, dir = made.json.path, repoNow = async () => (await hq.state()).repos.find((r: any) => r.id === id)
  const helpers = async () => (await hq.state()).agents.filter((a: any) => a.role === 'launcher' && a.repo_id === id)
  assert.equal(made.json.empty, 1)
  fs.writeFileSync(path.join(dir, 'app.js'), 'x\n'); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'one file')
  const first = await hq.api(`previews/${id}/start`, {}); assert.match(first.json.helper_agent_id, /^launch-/) // a project with files: as before
  await waitFor('the helper', async () => (await helpers()).find((a: any) => a.status !== 'launching'))
  assert.equal((await hq.mcp(first.json.helper_agent_id, 'report_cant_start', { reason: 'Nothing to run.' })).isError, false)
  await waitFor('its notice', async () => (await hq.state()).attention.find((a: any) => a.kind === `repo_launch:${id}` && !a.resolved_at))
  await waitFor('the helper to go', async () => (await preview(id)).helper_agent_id === null)
  sh(dir, 'rm', '-q', 'app.js'); sh(dir, 'commit', '-qm', 'and it goes')
  const running = (await helpers()).filter((a: any) => a.status !== 'exited').length, total = (await helpers()).length

  const r = await hq.api(`previews/${id}/start`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.helper_state, 'empty'); assert.equal(r.json.helper_agent_id, null); assert.equal(r.json.helper_worktree, null)
  for (const body of [{}, { why: 'fix' }]) { // Ask Claude, Try again and ⚙ get here without going through Launch
    const s = await hq.api(`previews/${id}/setup`, body); assert.equal(s.status, 200); assert.equal(s.json.helper_state, 'empty')
  }
  assert.equal((await helpers()).length, total, 'no helper started'); assert.equal(running, 0)
  assert.equal((await repoNow()).empty, 1)
  assert.equal((await hq.state()).attention.some((a: any) => a.kind === `repo_launch:${id}` && !a.resolved_at), false) // the old "can't start" is out of date
  assert.deepEqual((await hq.api(`repos/${id}/around`, {})).json.around, { path: fs.realpathSync(outer), name: 'bigclone', repoId: known.id })
  assert.equal((await hq.api(`repos/${known.id}/around`, {})).json.around, null) // not inside anything

  fs.writeFileSync(path.join(dir, 'app.js'), 'y\n'); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'files again')
  const back = await hq.api(`previews/${id}/start`, {}); assert.match(back.json.helper_agent_id, /^launch-/) // files again: Launch works as it did
  await hq.api(`previews/${id}/dismiss`, {})
})

test('Bug 67: the repo around a project needn\'t be one HQ knows yet', async () => {
  const outer = hq.repo('notadded'), made = (await hq.api('repos/new', { name: 'inside', parent: outer, github: false, nested: true })).json
  assert.deepEqual((await hq.api(`repos/${made.id}/around`, {})).json.around, { path: fs.realpathSync(outer), name: 'notadded', repoId: null })
})

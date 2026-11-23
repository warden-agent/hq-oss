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
import { WebSocket } from 'ws'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
const kids: ChildProcess[] = []
before(async () => { hq = await startHq() })
after(async () => { for (const k of kids) { try { process.kill(-k.pid!, 'SIGKILL') } catch { /* gone */ } } await hq?.stop() })

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
})
const preview = async (repoId: string) => (await hq.state()).previews.find((p: any) => p.id === repoId)
/** One app at a time: the earlier tests' apps stop, as the UI's one-app dialog would stop them before this test's Launch. */
const stopOthers = async () => { for (const p of (await hq.state()).previews.filter((x: any) => x.status !== 'stopped')) await hq.api(`previews/${p.id}/stop`, {}) }
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

/** A free port below the OS's own range (HQ leaves those alone: a dev server's workers get them), outside this HQ's preview range. */
async function lowFreePort(): Promise<number> {
  for (let p = 21000 + Math.floor(Math.random() * 8000); ; p++) {
    const free = await new Promise<boolean>((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(p, '127.0.0.1', () => s.close(() => resolve(true))) })
    if (free) return p
  }
}

test('Bug 226: the helper tries the app on ports HQ gives it from its preview range; a test server on another port is stopped and its save refused', async () => {
  const [lo, hi] = hq.env.HQ_PREVIEW_PORTS!.split('-').map(Number) as [number, number]
  const dir = hq.repo('porty'); fs.rmSync(path.join(dir, 'package.json')); sh(dir, 'commit', '-qam', 'nothing to guess from')
  const repo = (await hq.api('repos', { path: dir })).json
  const one = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port: 'auto' }], show: 'app', worktree_files: [], notes: '' }
  const r = (await hq.api(`previews/${repo.id}/start`, {})).json, h = r.helper_agent_id, wt = r.helper_worktree
  const given = r.helper_ports as number[]
  assert.deepEqual(given, [hi - 2, hi - 1, hi]) // from the top of the range: previews take theirs from the bottom
  await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching'))
  const brief = await nextBatch(h)
  assert.ok(brief.includes(`Ports for your test runs: ${given.join(', ')}, free ports in HQ's preview range ${lo}–${hi}. $PORT is ${given[0]} in your shell`), brief)
  assert.doesNotMatch(brief, /3180/)
  const script = fs.readFileSync(path.join(hq.hqHome, 'agents', h, 'launch.sh'), 'utf8')
  assert.match(script, new RegExp(`export PORT='?${given[0]}'?\n`)); assert.match(script, new RegExp(`export HQ_TRY_PORTS='${given.join(' ')}'`))

  // Another project's helper at the same time gets other ports
  const dir2 = hq.repo('porty2'); fs.rmSync(path.join(dir2, 'package.json')); sh(dir2, 'commit', '-qam', 'nothing to guess from')
  const repo2 = (await hq.api('repos', { path: dir2 })).json
  const r2 = (await hq.api(`previews/${repo2.id}/start`, {})).json
  assert.deepEqual(r2.helper_ports, [hi - 5, hi - 4, hi - 3])

  // A test server on a port of its own choosing (as 3180 was): stopped, the save refused and not counted, and said why
  const wrong = await lowFreePort(), stray = holder(wt, wrong)
  await waitFor('the stray test server', async () => (await fetch(`http://127.0.0.1:${wrong}`).catch(() => null))?.ok)
  const refused = await hq.mcp(h, 'save_launch', one); assert.ok(refused.isError)
  assert.match(refused.text, new RegExp(`listened on port ${wrong}, which HQ didn't give you\\.[^]*HQ stopped your test servers\\.[^]*\\$PORT is ${given[0]}[^]*didn't count`))
  await waitFor('the stray to stop', () => !alive(stray.pid!))
  let p = await preview(repo.id); assert.equal(p.helper_saves, 0); assert.equal(p.draft_recipe, null); assert.equal(p.helper_state, 'working')
  const ev = (await hq.api('events?limit=200')).json.find((e: any) => e.kind === 'launch.test_port')
  assert.deepEqual(JSON.parse(ev.payload), { repo: 'porty', ports: [wrong], given }); assert.equal(ev.agent_id, h)

  // What it must not catch: a test server on a given port, or on a port the recipe fixes (the project hard-wires it)
  const ok1 = holder(wt, given[0]!), fixed = await lowFreePort(), ok2 = holder(path.join(wt), fixed)
  await waitFor('the right test servers', async () => (await fetch(`http://127.0.0.1:${given[0]}`).catch(() => null))?.ok && (await fetch(`http://127.0.0.1:${fixed}`).catch(() => null))?.ok)
  const two = { parts: [{ name: 'api', dir: '.', run: 'node api.js', port: fixed }, { name: 'app', dir: '.', run: 'node server.js', port: 'auto' }], show: 'app', worktree_files: [], notes: '' }
  const saved = await hq.mcp(h, 'save_launch', two); assert.equal(saved.isError, false, saved.text)
  assert.ok(alive(ok1.pid!) && alive(ok2.pid!)); p = await preview(repo.id); assert.equal(p.helper_saves, 1); assert.equal(p.helper_state, 'needs_ok')

  // Done: the ports go back
  for (const id of [repo.id, repo2.id]) assert.equal((await hq.api(`previews/${id}/dismiss`, {})).status, 200)
  assert.equal((await preview(repo.id)).helper_ports, null); assert.equal((await preview(repo2.id)).helper_ports, null)
  await waitFor('its test servers to stop', () => !alive(ok1.pid!) && !alive(ok2.pid!))

  // Every port of the range in use: no helper starts on some other port; the pane says why, and the next Launch clears it
  const squat = Array.from({ length: hi - lo + 1 }, (_, i) => holder(hq.root, lo + i)) // one exits at once where the first test's app still runs
  await waitFor('the range to fill', async () => (await Promise.all(squat.map((_, i) => fetch(`http://127.0.0.1:${lo + i}`).then(() => true, () => false)))).every(Boolean))
  const full = await hq.api(`previews/${repo2.id}/start`, {}); assert.equal(full.status, 409)
  assert.match(full.json.error, new RegExp(`Claude needs a free port in HQ's preview ports ${lo}–${hi} to try porty2, and they are all in use`))
  p = await preview(repo2.id); assert.equal(p.helper_agent_id, null); assert.match(p.detail, /they are all in use\. Stop a preview, then Launch again/)
  for (const k of squat) { try { process.kill(-k.pid!, 'SIGKILL') } catch { /* gone */ } }
  await waitFor('the squatters to go', () => squat.every((k) => !alive(k.pid!)))
  const back = (await hq.api(`previews/${repo2.id}/start`, {})).json; assert.ok(back.helper_agent_id); assert.equal(back.detail, null)
  assert.equal((await hq.api(`previews/${repo2.id}/dismiss`, {})).status, 200)
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
  const db = hq.db()
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

test('Bug 156: npm steps that would write a package-lock.json are refused, and OK\'d ones saved before the check are not run', async () => {
  const dir = hq.repo('lockless'); const repo = (await hq.api('repos', { path: dir })).json
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'lockless', private: true, dependencies: { ms: '2.1.3' } })) // packages, no lockfile
  sh(dir, 'commit', '-qam', 'a dependency, no lockfile')
  const steps = (install?: string, when?: string) => ({ parts: [{ name: 'app', dir: '.', ...(install ? { install, install_when: when } : {}), run: 'node server.js', port: 'auto' }],
    show: 'app', worktree_files: [], notes: '' })
  const h = (await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id
  await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching'))
  const bad = await hq.mcp(h, 'save_launch', steps('npm install', 'package-lock.json')); assert.ok(bad.isError)
  assert.match(bad.text, /app: use `npm install --no-package-lock` with install_when `package.json`/)
  assert.equal((await hq.mcp(h, 'save_launch', steps())).isError, false); assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  await waitFor('the app', async () => (await preview(repo.id)).status === 'running', 20_000)
  assert.equal((await hq.mcp(h, 'launch_ok')).isError, false)
  await waitFor('the helper to go', async () => (await preview(repo.id)).helper_agent_id === null)

  // Steps OK'd before the check (or a lockfile removed since): Launch doesn't run them; a helper is briefed to fix them
  const db = hq.db()
  db.prepare('UPDATE previews SET recipe = ? WHERE id = ?').run(JSON.stringify(steps('npm install', 'package-lock.json')), repo.id); db.close()
  const re = await hq.api(`previews/${repo.id}/command`, { command: null }); assert.equal(re.status, 409) // a restart with no helper (as after a merge): the pane says so
  let p = await preview(repo.id); assert.equal(p.status, 'stopped'); assert.match(p.detail, /saved start steps would write a package-lock\.json.*Start it again/)
  assert.equal(p.helper_agent_id, null)
  const r = await hq.api(`previews/${repo.id}/start`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.status, 'stopped'); assert.equal(r.json.helper_state, 'working'); assert.equal(r.json.detail, null)
  assert.match(r.json.helper_note, /didn't run the start steps you OK'd: they would write a package-lock\.json/) // what the pane says while Claude fixes them
  assert.ok(!fs.existsSync(path.join(dir, 'package-lock.json')))
  const errs = (await hq.api('events?limit=100')).json.filter((e: any) => e.kind === 'preview.error').map((e: any) => JSON.parse(e.payload))
  assert.ok(errs.some((e: any) => e.repo === 'lockless' && /saved start steps would write a package-lock\.json/.test(e.error)), JSON.stringify(errs))
  const h2 = r.json.helper_agent_id; assert.ok(h2 && h2 !== h)
  await waitFor('the fixing helper', async () => (await hq.state()).agents.find((a: any) => a.id === h2 && a.status !== 'launching'))
  assert.match(await nextBatch(h2), /HQ won't run its start steps any more: app: use `npm install --no-package-lock`[^]*"install": "npm install"/)
  const fixed = await hq.mcp(h2, 'save_launch', steps('npm install --no-package-lock', 'package.json')); assert.equal(fixed.isError, false, fixed.text)
  p = await preview(repo.id); assert.equal(p.helper_state, 'needs_ok')
  assert.equal((await hq.api(`previews/${repo.id}/dismiss`, {})).status, 200)
})

test('Bugs 238, 239: refused uv steps name uv.lock, and a lockless project\'s installs must not write one', async () => {
  const dir = hq.repo('uvapp'); const repo = (await hq.api('repos', { path: dir })).json
  fs.mkdirSync(path.join(dir, 'server')); fs.mkdirSync(path.join(dir, 'admin'))
  fs.writeFileSync(path.join(dir, 'server', 'pyproject.toml'), '[project]\nname = "api"\nversion = "0.1.0"\n'); fs.writeFileSync(path.join(dir, 'server', 'uv.lock'), 'version = 1\n')
  fs.writeFileSync(path.join(dir, 'admin', 'package.json'), JSON.stringify({ name: 'admin', private: true, dependencies: { ms: '2.1.3' } })) // packages, no lockfile
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'a uv server and a pnpm admin page')
  const steps = (install?: string, when = 'server/uv.lock') => ({ parts: [{ name: 'app', dir: '.', ...(install ? { install, install_when: when } : {}), run: 'node server.js',
    port: 'auto' }], show: 'app', worktree_files: [], notes: '' })
  const h = (await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id
  await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching'))
  const bad = await hq.mcp(h, 'save_launch', steps('cd admin && pnpm install', 'admin/package.json')); assert.ok(bad.isError)
  assert.match(bad.text, /`pnpm install` runs in admin: there is no pnpm-lock.yaml, and `pnpm install` would write one into the user's project: use `pnpm install --no-lockfile`/) // Bug 239
  assert.equal((await hq.mcp(h, 'save_launch', steps())).isError, false); assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  await waitFor('the app', async () => (await preview(repo.id)).status === 'running', 20_000)
  assert.equal((await hq.mcp(h, 'launch_ok')).isError, false)
  await waitFor('the helper to go', async () => (await preview(repo.id)).helper_agent_id === null)

  // the entry's case: OK'd steps `cd server && uv sync` with server/uv.lock, Launch pressed
  const db = hq.db()
  db.prepare('UPDATE previews SET recipe = ? WHERE id = ?').run(JSON.stringify(steps('cd server && uv sync')), repo.id); db.close()
  assert.equal((await hq.api(`previews/${repo.id}/command`, { command: null })).status, 409)
  const p = await preview(repo.id); assert.match(p.detail, /saved start steps would write a uv\.lock into the project, or not follow the one it has\. Start it again/)
  assert.doesNotMatch(p.detail, /package-lock/)
  const r = await hq.api(`previews/${repo.id}/start`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.helper_note, 'HQ didn\'t run the start steps you OK\'d: they would write a uv.lock into the project, or not follow the one it has.')
  const h2 = r.json.helper_agent_id; assert.ok(h2 && h2 !== h)
  await waitFor('the fixing helper', async () => (await hq.state()).agents.find((a: any) => a.id === h2 && a.status !== 'launching'))
  assert.match(await nextBatch(h2), /HQ won't run its start steps any more: app: `uv sync` runs in server: use `uv sync --locked` \(there is a uv.lock\)\./)
  assert.equal((await hq.mcp(h2, 'save_launch', steps('cd server && uv sync --locked'))).isError, false)
  assert.equal((await hq.api(`previews/${repo.id}/dismiss`, {})).status, 200)
  assert.equal(sh(dir, 'status', '--porcelain'), '') // nothing written into the project
})

test('Bugs 303, 316: an install whose output was deleted runs again; an own ⚙ command that would rewrite a lockfile is warned about', async () => {
  const dir = hq.repo('b303x'); const repo = (await hq.api('repos', { path: dir })).json
  fs.mkdirSync(path.join(dir, 'tools')); fs.writeFileSync(path.join(dir, 'yarn.lock'), '__metadata:\n  version: 8\n') // Yarn 2+: Plug'n'Play
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'b303x', private: true, dependencies: { ms: '2.1.3' } }))
  fs.writeFileSync(path.join(dir, 'tools', 'yarn'), '#!/bin/sh\necho "module.exports = 1" > .pnp.cjs\n', { mode: 0o755 }) // stands in for Yarn 4's install
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'an app that needs its install')
  const steps = { parts: [{ name: 'app', dir: '.', install: 'tools/yarn install --immutable', install_when: 'yarn.lock', run: 'node -r ./.pnp.cjs server.js',
    port: 'auto' }], show: 'app', worktree_files: [], notes: '' }
  const installs = async () => (await hq.api('events?limit=400')).json.filter((e: any) => e.kind === 'preview.started')
    .map((e: any) => JSON.parse(e.payload)).filter((e: any) => e.repo === 'b303x').map((e: any) => e.install) // newest first
  const h = (await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id
  await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching'))
  assert.equal((await hq.mcp(h, 'save_launch', steps)).isError, false); assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  await waitFor('the app', async () => (await preview(repo.id)).status === 'running', 20_000)
  assert.equal((await hq.mcp(h, 'launch_ok')).isError, false)
  await waitFor('the helper to go', async () => (await preview(repo.id)).helper_agent_id === null)
  assert.equal((await hq.api(`previews/${repo.id}/stop`, {})).status, 200)

  // Bug 303: .pnp.cjs deleted, yarn.lock unchanged: the next Start installs again (it crashed with "Cannot find module" before)
  fs.rmSync(path.join(dir, '.pnp.cjs')); const before = (await installs()).length
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
  await waitFor('the app again', async () => (await preview(repo.id)).status === 'running', 20_000)
  assert.ok(fs.existsSync(path.join(dir, '.pnp.cjs'))); assert.equal((await installs())[0], 'tools/yarn install --immutable')
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200) // what it must not catch: a restart with everything there
  await waitFor('the restart', async () => (await installs()).length === before + 2); assert.equal((await installs())[0], null)
  await waitFor('the app again', async () => (await preview(repo.id)).status === 'running', 20_000)
  assert.equal((await hq.api(`previews/${repo.id}/stop`, {})).status, 200)

  // Bug 316: the user's own `uv run app.py` with a uv.lock is warned about (Claude's would be refused), and runs as written
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "b303x"\nversion = "0.1.0"\n'); fs.writeFileSync(path.join(dir, 'uv.lock'), 'version = 1\n')
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'a uv project too')
  let r = await hq.api(`previews/${repo.id}/command`, { command: 'uv run app.py' }); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.command_warning, '`uv run app.py` would write a uv.lock into the project, or not follow the one it has: use `uv run --locked` '
    + '(there is a uv.lock, and `uv run app.py` rewrites it when it is out of date). If it then says the uv.lock needs to be updated, run `uv lock` '
    + 'yourself first, where the command runs, and commit the new uv.lock.') // Bug 343: an out-of-date uv.lock stops `uv run --locked`
  assert.equal((await preview(repo.id)).command_warning, r.json.command_warning)
  r = await hq.api(`previews/${repo.id}/command`, { command: 'uv run --locked app.py' }); assert.equal(r.json.command_warning, null)
  r = await hq.api(`previews/${repo.id}/command`, { command: null }); assert.equal(r.json.command_warning, null) // Claude's steps again: refused, not warned
})

test('Bugs 276, 299: a helper stopped from its Agent tab ends as after "Stop Claude": its ports and worktree go, Launch works again, a restart says nothing', async () => {
  const dir = hq.repo('stopped'); fs.rmSync(path.join(dir, 'package.json')); sh(dir, 'commit', '-qam', 'nothing to guess from')
  const repo = (await hq.api('repos', { path: dir })).json
  const one = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port: 'auto' }], show: 'app', worktree_files: [], notes: '' }
  const helperUp = async (h: string) => waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching'))
  const gone = async (h: string) => waitFor('the helper to go', async () => (await hq.state()).agents.find((a: any) => a.id === h)?.status === 'exited')
  const r = (await hq.api(`previews/${repo.id}/start`, {})).json, h = r.helper_agent_id, wt = r.helper_worktree, given = r.helper_ports as number[]
  assert.equal(r.helper_state, 'working'); assert.ok(given.length)
  await helperUp(h)
  const test = holder(wt, given[0]!); await waitFor('its test server', async () => (await fetch(`http://127.0.0.1:${given[0]}`).catch(() => null))?.ok)

  // the Agent tab's Stop: the agent's own stop, not the pane's "Stop Claude"
  assert.equal((await hq.api(`agents/${h}/stop`, {})).status, 200)
  await gone(h)
  let p = await waitFor('the pane to stop waiting on it', async () => { const x = await preview(repo.id); return x.helper_agent_id === null ? x : null })
  // Bug 299: no red "You stopped Claude" (and no second ask under the App tab's): the user stopped it, as with the pane's own "Stop Claude"
  assert.equal(p.helper_state, null); assert.equal(p.helper_note, null); assert.equal(p.helper_ports, null)
  await waitFor('its worktree to go', () => !fs.existsSync(wt))
  await waitFor('its branch to go', () => sh(dir, 'branch', '--list', 'hq-launch/*') === '')
  await waitFor('its test server to stop', () => !alive(test.pid!))
  const done = (await hq.api('events?limit=200')).json.filter((e: any) => e.kind === 'launch.helper_done' && e.agent_id === h).map((e: any) => JSON.parse(e.payload))
  assert.deepEqual(done, [{ repo: 'stopped', state: null, note: null }])

  // a restart finds nothing left to finish and says nothing either
  await hq.restart()
  p = await preview(repo.id); assert.equal(p.helper_state, null); assert.equal(p.helper_note, null)

  // Launch again: a new helper, on ports that are free again
  const again = (await hq.api(`previews/${repo.id}/start`, {})).json, h2 = again.helper_agent_id
  assert.ok(h2 && h2 !== h); assert.equal(again.helper_state, 'working'); assert.deepEqual(again.helper_ports, given)
  await helperUp(h2)

  // steps waiting for the user's OK stay waiting, with no helper on them (as "Not now")
  assert.equal((await hq.mcp(h2, 'save_launch', one)).isError, false)
  assert.equal((await hq.api(`agents/${h2}/stop`, {})).status, 200); await gone(h2)
  p = await waitFor('the pane to keep the steps', async () => { const x = await preview(repo.id); return x.helper_agent_id === null ? x : null })
  assert.equal(p.helper_state, 'needs_ok'); assert.equal(p.helper_note, null); assert.equal(p.draft_recipe.parts[0].run, 'node server.js')
  await waitFor('its worktree to go', () => !fs.existsSync(again.helper_worktree))

  // stopped while HQ runs its OK'd steps: the run's outcome doesn't make it "working" again
  const h3 = (await hq.api(`previews/${repo.id}/setup`, { why: 'fix' })).json.helper_agent_id; await helperUp(h3)
  const slow = { ...one, parts: [{ ...one.parts[0], run: 'sleep 2 && node server.js' }] }
  assert.equal((await hq.mcp(h3, 'save_launch', slow)).isError, false)
  assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200); assert.equal((await preview(repo.id)).helper_state, 'trying')
  assert.equal((await hq.api(`agents/${h3}/stop`, {})).status, 200); await gone(h3)
  await waitFor('the app', async () => (await preview(repo.id)).status === 'running', 20_000)
  // A check that nothing happens: HQ's run looks at the app once a second and would tell the helper (and say "working") right after
  await new Promise((res) => setTimeout(res, 2500)) // limit: that look comes once a second; two go by
  // Bug 299: nothing red over the app that runs
  p = await preview(repo.id); assert.equal(p.helper_state, null); assert.equal(p.helper_note, null); assert.equal(p.helper_agent_id, null); assert.equal(sentTo(h3), 0)
  await hq.api(`previews/${repo.id}/stop`, {})

  // what the rule must not catch: a helper that ends by itself (no Stop from the user) still says so
  const h4 = (await hq.api(`previews/${repo.id}/setup`, { why: 'fix' })).json.helper_agent_id; await helperUp(h4)
  await hq.hook(h4, { hook_event_name: 'SessionEnd', reason: 'other' })
  p = await waitFor('the pane to stop waiting on it', async () => { const x = await preview(repo.id); return x.helper_agent_id === null ? x : null })
  assert.equal(p.helper_state, 'failed'); assert.equal(p.helper_note, 'Claude stopped before it finished.')

})
/** How many messages HQ sent an agent. */
function sentTo(agentId: string): number {
  const db = hq.db()
  try { return (db.prepare("SELECT count(*) AS n FROM messages WHERE to_id = ? AND from_id = 'hq'").get(agentId) as { n: number }).n } finally { db.close() }
}

test('Bug 302: an app that ends at once keeps its output: the helper gets its last lines, and the Server tab shows them', async () => {
  const dir = hq.repo('b302x'); fs.rmSync(path.join(dir, 'package.json'))
  fs.writeFileSync(path.join(dir, 'quick.js'), "for (let i = 1; i <= 8; i++) console.log('B302 line ' + i)\nconsole.error('B302 error: no such table')\nprocess.exit(3)\n")
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'an app that ends at once')
  const repo = (await hq.api('repos', { path: dir })).json
  const h = (await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id
  await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching'))
  await nextBatch(h) // its brief
  const quick = { parts: [{ name: 'app', dir: '.', run: 'node quick.js', port: 'auto' }], show: 'app', worktree_files: [], notes: '' }
  assert.equal((await hq.mcp(h, 'save_launch', quick)).isError, false)
  assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  await waitFor('the app to crash', async () => (await preview(repo.id)).status === 'crashed', 20_000)

  // the helper's "Last output": the app's lines, then tmux's own, with no screenful of blank lines between (was 40 blank lines and "Pane is dead")
  const told = await nextBatch(h)
  assert.match(told, /it stopped with code 3\. Last output:\n[^]*\nB302 line 1\n(B302 line \d\n){7}B302 error: no such table\nstopped \(3\)\nPane is dead \(status 3\b[^\n]*\n\nFix the steps/, told)

  // the Server tab, opened after the crash in a terminal smaller than the pane (attaching shrank the pane, and the output went out of sight)
  const w = new WebSocket(`ws://127.0.0.1:${hq.ports.ui}/ws`, { headers: { authorization: `Bearer ${fs.readFileSync(path.join(hq.hqHome, 'ui-token'), 'utf8').trim()}` } })
  try {
    const seen: any[] = []; w.on('message', (raw) => seen.push(JSON.parse(String(raw))))
    await new Promise<void>((ok, no) => { w.once('open', () => ok()); w.once('error', no) })
    w.send(JSON.stringify({ type: 'term.open', agentId: `preview:${repo.id}`, cols: 100, rows: 20 }))
    const drawn = () => seen.filter((m) => m.type === 'term' && m.agentId === `preview:${repo.id}`).map((m) => m.data).join('').replace(/\x1b\[[0-9;:]*m/g, '')
    await waitFor('the Server tab to show the output', () => drawn().includes('Pane is dead') || null)
    assert.match(drawn(), /HQ preview: node quick\.js[^]*\r\nB302 line 1\r\n(B302 line \d\r\n){7}B302 error: no such table\r\nstopped \(3\)\r\nPane is dead \(status 3[^\r]*\r\n$/,
      JSON.stringify(drawn()))
    assert.equal(seen.some((m) => m.type === 'term.exit'), false)
  } finally { w.close() }

  // "Ask Claude to fix it": the next helper's brief has the output too, without the blank lines
  assert.equal((await hq.mcp(h, 'report_cant_start', { reason: 'b302 stand-in' })).isError, false)
  await waitFor('the helper to go', async () => (await hq.state()).agents.find((a: any) => a.id === h)?.status === 'exited')
  const h2 = (await hq.api(`previews/${repo.id}/setup`, { why: 'fix' })).json.helper_agent_id; assert.ok(h2 && h2 !== h)
  await waitFor('the fix helper', async () => (await hq.state()).agents.find((a: any) => a.id === h2 && a.status !== 'launching'))
  assert.match(await nextBatch(h2), /The app's last output:\n[^]*\nB302 line 1\n(B302 line \d\n){7}B302 error: no such table\nstopped \(3\)\nPane is dead \(status 3[^\n]*\n\nFind out why/)
  assert.equal((await hq.api(`agents/${h2}/stop`, {})).status, 200)
})

test('Bugs 262, 263: a `uv run` must follow uv.lock, and what a Yarn 2+ install leaves never shows in git status', async () => {
  const dir = hq.repo('yarnapp'); const repo = (await hq.api('repos', { path: dir })).json
  fs.mkdirSync(path.join(dir, 'server')); fs.mkdirSync(path.join(dir, 'tools'))
  fs.writeFileSync(path.join(dir, 'server', 'pyproject.toml'), '[project]\nname = "api"\nversion = "0.1.0"\n'); fs.writeFileSync(path.join(dir, 'server', 'uv.lock'), 'version = 1\n')
  fs.writeFileSync(path.join(dir, 'yarn.lock'), '__metadata:\n  version: 8\n')
  // stands in for Yarn 4: what `yarn install --immutable` leaves (checked on 4.5.3), not covered by this project's .gitignore
  fs.writeFileSync(path.join(dir, 'tools', 'yarn'), '#!/bin/sh\nmkdir -p .yarn/unplugged/x node_modules/ms && echo pnp > .pnp.cjs && echo s > .yarn/install-state.gz'
    + ' && echo u > .yarn/unplugged/x/i.js && echo m > node_modules/ms/index.js\n', { mode: 0o755 })
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'a uv server and Yarn')
  const steps = (install: string, when: string, run: string) => ({ parts: [{ name: 'app', dir: '.', install, install_when: when, run, port: 'auto' }],
    show: 'app', worktree_files: [], notes: '' })
  const h = (await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id
  await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching'))
  const bad = await hq.mcp(h, 'save_launch', steps('cd server && uv sync --locked', 'server/uv.lock', 'cd server && uv run app.py')); assert.ok(bad.isError) // Bug 262
  assert.match(bad.text, /`uv run app.py` runs in server: use `uv run --locked` \(there is a uv.lock, and `uv run app.py` rewrites it when it is out of date\)/)
  const ok = await hq.mcp(h, 'save_launch', steps('tools/yarn install --immutable', 'yarn.lock', 'node server.js')); assert.equal(ok.isError, false, ok.text)
  assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  await waitFor('the app', async () => (await preview(repo.id)).status === 'running', 20_000)
  assert.ok(fs.existsSync(path.join(dir, '.pnp.cjs')) && fs.existsSync(path.join(dir, '.yarn', 'install-state.gz')), 'the install ran')
  assert.equal(sh(dir, 'status', '--porcelain', '--untracked-files=all'), '') // Bug 263: nothing new in the project
  const excl = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')
  assert.match(excl, /^\/\.pnp\.cjs$/m); assert.match(excl, /^\/\.yarn\/install-state\.gz$/m); assert.doesNotMatch(excl, /node_modules/) // .gitignore has it
  const ev = (await hq.api('events?limit=100')).json.find((e: any) => e.kind === 'preview.started' && JSON.parse(e.payload).repo === 'yarnapp')
  assert.ok(JSON.parse(ev.payload).hidden.includes('/.pnp.cjs'), ev.payload)
  assert.equal((await hq.mcp(h, 'launch_ok')).isError, false)
  await hq.api(`previews/${repo.id}/stop`, {})
})

test('Bugs 300, 329: steps a helper saves again unchanged start the app only while it is on or crashed and no other app is; else they wait for the OK', async () => {
  await stopOthers()
  const dir = hq.repo('b329x'); fs.rmSync(path.join(dir, 'package.json'))
  fs.writeFileSync(path.join(dir, 'crash.js'),
    "require('http').createServer((q, s) => { s.end('up'); if (q.url === '/crash') setTimeout(() => process.exit(3), 50) }).listen(process.env.PORT)\n")
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'an app that can crash')
  const repo = (await hq.api('repos', { path: dir })).json
  const one = { parts: [{ name: 'app', dir: '.', run: 'node crash.js', port: 'auto' }], show: 'app', worktree_files: [], notes: '' }
  const started = async () => (await hq.api('events?limit=400')).json.filter((e: any) => e.kind === 'preview.started' && JSON.parse(e.payload).repo === 'b329x').length
  const status = (s: string) => waitFor(`the app ${s}`, async () => { const x = await preview(repo.id); return x.status === s ? x : null }, 20_000)
  const notice = async () => (await hq.state()).attention.find((a: any) => a.kind === `repo_launch:${repo.id}`)?.detail ?? null
  const h = (await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id
  await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching'))
  assert.match(await nextBatch(h), /Project: b329x/)
  const again = (n: number) => hq.mcp(h, 'save_launch', { ...one, notes: `the same steps, save ${n}` })
  assert.equal((await hq.mcp(h, 'save_launch', one)).isError, false)
  assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  await status('running'); assert.match(await nextBatch(h), /the page answered/)

  // Bug 329: the user stops the app between the OK and the helper's next save; that save doesn't start it again
  assert.equal((await hq.api(`previews/${repo.id}/stop`, {})).status, 200)
  const n = await started()
  const held = await again(2); assert.equal(held.isError, false); assert.match(held.text, /doesn't run them by itself now: it is stopped\. HQ asks the user/)
  let p = await preview(repo.id) // the old code had already marked it 'trying' and was starting it
  assert.equal(p.status, 'stopped'); assert.equal(p.helper_state, 'needs_ok'); assert.equal(p.draft_recipe.notes, 'the same steps, save 2')
  assert.equal(p.helper_note, 'Claude saved the steps you OK\'d again, unchanged. HQ didn\'t start the app by itself: it is stopped.')
  assert.match(await notice(), /^b329x: Claude saved the steps you OK'd again, unchanged\. .*: it is stopped\. OK them in the preview to run them\.$/)
  // the user's OK runs them (the UI asks the one-app question first), and the helper hears how it went
  assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  p = await status('running'); assert.equal(p.helper_note, null); assert.equal(await started(), n + 1); assert.equal(await notice(), null)
  assert.match(await nextBatch(h), /the page answered/)

  // What it must not hold: the app crashed ("Ask Claude to fix it") and no other app is on, so the same steps run at once, as before
  await fetch(`${p.url}crash`).catch(() => null); await status('crashed')
  assert.match((await again(3)).text, /so HQ runs them now/); assert.equal((await preview(repo.id)).helper_state, 'trying')
  p = await status('running'); assert.match(await nextBatch(h), /the page answered/)

  // Bug 300: it crashed again, and meanwhile the user started another project's app (the one-app dialog stops only apps that are on)
  await fetch(`${p.url}crash`).catch(() => null); await status('crashed')
  const other = (await hq.api('repos', { path: hq.repo('b300x') })).json
  assert.equal((await hq.api(`previews/${other.id}/command`, { command: 'node server.js' })).status, 200)
  assert.equal((await hq.api(`previews/${other.id}/start`, {})).status, 200)
  await waitFor('the other app', async () => (await preview(other.id)).status === 'running', 20_000)
  const n2 = await started()
  const beside = await again(4); assert.equal(beside.isError, false); assert.match(beside.text, /b300x's app is running, and only one app runs at a time/)
  p = await preview(repo.id); assert.equal(p.status, 'crashed'); assert.equal(p.helper_state, 'needs_ok'); assert.match(p.helper_note, /b300x's app is running/)

  // Not now: Claude goes, and steps that only repeat the OK'd ones don't stay waiting for an OK
  assert.equal((await hq.api(`previews/${repo.id}/dismiss`, {})).status, 200)
  await waitFor('the helper to go', async () => (await hq.state()).agents.find((a: any) => a.id === h)?.status === 'exited')
  p = await preview(repo.id); assert.equal(p.draft_recipe, null); assert.equal(p.helper_state, null); assert.equal(p.recipe.parts[0].run, 'node crash.js')
  assert.equal(await started(), n2); assert.equal(await notice(), null)
  await hq.api(`previews/${other.id}/stop`, {}); await hq.api(`previews/${repo.id}/stop`, {})
})

test('Bug 314: a Clear stops the app and leaves the Launch helper working, as its dialog says, and the helper\'s next save doesn\'t start the app again', async () => {
  await stopOthers()
  const dir = hq.repo('b314x'); fs.rmSync(path.join(dir, 'package.json')); sh(dir, 'commit', '-qam', 'nothing to guess from')
  const repo = (await hq.api('repos', { path: dir })).json
  const one = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port: 'auto' }], show: 'app', worktree_files: [], notes: '' }
  const h = (await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id
  await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching')); await nextBatch(h)
  assert.equal((await hq.mcp(h, 'save_launch', one)).isError, false); assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  await waitFor('the app', async () => (await preview(repo.id)).status === 'running', 20_000); assert.match(await nextBatch(h), /the page answered/)

  const r = await hq.api(`repos/${repo.id}/clear`, {}); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.done, true)
  let p = await waitFor('the clear', async () => { const x = await preview(repo.id); return !(await hq.state()).repos.find((y: any) => y.id === repo.id).clearing_at ? x : null })
  assert.equal(p.status, 'stopped'); assert.equal(p.helper_agent_id, h); assert.equal(p.helper_state, 'working') // the helper goes on: start steps aren't the board
  assert.match((await hq.mcp(h, 'save_launch', { ...one, notes: 'after the clear' })).text, /it is stopped/)
  p = await preview(repo.id); assert.equal(p.status, 'stopped'); assert.equal(p.helper_state, 'needs_ok')
  assert.equal((await hq.api(`previews/${repo.id}/dismiss`, {})).status, 200)
  await waitFor('the helper to go', async () => (await hq.state()).agents.find((a: any) => a.id === h)?.status === 'exited')
})

test('Bug 332: a Stop during HQ\'s first run of the OK\'d steps doesn\'t send the helper back to save them again; the steps stay', async () => {
  await stopOthers()
  const dir = hq.repo('b332x'); fs.rmSync(path.join(dir, 'package.json'))
  fs.writeFileSync(path.join(dir, 'crash.js'),
    "require('http').createServer((q, s) => { s.end('b332 up'); if (q.url === '/crash') setTimeout(() => process.exit(3), 50) }).listen(process.env.PORT)\n")
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'an app that can crash')
  const repo = (await hq.api('repos', { path: dir })).json
  const steps = (run: string) => ({ parts: [{ name: 'app', dir: '.', run, port: 'auto' }], show: 'app', worktree_files: [], notes: '' })
  const status = (s: string) => waitFor(`the app ${s}`, async () => { const x = await preview(repo.id); return x.status === s ? x : null }, 20_000)
  const gone = (h: string) => waitFor('the helper to go', async () => (await hq.state()).agents.find((a: any) => a.id === h)?.status === 'exited')
  const helper = async (why?: 'fix') => {
    const h = (await hq.api(`previews/${repo.id}/${why ? 'setup' : 'start'}`, why ? { why } : {})).json.helper_agent_id
    await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching')); await nextBatch(h)
    return h as string
  }
  const done = async (h: string) => (await hq.api('events?limit=400')).json.filter((e: any) => e.kind === 'launch.helper_done' && e.agent_id === h)
    .map((e: any) => JSON.parse(e.payload))

  // Stopped while it starts: the helper isn't told "it stopped… fix the steps" (it saved the same ones again, and the OK card came back); it goes
  const h1 = await helper(), slow = steps('sleep 3 && node crash.js')
  assert.equal((await hq.mcp(h1, 'save_launch', slow)).isError, false)
  assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  let p = await status('starting'); assert.equal(p.helper_state, 'trying')
  const told = sentTo(h1)
  assert.equal((await hq.api(`previews/${repo.id}/stop`, {})).status, 200)
  await gone(h1)
  p = await waitFor('the pane to let it go', async () => { const x = await preview(repo.id); return x.helper_agent_id === null ? x : null })
  assert.equal(p.status, 'stopped'); assert.equal(p.helper_state, null); assert.equal(p.helper_note, null); assert.equal(p.draft_recipe, null) // no OK card
  assert.equal(p.recipe.parts[0].run, 'sleep 3 && node crash.js') // the steps the user OK'd stay
  assert.equal(sentTo(h1), told) // nothing more for the helper to do (was "Real run …: it stopped. … Fix the steps and call save_launch again.")
  assert.deepEqual(await waitFor('its end on record', async () => { const d = await done(h1); return d.length ? d : null }),
    [{ repo: 'b332x', state: null, note: null, why: 'app_stopped' }])
  assert.ok(!(await hq.state()).attention.some((a: any) => a.kind === `repo_launch:${repo.id}`))
  const lines = (await hq.api(`agents/${h1}/events`)).json.events.map((e: any) => e.text) // its Events tab says why it went
  assert.ok(lines.includes('Done with the launch steps: the app was stopped before it answered; the steps you OK\'d stay'), JSON.stringify(lines))
  // the next Launch runs them, with no helper
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).json.helper_agent_id, null)
  p = await status('running'); assert.equal(await page(p.url), 'b332 up')
  await hq.api(`previews/${repo.id}/stop`, {})

  // Stopped after the page answered: launch_ok is taken (it was refused: "Save them with save_launch")
  const h2 = await helper('fix')
  assert.equal((await hq.mcp(h2, 'save_launch', steps('node crash.js'))).isError, false)
  assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  await status('running'); assert.match(await nextBatch(h2), /the page answered/)
  assert.equal((await hq.api(`previews/${repo.id}/stop`, {})).status, 200)
  const ok = await hq.mcp(h2, 'launch_ok'); assert.equal(ok.isError, false, ok.text); assert.match(ok.text, /^Done\. The user stopped the app after it answered/)
  await gone(h2)
  p = await preview(repo.id); assert.equal(p.status, 'stopped'); assert.equal(p.helper_state, null); assert.equal(p.draft_recipe, null)
  assert.equal(p.recipe.parts[0].run, 'node crash.js')
  assert.deepEqual(await waitFor('its end on record', async () => { const d = await done(h2); return d.length ? d : null }), [{ repo: 'b332x', state: null, note: null }])

  // What it must not take: the app crashed by itself after it answered; a Stop on the crashed app doesn't make that a working run
  const h3 = await helper('fix')
  assert.equal((await hq.mcp(h3, 'save_launch', steps('node crash.js --b332'))).isError, false)
  assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  p = await status('running'); assert.match(await nextBatch(h3), /the page answered/)
  await fetch(`${p.url}crash`).catch(() => null); await status('crashed')
  assert.match((await hq.mcp(h3, 'launch_ok')).text, /no working run of your steps yet/)
  assert.equal((await hq.api(`previews/${repo.id}/stop`, {})).status, 200)
  assert.match((await hq.mcp(h3, 'launch_ok')).text, /no working run of your steps yet/)
  assert.equal((await preview(repo.id)).helper_agent_id, h3)
  assert.equal((await hq.api(`previews/${repo.id}/dismiss`, {})).status, 200); await gone(h3)
})

test('Bug 351: a restart during HQ\'s first run of the OK\'d steps; the helper still hears how it went (or goes, after a Stop)', async () => {
  await stopOthers()
  const dir = hq.repo('b351x'); fs.rmSync(path.join(dir, 'package.json'))
  fs.writeFileSync(path.join(dir, 'crash.js'), "console.log('B351 boom: no such table'); process.exit(3)\n")
  fs.writeFileSync(path.join(dir, 'up.js'), "require('http').createServer((q, s) => s.end('b351 up')).listen(process.env.PORT)\n")
  fs.writeFileSync(path.join(dir, 'slow.js'), "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1500)); setInterval(() => {}, 1000)\n") // never answers
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'apps that crash, answer, or stop slowly')
  const repo = (await hq.api('repos', { path: dir })).json
  const steps = (run: string) => ({ parts: [{ name: 'app', dir: '.', run, port: 'auto' }], show: 'app', worktree_files: [], notes: '' })
  const status = (s: string) => waitFor(`the app ${s}`, async () => { const x = await preview(repo.id); return x.status === s ? x : null }, 20_000)
  const gone = (h: string) => waitFor('the helper to go', async () => (await hq.state()).agents.find((a: any) => a.id === h)?.status === 'exited')
  const helper = async (why?: 'fix') => {
    const h = (await hq.api(`previews/${repo.id}/${why ? 'setup' : 'start'}`, why ? { why } : {})).json.helper_agent_id
    await waitFor('the helper', async () => (await hq.state()).agents.find((a: any) => a.id === h && a.status !== 'launching')); await nextBatch(h)
    return h as string
  }
  /** Saves the steps, OKs them, and waits for HQ's run to be under way: the pane says "Running Claude's steps…". */
  const okd = async (h: string, run: string) => {
    assert.equal((await hq.mcp(h, 'save_launch', steps(run))).isError, false)
    assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
    const p = await status('starting'); assert.equal(p.helper_state, 'trying'); return p
  }
  const starts = async () => (await hq.api('events?limit=400')).json.filter((e: any) => e.kind === 'preview.started' && JSON.parse(e.payload).repo === 'b351x').length

  // The app crashes after the restart: the helper gets the crash and its output (it was never told, and the pane said "Running Claude's steps…")
  const h1 = await helper()
  const run1 = await okd(h1, 'sleep 4 && node crash.js')
  await hq.restart()
  assert.equal((await preview(repo.id)).started_at, run1.started_at) // the same run, still starting
  const told = await nextBatch(h1)
  assert.match(told, /Real run on the user's checkout: it stopped with code 3\. Last output:\n[^]*B351 boom: no such table[^]*\n\nFix the steps and call save_launch again\.$/, told)
  let p = await preview(repo.id); assert.equal(p.helper_state, 'working'); assert.equal(p.status, 'crashed')
  const lines = (await hq.api(`agents/${h1}/events`)).json.events.map((e: any) => e.text) // its Events tab says what HQ did
  assert.ok(lines.includes('HQ restarted during the first run of the steps you OK\'d: it picks that run up again'), JSON.stringify(lines))

  // The page answers after the restart: the helper is told so, and launch_ok is taken
  const run2 = await okd(h1, 'sleep 4 && node up.js')
  await hq.restart()
  assert.match(await nextBatch(h1), /Real run on the user's checkout: the page answered at http:\/\/localhost:\d+\/\. Last output:[^]*call launch_ok/)
  p = await preview(repo.id); assert.equal(p.started_at, run2.started_at); assert.equal(p.status, 'running'); assert.equal(await page(p.url), 'b351 up')
  assert.equal((await hq.mcp(h1, 'launch_ok')).isError, false); await gone(h1)
  p = await preview(repo.id); assert.equal(p.helper_state, null); assert.equal(p.recipe.parts[0].run, 'sleep 4 && node up.js')

  // A Stop the restart cut short: once HQ finishes it, the helper goes as after a Stop with no restart (Bug 332), and the steps stay
  const h2 = await helper('fix'); await okd(h2, 'node slow.js')
  const before = sentTo(h2), call = hq.api(`previews/${repo.id}/stop`, {}).catch(() => null)
  await waitFor('HQ to begin stopping it', async () => (await preview(repo.id)).stopping === 'stop')
  await hq.down(); await call; await hq.up()
  await gone(h2)
  p = await preview(repo.id); assert.equal(p.status, 'stopped'); assert.equal(p.helper_state, null); assert.equal(p.helper_note, null); assert.equal(p.draft_recipe, null)
  assert.equal(p.recipe.parts[0].run, 'node slow.js'); assert.equal(sentTo(h2), before) // not sent back to save the same steps
  const done = async () => (await hq.api('events?limit=400')).json.filter((e: any) => e.kind === 'launch.helper_done' && e.agent_id === h2).map((e: any) => JSON.parse(e.payload))
  assert.deepEqual(await waitFor('its end on record', async () => { const d = await done(); return d.length ? d : null }),
    [{ repo: 'b351x', state: null, note: null, why: 'app_stopped' }])

  // The backend went while it was starting the run (the old app ended, the new one's start not saved): the run starts once, as the try's, and is told
  const h3 = await helper('fix'); await okd(h3, 'sleep 2 && node up.js')
  const was = await starts()
  await hq.down()
  const db = hq.db(); try { db.prepare("UPDATE previews SET stopping = 'restart', helper_run = NULL WHERE id = ?").run(repo.id) } finally { db.close() }
  await hq.up()
  assert.match(await nextBatch(h3), /the page answered at http:\/\/localhost:\d+\//)
  assert.equal(await starts(), was + 1) // the try's own start, and no second one from the restart list (which would leave the helper waiting again)
  p = await preview(repo.id); assert.equal(p.status, 'running'); assert.equal(p.helper_run, p.started_at)
  assert.equal((await hq.mcp(h3, 'launch_ok')).isError, false); await gone(h3)
  await hq.api(`previews/${repo.id}/stop`, {})
})

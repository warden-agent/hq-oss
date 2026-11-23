// Bug 293: the backend can restart in the middle of anything (hq/CLAUDE.md, "Waiting"), and restart bugs kept turning up one action at a time (Bugs 51,
// 78, 85, 145, 186, 203, 215, 219, 232), each with a test of its own case. Here every long action HQ runs is cut by a restart in one place: a Clear, a Stop,
// a Launch, HQ's own test run, a merge, an agent's background run and helper, a plan check. Each test checks two things. The board: what the page shows for
// the project just before the restart is what it shows after it (the action is still under way, or under way again), or, for an action the restart cuts
// short and HQ finishes at start-up, what the same action shows when no restart cuts it (a twin project). And the action: it finishes, or picks up again.
// "The board" is the page's own reading of HQ's state (frontend board.ts buildBoard, as App.tsx calls it): each box's lines and buttons, Your turn, HQ's
// test runs and a Clear as the top bar says them, auto mode, the app pane's state and the ⚠ items. One test HQ for the file; each test has projects of its own.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
// `git` here is a stand-in that runs the real one and then, for `git merge --ff-only` while the flag file is there, holds its answer: HQ has moved main but
// not yet heard so, which is where a restart cuts a merge. It writes `held` once it holds one.
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-b293-git-')), flag = path.join(bin, 'hold-merge'), held = path.join(bin, 'held')
before(async () => {
  const real = process.env.PATH!.split(':').map((d) => path.join(d, 'git')).find((p) => fs.existsSync(p)); assert.ok(real, 'git is installed')
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
'${real}' "$@"; code=$?
case " $* " in *" merge --ff-only "*) if [ -e '${flag}' ]; then : > '${held}'; while [ -e '${flag}' ]; do sleep 0.05; done; fi;; esac
exit $code
`, { mode: 0o755 })
  // HQ_LOOK_RUNNER: no browser here (auto.test.ts says more). A fast auto mode: its look is what picks a test run or a plan check up again after a restart
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}`, HQ_AUTO_SOON_MS: '100', HQ_AUTO_TICK_MS: '500', HQ_FRESH_START_TIMEOUT_S: '60',
    HQ_LOOK_RUNNER: path.join(import.meta.dirname, 'fake-look.mjs'), HQ_UITEST_BROWSER_EXE: '/usr/bin/false',
    HQ_SCENARIO_RUNNER: path.join(import.meta.dirname, 'fake-scenario.mjs') } })
  await hq.api('settings', { key: 'concurrency_cap', value: 20 })
})
after(async () => { fs.rmSync(flag, { force: true }); await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })

// The page's own code. Plain strings: the backend's typecheck stays out of the frontend's files (as auto-github.test.ts).
const FRONT: string = '../../frontend/src/'
type PageCode = { forRepo: (s: any, id: string) => any; buildBoard: (s: any, now: number, repo: any, opened: Set<string>) => { nodes: any[] }; actLabel: (a: any) => string
  ticketLabel: (t: any, hqPlan: boolean, clearing: boolean) => string; runWords: (r: any, key: string | null, base: string) => { box: string; bar: string }
  mergeTestOf: (t: any) => unknown; mergeTestWords: (m: unknown) => { long: string } | null }
let code: Promise<PageCode> | null = null
const pageCode = (): Promise<PageCode> => code ??= (async () => {
  const { register } = await import('node:module') // the frontend imports its own files without an extension (Vite finds them)
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
    if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
    return next(s, c) }`)}`)
  ;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) } // no canvas: text is measured by its length
  const [b, r] = await Promise.all([import(`${FRONT}board.ts`), import(`${FRONT}testruns.ts`)])
  return { forRepo: b.forRepo, buildBoard: b.buildBoard, actLabel: b.actLabel, ticketLabel: b.ticketLabel, runWords: r.runWords, mergeTestOf: r.mergeTestOf, mergeTestWords: r.mergeTestWords }
})()

/** What the page shows for project `repoId`, one line per thing, as of `at` (a fixed time, so two readings differ only in what HQ says). The names of
 *  `rename` are put in for its twin's when two projects are compared. */
async function board(repoId: string, at: number, rename: Record<string, string> = {}): Promise<string[]> {
  const p = await pageCode(), all = await hq.state(), s = p.forRepo(all, repoId), repo = s.repos.find((r: any) => r.id === repoId), out: string[] = []
  const opened = new Set<string>(s.features.map((f: any) => f.id)) // a done feature's tickets as if the user opened it: what HQ ran on each (Bug 126)
  for (const n of p.buildBoard(s, at, repo, opened).nodes) {
    const v = n.data.view, acts: string[] = (v.acts ?? []).map(p.actLabel)
    const name = n.type === 'tpm' ? 'TPM' : n.type === 'feature' ? 'feature' : `${v.t.key} (${p.ticketLabel(v.t, v.hqPlan, v.clearing)})`
    const merged = v.compact ? ` · ${p.mergeTestWords(p.mergeTestOf(v.t))?.long ?? 'nothing said about its tests'}` : '' // a merged ticket's one row
    out.push(`${name}${merged}: ${v.lines.map((l: any) => l.text).join(' | ')}${acts.length ? ` [${acts.join(', ')}]` : ''}`)
    const turn = n.type === 'tpm' ? v.turn : null
    if (turn?.start.length || turn?.asks.length || turn?.questions?.length) out.push(`Your turn: ${JSON.stringify({ start: turn.start, asks: turn.asks.map((a: any) => a.question) })}`)
  }
  if (repo?.clearing_at) out.push(`top bar: Clearing… ${s.agents.filter((a: any) => a.status !== 'exited' && a.fresh_start_at).length} notes to go`) // App.tsx RepoBar
  if (repo?.auto_mode) out.push(`auto mode: ${repo.auto_stopped_why ? `stopped: ${repo.auto_stopped_why}` : 'on'}`)
  for (const r of s.testRuns ?? []) out.push(`top bar: ${p.runWords(r, s.tickets.find((t: any) => t.id === r.ticket_id)?.key ?? null, repo?.default_branch ?? 'main').bar}`)
  const pv = all.previews.find((x: any) => x.id === repoId)
  if (pv) out.push(`app pane: ${pv.status}${pv.stopping ? ` (${pv.stopping})` : ''} · helper ${pv.helper_state ?? 'none'}${pv.helper_note ? `: ${pv.helper_note}` : ''}`)
  for (const a of s.attention) out.push(`⚠ ${a.kind.replace(/:.*/, '')}: ${a.detail}`)
  return out.map((l) => Object.entries(rename).reduce((x, [from, to]) => x.split(from).join(to), l))
}
/** Restarts the backend in the middle of an action on `repoId` and waits until the board says again what it said just before (HQ may take a moment to pick
 *  the action up again: its own test run starts again at auto mode's next look). What it said before, for the test to check it showed the action. */
async function restartMidway(repoId: string): Promise<string[]> {
  const at = Date.now(), was = await board(repoId, at)
  await hq.restart()
  let now: string[] = []
  try { await waitFor('the board to say again what it said before the restart', async () => { now = await board(repoId, at); return JSON.stringify(now) === JSON.stringify(was) }, 20_000) }
  catch { assert.deepEqual(now, was, 'the board after the restart, against the board before it') }
  return was
}
/** Waits until project `a`'s board says what its twin `b`'s says: the action cut short by a restart ended as one with none. */
async function sameAsTwin(a: { repo: any; name: string }, b: { repo: any; name: string }): Promise<void> {
  const at = Date.now(); let got: string[] = [], want: string[] = []
  try {
    await waitFor(`${a.name} to end as ${b.name} did`, async () => {
      got = await board(a.repo.id, at); want = await board(b.repo.id, at, { [b.name]: a.name }); return JSON.stringify(got) === JSON.stringify(want)
    }, 20_000)
  } catch { assert.deepEqual(got, want, `${a.name}, cut by a restart, against ${b.name}, with none`) }
}

const agentOf = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
const PASS = "require('node:test').test('ok',()=>{})\n"
/** A project with `npm test` and one passing test, and its TPM at work on a first request. */
async function project(name: string, o: { auto?: boolean; testCmd?: string } = {}) {
  const dir = hq.repo(name)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true, scripts: { start: 'node server.js', test: 'node --test' } }))
  fs.mkdirSync(path.join(dir, 'test')); fs.writeFileSync(path.join(dir, 'test', 'ok.test.js'), PASS); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => { const a = await agentOf(f.tpm_agent_id); return a?.status === 'working' ? a : null })
  if (o.testCmd) assert.equal((await hq.api(`repos/${repo.id}/test-cmd`, { cmd: o.testCmd })).status, 200)
  if (o.auto) assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  return { name, dir, repo, f, tpm }
}
type P = Awaited<ReturnType<typeof project>>
const ticket = async (p: P, title: string, more: Record<string, unknown> = {}) =>
  (await hq.api('tickets', { featureId: p.f.id, title, size: 'S', spec: `${title}.`, ...more })).json
const turnEnds = (p: P) => hq.hook(p.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Split done.' })
const engineerOn = (t: any) => waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
/** Launch engineer on `t` (manual), the engineer reading its brief. */
async function launched(t: any): Promise<any> {
  const e = (await hq.api(`tickets/${t.id}/launch`, {})).json; await engineerOn(t)
  const b = await waitFor('its brief', async () => (await hq.modNext(e.id)).batch); await hq.modEvent(e.id, { kind: 'batch_received', id: b.id })
  await hq.hook(e.id, { hook_event_name: 'UserPromptSubmit', prompt: b.text }); return e
}
const wt = (p: P, t: any) => path.join(p.dir, '.claude', 'worktrees', t.key)
/** An engineer's work after its plan: a file, a commit, the project's tests run and open_pr. */
async function finish(p: P, t: any, e: any): Promise<void> {
  fs.writeFileSync(path.join(wt(p, t), 'thing.txt'), `${t.title}\n`); sh(wt(p, t), 'add', '.'); sh(wt(p, t), 'commit', '-qm', t.title)
  await hq.hook(e.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: `toolu_${e.id}_${Date.now()}` })
  await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(e.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone\n\n## Tests left out\nNothing', feature_map_unchanged: true })
  assert.equal(r.isError, false, r.text)
}
/** The engineer's plan, approved by the user (manual). */
async function approved(t: any, e: any): Promise<void> {
  const plan = hq.hook(e.id, exitPlanMode('Plan: write thing.txt.'))
  const rv = await waitFor('the review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open'))
  assert.equal((await hq.api(`reviews/${rv.id}/answer`, { verdict: 'approve' })).status, 200); await plan
}
/** A manual project's ticket built to the end (plan approved by the user, open_pr): it waits for the user's Merge into main. */
async function finishedManual(name: string): Promise<{ p: P; t: any; e: any }> {
  const p = await project(name), t = await ticket(p, 'Thing'), e = await launched(t); await approved(t, e)
  await finish(p, t, e); await hq.hook(e.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  await waitFor(`${t.key} to wait for the merge`, async () => (await tk(t))?.status === 'pr_ready'); return { p, t, e }
}

test('Clear: a restart while the TPM and an engineer write their notes; the board says the same, and the clear finishes with the TPM back', async () => {
  const p = await project('b293clear'), t = await ticket(p, 'Thing'), e = await launched(t); await approved(t, e)
  // Its turn ends first (a restart in the middle of a turn: the test of Bug 337 below)
  await hq.hook(e.id, { hook_event_name: 'Stop', last_assistant_message: 'Half done.' })
  const r = await hq.api(`repos/${p.repo.id}/clear`, {}); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.done, false)
  await waitFor('both asked for their notes', async () => (await agentOf(e.id))?.fresh_start_at && (await agentOf(p.tpm.id))?.fresh_start_at)
  const was = await restartMidway(p.repo.id)
  assert.ok(was.includes('top bar: Clearing… 2 notes to go'), `the board said the clear was under way:\n${was.join('\n')}`)
  assert.equal((await hq.mcp(e.id, 'write_handoff_note', { text: '## Where I stopped\n- planned (B293-ENG)' })).isError, false)
  assert.equal((await hq.mcp(p.tpm.id, 'write_handoff_note', { text: '## What the user wants\n- a thing (B293-TPM)' })).isError, false)
  await waitFor('the board gone', async () => !(await hq.state()).features.some((x: any) => x.repo_id === p.repo.id), 30_000)
  const next = await waitFor('the TPM back', async () => { const id = (await hq.state()).repos.find((x: any) => x.id === p.repo.id).tpm_agent_id
    return id && id !== p.tpm.id && (await agentOf(id))?.status === 'working' ? id : null }, 30_000)
  assert.match(fs.readFileSync(path.join(hq.hqHome, 'agents', next, 'prompt.md'), 'utf8'), /B293-TPM/)
  assert.equal((await agentOf(e.id))?.status ?? 'exited', 'exited')
})

test('an agent\'s background run and helper: a restart while the engineer waits on its tests and the TPM on its helper; both lines stay, and end with them', async () => {
  const p = await project('b293bg'), t = await ticket(p, 'Thing'), e = await launched(t)
  // the engineer's test run hit its time limit and went on in the background (Bugs 95/96); it ends its turn to wait for it
  await hq.hook(e.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_b293', tool_input: { command: 'npm test', timeout: 600000 } })
  await hq.hook(e.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_b293', tool_input: { command: 'npm test', timeout: 600000 },
    tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b293run', timedOutAfterMs: 600000 } })
  await hq.hook(e.id, { hook_event_name: 'Stop', last_assistant_message: 'The tests still run; I will read them when they finish.' })
  // the TPM started a helper in the background (Bug 94) and ended its turn
  const d = 'Map the code'
  await hq.hook(p.tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: d, subagent_type: 'Explore', run_in_background: true } })
  await hq.hook(p.tpm.id, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: d },
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'b293h', description: d } })
  await hq.hook(p.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'A helper maps the code.' })
  const was = await restartMidway(p.repo.id)
  assert.ok(was.some((l) => l.includes('Waiting on: npm test')), `the engineer's line said so:\n${was.join('\n')}`)
  assert.ok(was.some((l) => l.includes(`Subagent: ${d}`)), `the TPM's line said so:\n${was.join('\n')}`)
  // each ends with Claude Code's notice of it, and its agent is idle with nothing left on its line
  const notice = (task: string) => `<task-notification>\n<task-id>${task}</task-id>\n<status>completed</status>\n</task-notification>`
  for (const [id, task] of [[e.id, 'b293run'], [p.tpm.id, 'b293h']] as const) {
    await hq.hook(id, { hook_event_name: 'UserPromptSubmit', prompt: notice(task) }); await hq.hook(id, { hook_event_name: 'Stop', last_assistant_message: 'Read it.' })
    const a = await agentOf(id); assert.deepEqual([a.status, a.activity ?? null], ['idle', null], id)
  }
})

test('Bug 337: a restart in the middle of a turn: the engineer reading its brief and the TPM reading a file still say so, and the lines end with the turn', async () => {
  const p = await project('b337turn'), t = await ticket(p, 'Thing'), e = await launched(t) // the engineer reads its brief: "Thinking"
  await hq.hook(p.tpm.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(p.dir, 'src', 'b337.js') } })
  const was = await restartMidway(p.repo.id)
  assert.ok(was.some((l) => l.startsWith(`${t.key} `) && l.includes('Thinking')), `the engineer's line said so:\n${was.join('\n')}`)
  // the TPM's box has no such line; the Agents menu shows it (frontend api.ts menuActivity)
  assert.equal((await agentOf(p.tpm.id)).activity, 'Reading src/b337.js')
  // what must not stay: a line the agent's next hook replaces, or one its turn's end clears, is gone from the page and from what a restart reads back
  await hq.hook(e.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_b337', tool_input: { command: 'ls' } })
  await hq.hook(p.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Read it.' })
  const lines = async () => [(await agentOf(e.id)).activity ?? null, (await agentOf(p.tpm.id)).activity ?? null]
  assert.deepEqual(await lines(), ['Running: ls', null])
  await hq.restart()
  await waitFor('the lines after a second restart', async () => JSON.stringify(await lines()) === JSON.stringify(['Running: ls', null]), 20_000).catch(async () =>
    assert.deepEqual(await lines(), ['Running: ls', null], 'the lines after a second restart'))
})

test('Bug 348: a restart while an engineer works through its plan\'s steps; its box still counts them, and the next step counts on from there', async () => {
  const p = await project('b348steps'), t = await ticket(p, 'Thing'), e = await launched(t); await approved(t, e)
  const task = (name: string, input: Record<string, unknown>, id: string) =>
    hq.hook(e.id, { hook_event_name: 'PostToolUse', tool_name: name, tool_input: input, tool_response: { id }, tool_use_id: `toolu_b348_${name}_${id}_${Date.now()}` })
  for (const [n, s] of [['1', 'Write it'], ['2', 'Test it'], ['3', 'Say so']] as const) await task('TaskCreate', { subject: s }, n)
  await task('TaskUpdate', { taskId: '1', status: 'completed' }, '1')
  const was = await restartMidway(p.repo.id)
  assert.ok(was.some((l) => l.startsWith(`${t.key} `) && l.includes('step 1/3')), `the engineer's box counted its steps:\n${was.join('\n')}`)
  const steps = async () => { const a = await agentOf(e.id); return [a.steps_done, a.steps_total] }
  assert.deepEqual(await steps(), [1, 3]) // the Agents menu says it too (App.tsx AgentsMenu)
  await task('TaskUpdate', { taskId: '2', status: 'completed' }, '2'); assert.deepEqual(await steps(), [2, 3]) // counted on from the stored steps
  // what must not come back: steps HQ has no rows for (an agent that made no task list) stay off its box
  assert.equal((await agentOf(p.tpm.id)).steps_total, undefined)
})

test('Bug 348: a restart while a message waits to be typed behind a half-written line; the mod\'s next ask (every 1.5 s) says why again', async () => {
  const p = await project('b348draft'), t = await ticket(p, 'Thing'), e = await launched(t)
  await hq.modEvent(e.id, { kind: 'turn.complete', turnId: 't', agentId: null, isAborted: true, durationMs: 9000, answer: '' }) // Escape: HQ types its messages
  const rule = '─'.repeat(60) // Claude Code's prompt box with a line somebody typed and didn't send (2.1.322, as delivery.test.ts draws it)
  await hq.screen(e.id, `\x1b[38;5;244m${rule}\n\x1b[39m❯ half-typed words of mine\n\x1b[38;5;244m${rule}\n\x1b[39m  ⏸ manual mode on\n`)
  assert.equal((await hq.api(`agents/${e.id}/message`, { body: 'A note for b348.', reason: 'fyi' })).status, 200)
  await waitFor('HQ to hold it back (draft)', async () => { await hq.modNext(e.id); return (await agentOf(e.id)).type_waits === 'draft' })
  // the reason is kept in memory only (delivery.ts typeWaits): nothing stores it, because the mod asks again within 1.5 s of HQ being back, and that ask
  // looks at the screen again. The harness has no mod: its ask is made here
  const at = Date.now(), was = await board(p.repo.id, at); await hq.restart()
  assert.ok(was.some((l) => l.startsWith(`${t.key} `) && l.includes('held · a half-written line')), `the box said why:\n${was.join('\n')}`)
  await hq.modNext(e.id)
  await waitFor('the box to say why again', async () => JSON.stringify(await board(p.repo.id, at)) === JSON.stringify(was), 20_000)
    .catch(async () => assert.deepEqual(await board(p.repo.id, at), was))
})

test('Launch: a restart while Claude works out how to start the app; the pane still says so, and its steps run once the user OKs them', async () => {
  const dir = hq.repo('b293launch'); fs.rmSync(path.join(dir, 'package.json')); sh(dir, 'commit', '-qam', 'nothing HQ could guess from')
  const repo = (await hq.api('repos', { path: dir })).json
  const r = (await hq.api(`previews/${repo.id}/start`, {})).json, h = r.helper_agent_id; assert.equal(r.helper_state, 'working')
  await waitFor('the helper', async () => { const a = await agentOf(h); return a && a.status !== 'launching' })
  const was = await restartMidway(repo.id)
  assert.ok(was.includes('app pane: stopped · helper working'), was.join('\n'))
  const steps = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port: 'auto' }], show: 'app', worktree_files: [], notes: '' }
  assert.equal((await hq.mcp(h, 'save_launch', steps)).isError, false)
  assert.equal((await hq.state()).previews.find((x: any) => x.id === repo.id).helper_state, 'needs_ok')
  assert.equal((await hq.api(`previews/${repo.id}/approve`, {})).status, 200)
  const pv = await waitFor('the app', async () => { const x = (await hq.state()).previews.find((y: any) => y.id === repo.id); return x.status === 'running' ? x : null }, 20_000)
  assert.equal(await (await fetch(pv.url)).text(), 'v1\n')
  await hq.mcp(h, 'launch_ok', {}).catch(() => null)
  assert.equal((await hq.api(`previews/${repo.id}/stop`, {})).status, 200)
})

/** An app that takes 1.5 s to stop after SIGTERM, running: long enough for a restart to cut its Stop short (preview-stop-restart.test.ts). */
async function slowApp(name: string): Promise<{ repo: any; name: string }> {
  const dir = hq.repo(name)
  fs.writeFileSync(path.join(dir, 'server.js'), "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1500))\n"
    + "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT)\n"); sh(dir, 'commit', '-qam', 'slow to stop')
  const repo = (await hq.api('repos', { path: dir })).json
  await hq.api(`previews/${repo.id}/command`, { command: 'npm start' })
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
  await waitFor(`${name} to run`, async () => (await hq.state()).previews.find((x: any) => x.id === repo.id).status === 'running', 20_000)
  return { repo, name }
}
test('Stop: a restart while the app stops; once HQ is back it says stopped, as a Stop with no restart does, and nothing else on the board changed', async () => {
  const cut = await slowApp('b293stopcut'), plain = await slowApp('b293stopok')
  assert.equal((await hq.api(`previews/${plain.repo.id}/stop`, {})).status, 200)
  const call = hq.api(`previews/${cut.repo.id}/stop`, {}).catch(() => null)
  await waitFor('HQ to begin stopping it', async () => (await hq.state()).previews.find((x: any) => x.id === cut.repo.id).stopping === 'stop')
  const at = Date.now(), was = await board(cut.repo.id, at)
  assert.ok(was.includes('app pane: running (stop) · helper none'), was.join('\n'))
  await hq.down(); await call; await hq.up()
  await sameAsTwin(cut, plain)
  const now = await board(cut.repo.id, at); assert.deepEqual(now.filter((l) => !l.startsWith('app pane:')), was.filter((l) => !l.startsWith('app pane:')), 'nothing else changed')
})

// HELD: a test command that waits until the test lets it go, with a file in the run's own checkout (auto.test.ts says more)
const HELD = 'until [ -f go ]; do sleep 0.1; done'
const runDirs = (p: P): string[] => {
  const d = path.join(p.dir, '.claude', 'worktrees'); return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.startsWith('hq-test-')).map((x) => path.join(d, x)) : []
}
const letGo = (p: P) => waitFor("the run's checkout", () => { const ds = runDirs(p); for (const d of ds) fs.writeFileSync(path.join(d, 'go'), ''); return ds.length > 0 })
const testing = async (p: P): Promise<string> => (await hq.state()).testRuns.filter((r: any) => r.repo_id === p.repo.id).map((r: any) => `${r.ticket_id ?? 'main'}:${r.state}`).join(' ')

test('a test run: a restart while HQ tests a finished ticket on auto; the board says HQ is testing it again, and it merges once the tests pass', async () => {
  const p = await project('b293run', { auto: true, testCmd: HELD }), t = await ticket(p, 'Thing'); await turnEnds(p)
  await waitFor('the check of main', async () => (await testing(p)) === 'main:running', 20_000); await letGo(p)
  const e = await engineerOn(t)
  assert.equal((await hq.hook(e.id, exitPlanMode('Plan: write thing.txt.'))).hookSpecificOutput.decision.behavior, 'allow') // no criteria: approved at once
  await finish(p, t, e)
  await waitFor(`HQ testing ${t.key}`, async () => (await testing(p)) === `${t.id}:running`, 20_000)
  const was = await restartMidway(p.repo.id) // the run goes with the backend (index.ts killTestRuns); auto mode's next look starts it again
  assert.ok(was.some((l) => l.startsWith('top bar: ') && l.includes(t.key)), `the top bar said HQ tests it:\n${was.join('\n')}`)
  await letGo(p)
  await waitFor(`${t.key} merged`, async () => (await tk(t))?.status === 'merged', 30_000)
  assert.equal(JSON.parse((await tk(t)).merge_test).ran, 'pass')
})

test('a merge: a restart after Merge into main moved main but before HQ heard; once HQ is back the ticket is merged, as a merge with no restart', async () => {
  const cut = await finishedManual('b293mergecut'), plain = await finishedManual('b293mergeok')
  assert.equal((await hq.api(`tickets/${plain.t.id}/merge`, {})).status, 200)
  fs.writeFileSync(flag, '')
  try {
    void hq.api(`tickets/${cut.t.id}/merge`, {}).catch(() => null) // it never answers: the backend goes down under it
    await waitFor('git to have moved main', () => fs.existsSync(held), 15_000)
    assert.equal(sh(cut.p.dir, 'log', '-1', '--format=%s', 'main'), 'Merge T-01: Thing')
    assert.equal((await tk(cut.t)).status, 'pr_ready', 'HQ has not heard yet')
    await hq.down()
  } finally { fs.rmSync(flag, { force: true }); fs.rmSync(held, { force: true }) }
  await hq.up()
  await waitFor(`${cut.t.key} merged`, async () => (await tk(cut.t))?.status === 'merged', 20_000)
  await sameAsTwin(cut.p, plain.p)
  // What it must not catch: a Merge HQ refused (here the checkout has a change), then a merge the user made by hand, is still one made outside HQ
  const hand = await finishedManual('b293mergehand')
  fs.appendFileSync(path.join(hand.p.dir, 'version.txt'), 'edited\n')
  assert.equal((await hq.api(`tickets/${hand.t.id}/merge`, {})).status, 409)
  sh(hand.p.dir, 'checkout', '--', 'version.txt'); sh(hand.p.dir, 'merge', '--no-edit', (await tk(hand.t)).branch)
  await hq.api(`repos/${hand.p.repo.id}/sync`, {}) // a sync looks for merges (as the 2-minute watcher would)
  await waitFor(`${hand.t.key} merged`, async () => (await tk(hand.t))?.status === 'merged', 20_000)
  assert.equal(JSON.parse((await tk(hand.t)).merge_test).by, 'outside')
  assert.ok((await board(hand.p.repo.id, Date.now())).includes('⚠ merged: T-01 merged.'), 'and the user is told it merged')
})

test('a plan check: a restart while HQ\'s reader has the plan; the board says HQ checks it again, and the plan is approved once the reader answers', async () => {
  const p = await project('b293plan', { auto: true }), crit = [{ kind: 'backend', text: 'Adding 2 and 3 gives 5.' }]
  const t = await ticket(p, 'Adding', { criteria: crit }); await turnEnds(p)
  const e = await engineerOn(t), text = 'Plan: add.js.\nFAKE-CHECK: hold b293-answer' // the reader answers "ok" once the file is there (fake-claude.mjs)
  await waitFor('the check of main to end', async () => (await testing(p)) === '', 20_000) // one action at a time
  const planCheck = async () => { const r = (await hq.state()).reviews.find((x: any) => x.ticket_id === t.id && x.status === 'open'); return r?.plan_check ? JSON.parse(r.plan_check) : null }
  hq.hook(e.id, exitPlanMode(text)).catch(() => {}) // its call goes with the backend
  await waitFor('the reader to have it', async () => (await planCheck())?.state === 'checking')
  const readers = () => fs.readFileSync(path.join(hq.home, 'fake-checks.jsonl'), 'utf8').trim().split('\n').length
  const was = await restartMidway(p.repo.id)
  assert.ok(was.some((l) => /plan check/i.test(l)), `the board said HQ checks its plan:\n${was.join('\n')}`)
  await waitFor('a fresh reader', () => readers() === 2, 10_000)
  const again = hq.hook(e.id, exitPlanMode(text)) // Claude Code asks again (hookwait.mjs), and is held for the same review
  fs.writeFileSync(path.join(hq.home, 'b293-answer'), '')
  assert.equal((await again).hookSpecificOutput.decision.behavior, 'allow')
  assert.equal((await tk(t)).status, 'implementing')
})

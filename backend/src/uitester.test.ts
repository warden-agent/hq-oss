// The UI tester's moving parts for real (uitester.ts): its host in HQ's test sandbox with a small app under it (uitesthost.mjs), and its browser, Playwright
// MCP in the browser's own sandbox, started exactly as Claude Code would start it and driven here by the MCP SDK's own client in place of the tester. The
// lockdown Claude Code adds on top (its flags and hooks) is checked as data at the end; e2e/auto.test.ts runs the whole tester at the end of a run.
// macOS only, like the tester. The browser test needs HQ's browser on the machine (HQ_TEST_BROWSER=1 downloads it), as smoke.test.ts does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-uitester-'))
process.env.HQ_LOOK_START_S = '6'
const { migrate } = await import('./db.ts'); migrate()
const { browserHere, ensureBrowser, headlessShell, appSpec, lookHow } = await import('./smoke.ts')
const { runSandboxed, sandboxProblem } = await import('./testrun.ts')
const { _forTests } = await import('./uitester.ts')
const { testerFlags, testerSettings, TESTER_TOOLS } = await import('./roles.ts')
const { LOOK_TOOLS, ON_ELEMENT } = await import('./uitesterrules.ts')

const mac = process.platform === 'darwin'
const noSandbox = mac ? await sandboxProblem() : 'the UI tester runs on macOS only'
const noBrowser = noSandbox ?? (!browserHere() && process.env.HQ_TEST_BROWSER !== '1' ? "HQ's browser isn't on this machine yet (HQ_TEST_BROWSER=1 downloads it)" : null)
const HOST = path.join(import.meta.dirname, 'uitesthost.mjs')
// An app that keeps what it's given in a file, as many small apps do, and says how many it has
const APP = `const http = require('node:http'), fs = require('node:fs'), f = 'data/items.json'
const items = () => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return [] } }
http.createServer((q, s) => {
  if (q.method === 'POST') { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(f, JSON.stringify([...items(), 'x'])); return s.end('added') }
  s.end('<!doctype html><title>Library</title><h1>Library</h1><p>' + items().length + ' items</p><button>Add</button>')
}).listen(Number(process.env.PORT), '127.0.0.1')
`
const post = async (ctrl: number, what: string, body: unknown) => (await fetch(`http://127.0.0.1:${ctrl}/${what}`, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<any>
const hook = (name: string, id: string) => ({ tool_name: `mcp__browser__browser_${name}`, tool_use_id: id, tool_input: {} })
const answers = async (url: string) => { try { return await (await fetch(url, { signal: AbortSignal.timeout(1000) })).text() } catch { return null } }

test('the host: the app under it, reset to its first state before each scenario on the same port, each step stamped, and the budget and order held in code',
  { skip: noSandbox ?? false, timeout: 60_000 }, async () => {
    const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-uitester-app-'))); fs.writeFileSync(path.join(wt, 'server.js'), APP)
    fs.mkdirSync(path.join(wt, 'web', 'node_modules', 'pkg'), { recursive: true }); fs.writeFileSync(path.join(wt, 'web', 'node_modules', 'pkg', 'index.js'), '1') // installed: never copied
    const recipe = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port: 'auto' as const }], show: 'app', worktree_files: [], notes: '' }
    const out = path.join(wt, '.hq-uitest'), spec = { ...appSpec(wt, { recipe, repoPath: wt, how: lookHow(recipe) }), out, budget: { actions: 2, looks: 3, screenshots: 0 },
      looks: LOOK_TOOLS, shots: ['take_screenshot'], onElement: ON_ELEMENT }
    const stop = new AbortController()
    const run = runSandboxed(wt, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(HOST)} '${JSON.stringify(spec)}'`, { network: false, timeoutMs: 60_000, signal: stop.signal })
    let up: any = null; for (let i = 0; i < 100 && !up; i++) { try { up = JSON.parse(fs.readFileSync(path.join(out, 'host.json'), 'utf8')) } catch { await new Promise((r) => setTimeout(r, 100)) } }
    assert.equal(up?.started, true, JSON.stringify(up)); const url = `http://localhost:${up.port}/`
    // Nothing runs before a scenario begins
    assert.match((await post(up.ctrl, 'pre', hook('navigate', 'a'))).hookSpecificOutput.permissionDecisionReason, /^Call start_scenario first/)
    assert.deepEqual(await post(up.ctrl, 'start', { id: 's-01' }), { ok: true, url })
    await fetch(url, { method: 'POST' }); assert.match(await answers(url) ?? '', /1 items/) // the app keeps a record in its folder
    assert.deepEqual(await post(up.ctrl, 'pre', hook('navigate', 'n1')), {}); await post(up.ctrl, 'post', { ...hook('navigate', 'n1'), tool_response: [{ type: 'text', text: 'ok' }] })
    assert.match((await post(up.ctrl, 'pre', hook('click', 'c0'))).hookSpecificOutput.permissionDecisionReason, /^Look at the page first/) // no look at this page yet
    assert.deepEqual(await post(up.ctrl, 'pre', hook('snapshot', 's1')), {})
    await post(up.ctrl, 'post', { ...hook('snapshot', 's1'), tool_response: [{ type: 'text', text: '### Snapshot\n```yaml\n- button "Add"\n```' }] })
    assert.deepEqual(await post(up.ctrl, 'pre', hook('click', 'c1')), {}); await post(up.ctrl, 'post-failed', { ...hook('click', 'c1'), error: 'Ref e9 not found' })
    assert.match((await post(up.ctrl, 'pre', hook('click', 'c2'))).hookSpecificOutput.permissionDecisionReason, /actions are used up \(2\)/) // budget: 2 actions
    assert.match((await post(up.ctrl, 'start', { id: 's-02' })).why, /^s-01 isn't finished/) // one at a time, each finished
    assert.deepEqual(await post(up.ctrl, 'finish', { id: 's-01', report: { outcome: 'ok' } }), { ok: true })
    const kept = JSON.parse(fs.readFileSync(path.join(out, 's-01.json'), 'utf8'))
    assert.deepEqual(kept.log.map((e: any) => `${e.tool}${e.ok ? '' : '!'}`), ['navigate', 'snapshot', 'click!']); assert.deepEqual(kept.report, { outcome: 'ok' })
    assert.ok(kept.log.every((e: any, i: number) => e.at >= kept.began && (!i || e.at >= kept.log[i - 1].at)), 'stamped in order on one clock')
    // The next scenario starts clean: the record the app wrote is gone, and it's back on the same port
    assert.deepEqual(await post(up.ctrl, 'start', { id: 's-02' }), { ok: true, url }); assert.match(await answers(url) ?? '', /0 items/)
    assert.equal(fs.existsSync(path.join(wt, 'data', 'items.json')), false); assert.equal(fs.existsSync(path.join(wt, 'server.js')), true)
    assert.equal(fs.existsSync(path.join(wt, 'web', 'node_modules', 'pkg', 'index.js')), true); assert.equal(fs.existsSync(path.join(out, 'seed', 'web', 'node_modules')), false)
    // A session that ends mid-scenario: HQ closes it, it's written as it stood with no report, and the next session's first scenario can begin
    await post(up.ctrl, 'pre', hook('navigate', 'n2')); await post(up.ctrl, 'post', { ...hook('navigate', 'n2'), tool_response: [{ type: 'text', text: 'ok' }] })
    assert.deepEqual(await post(up.ctrl, 'close', {}), { ok: true })
    const left = JSON.parse(fs.readFileSync(path.join(out, 's-02.json'), 'utf8')); assert.equal(left.report, null); assert.deepEqual(left.log.map((e: any) => e.tool), ['navigate'])
    assert.deepEqual(await post(up.ctrl, 'start', { id: 's-03' }), { ok: true, url })
    stop.abort(); await run
    for (let i = 0; i < 30 && await answers(url) !== null; i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(await answers(url), null, 'the app ends with the host'); fs.rmSync(wt, { recursive: true, force: true })
  })

// Bug 170: an app whose start forks (`npm start`: a shell running npm running node), as many projects' do. Its page says which process serves it.
const FORKS = `const http = require('node:http'), fs = require('node:fs')
if (process.env.ONCE && fs.existsSync('node_modules/.started')) { console.error('only once'); process.exit(3) } // installed packages: a reset never puts them back
fs.mkdirSync('node_modules', { recursive: true }); fs.writeFileSync('node_modules/.started', '')
http.createServer((q, s) => s.end('<!doctype html><title>Pid</title><p>pid ' + process.pid + '</p>')).listen(Number(process.env.PORT), '127.0.0.1')
`
async function forkingHost(run: string) {
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-uitester-npm-'))); fs.writeFileSync(path.join(wt, 'server.js'), FORKS)
  fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ name: 'forks', private: true, scripts: { start: 'node server.js', once: 'ONCE=1 node server.js' } }))
  const recipe = { parts: [{ name: 'web', dir: '.', run, port: 'auto' as const }], show: 'web', worktree_files: [], notes: '' }
  const out = path.join(wt, '.hq-uitest'), spec = { ...appSpec(wt, { recipe, repoPath: wt, how: lookHow(recipe) }), out, budget: { actions: 2, looks: 2, screenshots: 0 },
    looks: LOOK_TOOLS, shots: ['take_screenshot'], onElement: ON_ELEMENT }
  const stop = new AbortController()
  const run0 = runSandboxed(wt, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(HOST)} '${JSON.stringify(spec)}'`, { network: false, timeoutMs: 60_000, signal: stop.signal })
  let up: any = null; for (let i = 0; i < 150 && !up; i++) { try { up = JSON.parse(fs.readFileSync(path.join(out, 'host.json'), 'utf8')) } catch { await new Promise((r) => setTimeout(r, 100)) } }
  return { wt, out, up, url: `http://localhost:${up?.port}/`, end: async () => { stop.abort(); await run0 } }
}
const pidOf = async (url: string) => Number(/pid (\d+)/.exec(await answers(url) ?? '')?.[1]) || null
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test('the host on an app started through npm: each reset ends the whole old app, server and all, and starts it again on the same port; the app ends with the host',
  { skip: noSandbox ?? false, timeout: 60_000 }, async () => {
    const h = await forkingHost('npm start'); const { up, url } = h
    try {
      assert.equal(up?.started, true, JSON.stringify(up)); const first = await pidOf(url); assert.ok(first)
      assert.deepEqual(await post(up.ctrl, 'start', { id: 's-01' }), { ok: true, url }) // HQ's sandbox refuses ps: the reset ends the app's group instead
      const second = await pidOf(url); assert.ok(second && second !== first, `a new server (${first} → ${second})`); assert.equal(alive(first!), false, 'the old server is gone')
      assert.deepEqual(await post(up.ctrl, 'finish', { id: 's-01', report: { outcome: 'ok' } }), { ok: true })
      assert.deepEqual(await post(up.ctrl, 'start', { id: 's-02' }), { ok: true, url }); const third = await pidOf(url)
      assert.ok(third && third !== second); assert.equal(alive(second!), false); assert.equal(fs.existsSync(path.join(h.out, 'reset-failed.json')), false)
    } finally { await h.end() }
    const last = await pidOf(url) // killed outright, the host can't stop the app itself: the app's own watcher ends it
    for (let i = 0; i < 30 && await answers(url) !== null; i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(await answers(url), null, 'the app ends with the host'); assert.equal(last === null || !alive(last), true); fs.rmSync(h.wt, { recursive: true, force: true })
  })

test('the host when a reset can\'t start the app again: the tester is told why, and so is HQ, once, for the run\'s summary', { skip: noSandbox ?? false, timeout: 60_000 }, async () => {
  const h = await forkingHost('npm run once'); const { up } = h
  try {
    assert.equal(up?.started, true, JSON.stringify(up))
    const r = await post(up.ctrl, 'start', { id: 's-01' }); assert.equal(r.ok, false); assert.match(r.why, /^the app didn't start: its web part stopped \(3\) while the app was starting$/)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.out, 'reset-failed.json'), 'utf8')), { id: 's-01', why: r.why })
    assert.equal(_forTests.resetFailed(h.out), r.why); assert.equal(_forTests.resetFailed(h.out), null) // read once: the next session starts with none
  } finally { await h.end(); fs.rmSync(h.wt, { recursive: true, force: true }) }
})

/** Starts the host in HQ's sandbox on a small app in a fresh folder; `record`: the test setup's part of its spec. */
async function hostOn(record: Record<string, unknown> | null, budget = { actions: 6, looks: 6, screenshots: 0 }) {
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-uitester-rec-'))); fs.writeFileSync(path.join(wt, 'server.js'), APP)
  fs.writeFileSync(path.join(wt, 'seed.json'), '["seeded"]')
  const recipe = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port: 'auto' as const }], show: 'app', worktree_files: [], notes: '' }
  const out = path.join(wt, '.hq-uitest'), spec = { ...appSpec(wt, { recipe, repoPath: wt, how: lookHow(recipe) }), out, budget, looks: LOOK_TOOLS, shots: ['take_screenshot'],
    onElement: ON_ELEMENT, ...(record ? { record: { root: wt, parts: [{ name: 'app', cwd: wt, run: 'node server.js', port: 'auto' }], ...record } } : {}) }
  const stop = new AbortController()
  const run = runSandboxed(wt, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(HOST)} '${JSON.stringify(spec)}'`, { network: false, timeoutMs: 60_000, signal: stop.signal })
  let up: any = null; for (let i = 0; i < 150 && !up; i++) { try { up = JSON.parse(fs.readFileSync(path.join(out, 'host.json'), 'utf8')) } catch { await new Promise((r) => setTimeout(r, 100)) } }
  return { wt, out, up, url: `http://localhost:${up?.port}/`, end: async () => { stop.abort(); await run; fs.rmSync(wt, { recursive: true, force: true }) } }
}
const jsonl = (f: string) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const SEED = 'mkdir -p data && cp seed.json data/items.json' // no quotes of its own: the test hands the spec to a shell in single quotes

test('the host with a test setup: the app runs under HQ\'s recorder on the seed, and each scenario gets a recording of its own, begun from a reset',
  { skip: noSandbox ?? false, timeout: 90_000 }, async () => {
    const h = await hostOn({ snapshot: ['data'], seed: SEED }); const { up, out, url } = h
    try {
      assert.equal(up?.started, true, JSON.stringify(up)); assert.equal(up.recorded, true); assert.equal(up.unrecorded, undefined)
      assert.deepEqual(await post(up.ctrl, 'start', { id: 's-01' }), { ok: true, url }); assert.match(await answers(url) ?? '', /1 items/) // the seed, through the recorder's address
      const step = async (name: string, id: string, input: Record<string, unknown>, act: () => Promise<unknown>, answer: string) => {
        const hk = { ...hook(name, id), tool_input: input }; assert.deepEqual(await post(up.ctrl, 'pre', hk), {}); await act()
        await post(up.ctrl, 'post', { ...hk, tool_response: [{ type: 'text', text: answer }] })
      }
      await step('navigate', 'n1', { url }, () => fetch(url), 'ok')
      await step('snapshot', 'l1', {}, async () => {}, '### Snapshot\n```yaml\n- button "Add"\n```')
      const bad = { ...hook('type', 't1'), tool_input: { target: 'textbox "Name"', text: 'Dune' } } // a step the browser refused: named as the tester asked for it
      assert.deepEqual(await post(up.ctrl, 'pre', bad), {}); await post(up.ctrl, 'post-failed', { ...bad, error: 'not a valid target' })
      const RAN = "### Ran Playwright code\n```js\nawait page.getByRole('button', { name: 'Add' }).click();\n```\n"
      await step('click', 'c1', { target: 'f3e101' }, () => fetch(url, { method: 'POST' }), `${RAN}### Events\n- New console entries: ../out/console-2026.log#L2-L4`)
      assert.deepEqual(await post(up.ctrl, 'finish', { id: 's-01', report: { outcome: 'ok' } }), { ok: true })
      const kept = JSON.parse(fs.readFileSync(path.join(out, 's-01.json'), 'utf8')); assert.equal(kept.recorded, true)
      assert.ok(kept.log.find((e: any) => e.tool === 'click').ms < 5000)
      const r1 = path.join(out, 'rec', 's-01'), marks = jsonl(path.join(r1, 'actions.jsonl'))
      assert.deepEqual(marks.map((m: any) => `${m.label}:${m.phase}${m.ok === false ? '!' : ''}`), ['reset:start', 'reset:end', 'open /:start', 'open /:end',
        'type "Dune" into textbox "Name":start', 'type "Dune" into textbox "Name":end!', 'click an element:start', 'click an element:end']) // a look is not an action
      const click = marks.find((m: any) => m.label === 'click an element').action
      assert.deepEqual(jsonl(path.join(r1, 'api.jsonl')).filter((c: any) => c.method === 'POST').map((c: any) => [c.status, c.action]), [[200, click]]) // the call is the click's
      assert.deepEqual(jsonl(path.join(r1, 'snaps.jsonl')).map((x: any) => [x.label, x.changed]),
        [['reset', true], ['open /', false], ['type "Dune" into textbox "Name"', false], ['click an element', true]])
      assert.deepEqual(jsonl(path.join(r1, 'console-refs.jsonl')).map((x: any) => [x.file, x.from, x.to, x.action]), [['console-2026.log', 2, 4, click]]) // by its name alone
      // What HQ keeps of it (uitester.ts): the console errors those lines name, and the timeline the checker reads
      const b = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-uitester-b-')), to = path.join(b, 's-01.rec')
      fs.writeFileSync(path.join(b, 'console-2026.log'), '[     10ms] [LOG] hello @ http://localhost:1/:1\n[    900ms] [ERROR] boom from the page 42 @ http://localhost:1/app.js:12\n'
        + '[    901ms] TypeError: items.map is not a function\n    at render (http://localhost:1/app.js:3:1)\n[   2000ms] [ERROR] a later one @ x:1\n')
      const s1 = { id: 's-01', kind: 'basic' as const, title: 'Add one', goal: 'g' }, ran = _forTests.ranOf(s1, out, `http://localhost:${up.port}`)
      assert.deepEqual([...ran], [[click, 'click button "Add"']]) // what the browser ran for it, from the host's log; the opened page said no code here
      assert.equal(_forTests.keepRecording(r1, to, b, { start: [], snapshot: ['data'], seed: SEED, endpoints: [], notes: '' }, s1, ran), true)
      const md = fs.readFileSync(path.join(to, 'timeline.md'), 'utf8')
      assert.match(md, /\| hq \| reset the app to its seed \|[\s\S]*\| tester \| open \/ \|[\s\S]*\| tester \| ✗ type "Dune" into textbox "Name" \(not a valid target\) \|/)
      assert.match(md, /\| tester \| click button "Add" \|[\s\S]*\| api \| POST \/ → 200 /)
      assert.match(md, /\| data \| items: \+x \|/); assert.match(md, /console error: boom from the page 42 ⚠/)
      assert.match(md, /console error: TypeError: items\.map is not a function ⚠/); assert.doesNotMatch(md, /hello|a later one|at render/) // only the step's lines, only errors
      assert.deepEqual(_forTests.consoleErrors(path.join(to, 'console-refs.jsonl'), path.join(b, 'nowhere')), []) // the browser's log is gone: nothing, not an error
      assert.equal(_forTests.keepRecording(path.join(out, 'rec', 'none'), path.join(b, 'none.rec'), b, { start: [], snapshot: ['data'], seed: SEED, endpoints: [], notes: '' },
        { id: 'none', kind: 'basic', title: 't', goal: 'g' }), false)
      // The next scenario: the app is back on its seed behind the same address, and its recording has nothing of the first one's
      assert.deepEqual(await post(up.ctrl, 'start', { id: 's-02' }), { ok: true, url }); assert.match(await answers(url) ?? '', /1 items/)
      await step('navigate', 'n2', { url: `${url}list?x=1` }, () => fetch(url), 'ok')
      assert.deepEqual(await post(up.ctrl, 'close', {}), { ok: true }) // the session ended mid-scenario
      const r2 = path.join(out, 'rec', 's-02')
      assert.deepEqual(jsonl(path.join(r2, 'actions.jsonl')).map((m: any) => m.label), ['reset', 'reset', 'open /list?x=1', 'open /list?x=1'])
      assert.equal(jsonl(path.join(r2, 'api.jsonl')).filter((c: any) => c.method === 'POST').length, 0)
      await fetch(url, { method: 'POST' }) // between scenarios: in neither one's recording
      assert.equal(jsonl(path.join(r2, 'api.jsonl')).filter((c: any) => c.method === 'POST').length, 0)
      assert.equal(jsonl(path.join(r1, 'api.jsonl')).filter((c: any) => c.method === 'POST').length, 1)
      fs.rmSync(b, { recursive: true, force: true })
    } finally { await h.end() }
    for (let i = 0; i < 30 && await answers(url) !== null; i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(await answers(url), null, 'the app and the recorder end with the host')
  })

test('the host with a test setup that no longer starts the app: the tester still gets the app on a plain start, and the host says why nothing is recorded',
  { skip: noSandbox ?? false, timeout: 60_000 }, async () => {
    const h = await hostOn({ snapshot: ['data'], seed: 'echo no such fixture >&2; exit 3' }); const { up, out, url } = h
    try {
      assert.equal(up?.started, true, JSON.stringify(up)); assert.equal(up.recorded, false); assert.match(up.unrecorded, /^the seed command failed \(code 3\): no such fixture$/)
      assert.deepEqual(await post(up.ctrl, 'start', { id: 's-01' }), { ok: true, url }); assert.match(await answers(url) ?? '', /0 items/)
      await post(up.ctrl, 'pre', hook('navigate', 'n1')); await post(up.ctrl, 'post', { ...hook('navigate', 'n1'), tool_response: [{ type: 'text', text: 'ok' }] })
      assert.deepEqual(await post(up.ctrl, 'finish', { id: 's-01', report: { outcome: 'ok' } }), { ok: true })
      assert.equal(JSON.parse(fs.readFileSync(path.join(out, 's-01.json'), 'utf8')).recorded, false); assert.equal(fs.existsSync(path.join(out, 'rec', 's-01')), false)
    } finally { await h.end() }
  })

test('the browser: Playwright MCP in its own sandbox reaches the app and nothing else, can\'t open files, and answers with the page as text',
  { skip: noBrowser ?? false, timeout: 120_000 }, async () => {
    assert.equal(await ensureBrowser(), null)
    const app = http.createServer((_q, s) => s.end('<!doctype html><title>Library</title><h1>Library</h1><button>Add</button>')), other = http.createServer((_q, s) => s.end('secret'))
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r)); await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
    const port = (app.address() as { port: number }).port, otherPort = (other.address() as { port: number }).port
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-uitester-project-'))); fs.writeFileSync(path.join(project, 'secret.js'), 'const key = 1')
    const b = fs.mkdtempSync('/private/tmp/hq-ut-test-'); for (const d of ['empty', 'home', 'out']) fs.mkdirSync(path.join(b, d))
    const cmd = _forTests.browserServer(b, port, project, headlessShell()!)
    const client = new Client({ name: 'hq-test', version: '0.0.1' }); await client.connect(new StdioClientTransport({ command: cmd.command, args: cmd.args, stderr: 'pipe' }))
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text?: string }[]; isError?: boolean }
      return { text: r.content.map((c) => c.text ?? `[${c.type}]`).join('\n'), isError: !!r.isError }
    }
    try {
      assert.match((await call('browser_navigate', { url: `http://localhost:${port}/` })).text, /await page\.goto\('http:\/\/localhost:\d+\/'\);[\s\S]*Page Title: Library/)
      const look = (await call('browser_snapshot', {})).text; assert.match(look, /- heading "Library" \[level=1\][\s\S]*- button "Add"/)
      const ref = /button "Add" \[ref=(\w+)\]/.exec(look)![1]
      assert.match((await call('browser_click', { element: 'Add', target: ref })).text, /await page\.getByRole\('button', \{ name: 'Add' \}\)\.click\(\)/) // the code a replay uses
      const shot = await call('browser_take_screenshot', {}); assert.match(shot.text, /\[image\]/) // for layout: the tester sees it
      const elsewhere = await call('browser_navigate', { url: `http://localhost:${otherPort}/` }); assert.match(elsewhere.text, /ERR_BLOCKED_BY_CLIENT/) // Playwright's list
      assert.doesNotMatch(elsewhere.text, /secret/)
      assert.match((await call('browser_navigate', { url: `file://${project}/secret.js` })).text, /Access to "file:" protocol is blocked/)
      assert.deepEqual(fs.readdirSync(path.join(b, 'empty')), [], 'the folder it starts in stays empty')
      // Playwright's list of origins is no boundary (its own docs say so): without it, HQ's sandbox still lets the browser reach the app's port only
      await client.close()
      const bare = { ...cmd, args: cmd.args.map((a) => a.replace(/ '--allowed-origins' '[^']*'/, '')) }; assert.notDeepEqual(bare.args, cmd.args)
      await client.connect(new StdioClientTransport({ command: bare.command, args: bare.args, stderr: 'pipe' }))
      assert.match((await call('browser_navigate', { url: `http://localhost:${port}/` })).text, /Page Title: Library/)
      const held = await call('browser_navigate', { url: `http://127.0.0.1:${otherPort}/` }); assert.match(held.text, /ERR_ACCESS_DENIED/); assert.doesNotMatch(held.text, /secret/)
      assert.match((await call('browser_navigate', { url: 'https://example.com/' })).text, /ERR_(ACCESS_DENIED|NAME_NOT_RESOLVED)/) // and no other host
    } finally { await client.close(); app.close(); other.close(); fs.rmSync(b, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) }
  })

test('the lockdown Claude Code adds: no built-in tools, only HQ\'s MCP servers, of the browser\'s tools only what a person does, and HQ\'s hooks on each step', () => {
  const f = testerFlags({ model: 'sonnet', mcp: { browser: {}, uitest: {} }, ctrl: 4321 }), at = (k: string) => f[f.indexOf(k) + 1]
  assert.equal(at('--tools'), ''); assert.ok(f.includes('--strict-mcp-config')); assert.equal(at('--model'), 'sonnet')
  assert.deepEqual(Object.keys(JSON.parse(at('--mcp-config')!).mcpServers), ['browser', 'uitest'])
  const allowed = at('--allowedTools')!.split(','); assert.deepEqual(allowed, TESTER_TOOLS)
  assert.ok(allowed.every((t) => t.startsWith('mcp__browser__browser_') || t.startsWith('mcp__uitest__')))
  for (const t of ['evaluate', 'run_code_unsafe', 'file_upload', 'network_requests', 'console_messages', 'tabs']) {
    assert.ok(f.includes(`mcp__browser__browser_${t}`), `${t} refused`); assert.ok(!allowed.includes(`mcp__browser__browser_${t}`))
  }
  for (const t of ['Bash', 'Read', 'Edit', 'Write', 'WebFetch']) assert.ok(!allowed.some((a) => a === t))
  const s = testerSettings(4321) as any
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, /http:\/\/127\.0\.0\.1:4321\/pre$/); assert.equal(s.hooks.PreToolUse[0].matcher, '^mcp__browser__')
  assert.match(s.hooks.PostToolUse[0].hooks[0].command, /\/post$/); assert.match(s.hooks.PostToolUseFailure[0].hooks[0].command, /\/post-failed$/)
  assert.ok(s.hooks.PostToolUse[0].hooks[0].timeout > 30, 'a step\'s record may wait for the app to settle')
})

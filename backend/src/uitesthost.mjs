// The UI tester's host (uitester.ts): runs inside HQ's test sandbox in the run's throwaway checkout of main, for the whole of the tester's run. It starts the
// app as its launch recipe says (appstart.mjs), resets it before each scenario, and answers on a localhost port of its own:
//   POST /start  {id}      a scenario begins: the app is reset to a clean start; answers { ok, url } (from the tester's scenario tools, uitestmcp.mjs)
//   POST /pre    hook JSON a browser tool is about to run (Claude Code's PreToolUse hook): stamped on HQ's clock, and refused past the scenario's budget
//   POST /post   hook JSON it ran (PostToolUse): stamped, with what it answered
//   POST /finish {id, report}  the scenario is over: everything about it is written to <out>/<id>.json
//   POST /close             a session ended: a scenario it left open is written as it stands, with no report (from HQ)
// Reset, until HQ has its own (Part 3: a seed and a reset command per project): the app is stopped, the checkout's files are put back as they were before the
// app first started (a copy taken then, without .git and node_modules), and the app is started again on the same port. Plain Node, no imports from HQ.
// spec: { parts, show, startMs, out, budget: { actions, looks, screenshots }, looks: string[], shots: string[], onElement: string[] }
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startApp } from './appstart.mjs'

const spec = JSON.parse(process.argv[2])
// What a reset never copies or removes, at any depth: installed packages and git. The host's own folder is kept at the top.
const root = process.cwd(), seed = path.join(spec.out, 'seed'), SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']), OWN = path.basename(spec.out)
const say = (o) => { try { fs.writeFileSync(path.join(spec.out, 'host.json'), JSON.stringify(o)) } catch { /* the checkout is gone */ } }
fs.mkdirSync(spec.out, { recursive: true })

/** Every process under `pid`, deepest first: an app's part is often a shell running npm running node, and killing the shell alone leaves the server up. */
function tree(pid) {
  let rows = []
  try { rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)) } catch { /* none */ }
  const out = [], walk = (p) => { for (const [c, pp] of rows) if (pp === p) walk(c); out.push(p) }
  walk(pid); return out
}
let kids = [], port = null
const stopApp = () => { for (const k of kids) for (const p of tree(k.pid)) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } } kids = [] }
const end = () => { stopApp(); process.exit(0) }
process.stdin.on('close', end); for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, end)

const copyOver = (from, to) => {
  for (const name of fs.readdirSync(from)) {
    if (SKIP.has(name) || (from === root && name === OWN)) continue
    fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true, verbatimSymlinks: true, filter: (src) => !SKIP.has(path.basename(src)) })
  }
}
/** Empties `dir` of everything but what a reset skips; a folder that held some of that stays, with only that in it. */
function clear(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name) || (dir === root && name === OWN)) continue
    const p = path.join(dir, name), st = fs.lstatSync(p)
    if (!st.isDirectory()) { fs.rmSync(p, { force: true }); continue }
    clear(p); if (!fs.readdirSync(p).length) fs.rmdirSync(p)
  }
}
/** Puts the checkout back as it was before the app first started. */
function restore() { clear(root); copyOver(seed, root) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Starts the app; after the first time, on the port it had, so the address the tester's browser may reach doesn't change. */
async function start() {
  const parts = port ? spec.parts.map((p) => p.name === spec.show ? { ...p, port } : p) : spec.parts
  for (let i = 0; port && i < 50; i++) { try { execFileSync('/usr/sbin/lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']) } catch { break } await sleep(100) }
  const app = await startApp({ ...spec, parts }); kids = app.kids
  if (!app.port) { stopApp(); return app.kind === 'skipped' ? app.why : `the app didn't start: ${app.why}` }
  port = app.port; return null
}

// --- What happened, on one clock ------------------------------------------------------------------------------------------------------------------------
let cur = null // the scenario under way: { id, began, log: [], used: { actions, looks, screenshots }, pending: Map(tool_use_id → entry) }
const short = (t) => t.replace(/^mcp__[^_]+__browser_/, '')
const costOf = (tool) => spec.shots.includes(tool) ? 'screenshots' : spec.looks.includes(tool) ? 'looks' : 'actions'
const text = (resp) => (Array.isArray(resp) ? resp : resp?.content ?? [resp]).map((c) => typeof c === 'string' ? c : c?.type === 'text' ? c.text : '').join('\n')
const deny = (why) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } })
function pre(h) {
  if (!cur) return deny('Call start_scenario first: HQ resets the app before each scenario.')
  const tool = short(h.tool_name ?? ''), kind = costOf(tool)
  if (cur.used[kind] >= spec.budget[kind]) return deny(`This scenario's ${kind} are used up (${spec.budget[kind]}). Call finish_scenario now with what you found.`)
  // An element is named by a ref from the last look at this page; a ref from before a reset or a new page names nothing, and the step is wasted (spike: ten
  // in a row). So a step on an element waits for a look at the page as it is now.
  if (spec.onElement.includes(tool) && !cur.looked) return deny('Look at the page first (browser_snapshot): refs from an earlier page or scenario name nothing here.')
  cur.used[kind]++
  cur.pending.set(h.tool_use_id, { at: Date.now(), tool, input: h.tool_input ?? {} }); return {}
}
function post(h, failed) {
  if (!cur) return {}
  const e = cur.pending.get(h.tool_use_id) ?? { at: Date.now(), tool: short(h.tool_name ?? ''), input: h.tool_input ?? {} }; cur.pending.delete(h.tool_use_id)
  const answer = failed ? String(h.error ?? 'failed') : text(h.tool_response)
  const ok = !failed && !/^### Error/m.test(answer)
  if (spec.looks.includes(e.tool) && e.tool === 'snapshot' && ok) cur.looked = true
  if (['navigate', 'navigate_back'].includes(e.tool)) cur.looked = false
  cur.log.push({ ...e, ms: Date.now() - e.at, ok, answer: answer.slice(0, 12_000) }); return {}
}
const write = (id, o) => fs.writeFileSync(path.join(spec.out, `${id}.json`), JSON.stringify(o))

const body = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch { resolve({}) } }) })
let busy = Promise.resolve()
const server = http.createServer(async (req, res) => {
  const b = await body(req), answer = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)) }
  if (req.url === '/pre') return answer(pre(b))
  if (req.url === '/post') return answer(post(b, false))
  if (req.url === '/post-failed') return answer(post(b, true))
  if (req.url === '/finish') {
    if (!cur || cur.id !== b.id) return answer({ ok: false, why: cur ? `The scenario under way is ${cur.id}.` : 'No scenario is under way.' })
    write(cur.id, { id: cur.id, began: cur.began, ended: Date.now(), log: cur.log, used: cur.used, report: b.report ?? null }); cur = null
    return answer({ ok: true })
  }
  if (req.url === '/close') { // a session ended: a scenario it left open is written as it stands (no report), so the next session starts clean
    if (cur) { write(cur.id, { id: cur.id, began: cur.began, ended: Date.now(), log: cur.log, used: cur.used, report: null }); cur = null }
    return answer({ ok: true })
  }
  if (req.url === '/start') { // one reset at a time; a scenario left open is written as it stands
    busy = busy.then(async () => {
      if (cur && cur.id !== String(b.id ?? '')) return answer({ ok: false, why: `${cur.id} isn't finished: call finish_scenario for it first` })
      if (cur) { write(cur.id, { id: cur.id, began: cur.began, ended: Date.now(), log: cur.log, used: cur.used, report: null }); cur = null } // started again
      stopApp(); restore(); const down = await start()
      if (down) return answer({ ok: false, why: down })
      cur = { id: String(b.id ?? ''), began: Date.now(), log: [], used: { actions: 0, looks: 0, screenshots: 0 }, pending: new Map(), looked: false }
      answer({ ok: true, url: `http://localhost:${port}/` })
    }); return
  }
  res.statusCode = 404; res.end('{}')
})

fs.rmSync(seed, { recursive: true, force: true }); fs.mkdirSync(seed, { recursive: true }); copyOver(root, seed)
const down = await start()
if (down) { say({ started: false, why: down }); stopApp(); process.exit(0) }
server.listen(0, '127.0.0.1', () => say({ started: true, ctrl: server.address().port, port }))

// The UI tester's host (uitester.ts): runs inside HQ's test sandbox in the run's throwaway checkout of main, for the whole of the tester's run. It starts the
// app as its launch recipe says (appstart.mjs), resets it before each scenario, and answers on a localhost port of its own:
//   POST /start  {id}      a scenario begins: the app is reset to a clean start; answers { ok, url } (from the tester's scenario tools, uitestmcp.mjs)
//   POST /pre    hook JSON a browser tool is about to run (Claude Code's PreToolUse hook): stamped on HQ's clock, and refused past the scenario's budget
//   POST /post   hook JSON it ran (PostToolUse): stamped, with what it answered
//   POST /finish {id, report}  the scenario is over: everything about it is written to <out>/<id>.json
//   POST /close             a session ended: a scenario it left open is written as it stands, with no report (from HQ)
//   POST /cant   {id, why}  the scenario can't begin: the tester's browser couldn't be closed for it (uitestmcp.mjs, Bug 453); kept as a reset that failed
// With the project's test setup (spec.record), the app runs under HQ's recorder (recorder.mjs), as a scripted scenario's does: its production start on a clean
// seed, behind the recorder's proxy, whose address is the one the tester's browser is given. Each scenario gets a folder of its own (<out>/rec/<id>): every
// API call, the server's output, and the stored data after each action, for the backend checker to read afterwards. A reset is the recorder's.
// With no test setup, or one the recorder can't start the app on (host.json says why, `unrecorded`), nothing is recorded and the reset is a plain one: the
// app is stopped, the checkout's files are put back as they were before the app first started (a copy taken then, without .git and node_modules), and the
// app is started again on the same port. Each part runs in a process group of its own (appstart.mjs), which a stop ends whole: `npm start` and any other
// start that forks would otherwise keep its port (Bug 170). A reset that fails is written to <out>/reset-failed.json for HQ, as the reason the scenarios
// after it weren't run. Plain Node, no imports from HQ.
// spec: { parts, show, startMs, out, budget: { actions, looks, screenshots }, looks: string[], shots: string[], onElement: string[],
//         record?: { root, parts, snapshot, seed } (recorder.mjs's spec, without `out`) }
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { startApp, stopApp as stopParts } from './appstart.mjs'
import { startRecording } from './recorder.mjs'

const spec = JSON.parse(process.argv[2])
// What a reset never copies or removes, at any depth: installed packages and git. The host's own folder is kept at the top.
const root = process.cwd(), seed = path.join(spec.out, 'seed'), SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']), OWN = path.basename(spec.out)
const say = (o) => { try { fs.writeFileSync(path.join(spec.out, 'host.json'), JSON.stringify(o)) } catch { /* the checkout is gone */ } }
fs.mkdirSync(spec.out, { recursive: true })

let kids = [], ports = [], port = null
let rec = null // the recorder, when the app runs under it
const REC = path.join(spec.out, 'rec'), recDir = (id) => path.join(REC, id.replace(/[^\w.-]/g, '_'))
/** Stops the app's parts, each with everything it started, and waits (a little) until their ports are free. */
const stopApp = (graceMs) => { const k = kids; kids = []; return stopParts(k, ports, graceMs) }
let ending = false
const end = async () => { if (ending) return; ending = true; if (rec) await rec.stop().catch(() => {}); await stopApp(0); process.exit(0) }
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
/** Starts the app; after the first time, on the port it had, so the address the tester's browser may reach doesn't change. */
async function start() {
  const parts = port ? spec.parts.map((p) => p.name === spec.show ? { ...p, port } : p) : spec.parts
  const app = await startApp({ ...spec, parts }, { group: true }); kids = app.kids; ports = Object.values(app.ports ?? {})
  if (!app.port) { await stopApp(0); return app.kind === 'skipped' ? app.why : `the app didn't start: ${app.why}` }
  port = app.port; return null
}

// --- What happened, on one clock ------------------------------------------------------------------------------------------------------------------------
let cur = null // the scenario under way: { id, began, log: [], used: { actions, looks, screenshots }, pending: Map(tool_use_id → entry) }
const short = (t) => t.replace(/^mcp__[^_]+__browser_/, '')
const costOf = (tool) => spec.shots.includes(tool) ? 'screenshots' : spec.looks.includes(tool) ? 'looks' : 'actions'
const text = (resp) => (Array.isArray(resp) ? resp : resp?.content ?? [resp]).map((c) => typeof c === 'string' ? c : c?.type === 'text' ? c.text : '').join('\n')
const deny = (why) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } })
/** A browser step in a few words, for the recording's timeline, from what the tester asked the browser for. HQ puts what the browser really ran in its
 *  place once the session is over (uitester.ts keepRecording); these words stay for a step that couldn't be done. */
function words(tool, input) {
  // The element: the tester's own words for it, else what it named it by when that isn't a bare ref from its last look ("e12", "f3e101")
  const named = [input.element, input.target].find((v) => typeof v === 'string' && v && !/^(f\d+)?e\d+$/.test(v))
  const el = named ? named.slice(0, 80) : 'an element', cut = (v) => String(v ?? '').slice(0, 60)
  if (tool === 'navigate') { try { const u = new URL(input.url); return `open ${u.pathname}${u.search}` } catch { return `open ${cut(input.url)}` } }
  if (tool === 'navigate_back') return 'go back'
  if (tool === 'type') return `type "${cut(input.text)}" into ${el}${input.submit ? ' and press Enter' : ''}`
  if (tool === 'press_key') return `press ${cut(input.key)}`
  if (tool === 'select_option') return `choose "${cut([].concat(input.values ?? []).join(', '))}" in ${el}`
  if (tool === 'fill_form') return `fill in ${(Array.isArray(input.fields) ? input.fields : []).map((f) => cut(f?.name)).filter(Boolean).join(', ') || 'a form'}`
  if (tool === 'handle_dialog') return `${input.accept ? 'accept' : 'dismiss'} the dialog`
  return `${tool} ${el}`
}
function pre(h) {
  if (!cur) return deny('Call start_scenario first: HQ resets the app before each scenario.')
  const tool = short(h.tool_name ?? ''), kind = costOf(tool)
  if (cur.used[kind] >= spec.budget[kind]) return deny(`This scenario's ${kind} are used up (${spec.budget[kind]}). Call finish_scenario now with what you found.`)
  // An element is named by a ref from the last look at this page; a ref from before a reset or a new page names nothing, and the step is wasted (spike: ten
  // in a row). So a step on an element waits for a look at the page as it is now.
  if (spec.onElement.includes(tool) && !cur.looked) return deny('Look at the page first (browser_snapshot): refs from an earlier page or scenario name nothing here.')
  cur.used[kind]++
  const e = { at: Date.now(), tool, input: h.tool_input ?? {} }
  // Recorded: an action (not a look) is stamped as it starts, so the API calls that follow are its own
  if (rec && kind === 'actions') { e.label = words(tool, e.input); e.action = rec.mark(e.label, 'start') }
  cur.pending.set(h.tool_use_id, e); return {}
}
async function post(h, failed) {
  const mine = cur; if (!mine) return {}
  const e = mine.pending.get(h.tool_use_id) ?? { at: Date.now(), tool: short(h.tool_name ?? ''), input: h.tool_input ?? {} }; mine.pending.delete(h.tool_use_id)
  const answer = failed ? String(h.error ?? 'failed') : text(h.tool_response), ms = Date.now() - e.at
  const ok = !failed && !/^### Error/m.test(answer)
  if (rec && e.label) { // once the app has gone quiet, what it stored is copied, and the action's end is stamped
    await rec.settleAndSnapshot(e.label)
    if (cur !== mine) return {} // the session ended meanwhile, and HQ closed the scenario as it stood
    rec.mark(e.label, 'end', ok ? { ok: true } : { ok: false, why: answer.replace(/^### Error\s*/m, '').split('\n')[0].slice(0, 300) })
  }
  // The browser tools keep the page's console in a file of their own and say which lines are new: HQ reads them once the session is over (uitester.ts)
  const said = rec ? /New console entries: (\S+?)#L(\d+)(?:-L(\d+))?/.exec(answer) : null
  if (said) { try { fs.appendFileSync(path.join(recDir(mine.id), 'console-refs.jsonl'), `${JSON.stringify({ at: Date.now(), file: path.basename(said[1]), from: Number(said[2]),
    to: Number(said[3] ?? said[2]), action: e.action ?? null })}\n`) } catch { /* the checkout is gone */ } }
  if (spec.looks.includes(e.tool) && e.tool === 'snapshot' && ok) mine.looked = true
  if (['navigate', 'navigate_back'].includes(e.tool)) mine.looked = false
  mine.log.push({ ...e, ms, ok, answer: answer.slice(0, 12_000) }); return {}
}
/** A scenario is over: what the host has of it is written, and nothing later lands in its recording. */
const write = (id, o) => { fs.writeFileSync(path.join(spec.out, `${id}.json`), JSON.stringify({ ...o, recorded: !!rec })); if (rec) rec.cut(REC) }
/** A reset that failed: the tester is told to stop, and HQ reads why from here once its session is over (uitester.ts), so the summary can say it. */
const resetFailed = (id, why) => { fs.writeFileSync(path.join(spec.out, 'reset-failed.json'), JSON.stringify({ id, why })); return { ok: false, why } }

const body = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch { resolve({}) } }) })
let busy = Promise.resolve()
const server = http.createServer(async (req, res) => {
  const b = await body(req), answer = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)) }
  if (req.url === '/pre') return answer(pre(b))
  if (req.url === '/post') return answer(await post(b, false))
  if (req.url === '/post-failed') return answer(await post(b, true))
  if (req.url === '/finish') {
    if (!cur || cur.id !== b.id) return answer({ ok: false, why: cur ? `The scenario under way is ${cur.id}.` : 'No scenario is under way.' })
    write(cur.id, { id: cur.id, began: cur.began, ended: Date.now(), log: cur.log, used: cur.used, report: b.report ?? null }); cur = null
    return answer({ ok: true })
  }
  if (req.url === '/close') { // a session ended: a scenario it left open is written as it stands (no report), so the next session starts clean
    if (cur) { write(cur.id, { id: cur.id, began: cur.began, ended: Date.now(), log: cur.log, used: cur.used, report: null }); cur = null }
    return answer({ ok: true })
  }
  if (req.url === '/cant') return answer(resetFailed(String(b.id ?? ''), String(b.why ?? 'no reason given').slice(0, 300)))
  if (req.url === '/start') { // one reset at a time; a scenario left open is written as it stands
    busy = busy.then(async () => {
      if (cur && cur.id !== String(b.id ?? '')) return answer({ ok: false, why: `${cur.id} isn't finished: call finish_scenario for it first` })
      if (cur) { write(cur.id, { id: cur.id, began: cur.began, ended: Date.now(), log: cur.log, used: cur.used, report: null }); cur = null } // started again
      const id = String(b.id ?? '')
      if (rec) { // its own folder, begun empty (a scenario started again starts over), then the app back on its seed
        fs.rmSync(recDir(id), { recursive: true, force: true }); rec.cut(recDir(id))
        try { await rec.reset() } catch (e) { rec.cut(REC); return answer(resetFailed(id, String(e.message ?? e).slice(0, 300))) }
      } else {
        await stopApp(); restore(); const down = await start()
        if (down) return answer(resetFailed(id, down))
      }
      cur = { id, began: Date.now(), log: [], used: { actions: 0, looks: 0, screenshots: 0 }, pending: new Map(), looked: false }
      answer({ ok: true, url: `http://localhost:${port}/` })
    }); return
  }
  res.statusCode = 404; res.end('{}')
})

fs.rmSync(seed, { recursive: true, force: true }); fs.mkdirSync(seed, { recursive: true }); copyOver(root, seed)
let unrecorded = null
if (spec.record) {
  const r = await startRecording({ ...spec.record, show: spec.show, startMs: spec.startMs, out: REC })
  if (r.rec) { rec = r.rec; port = Number(new URL(rec.url).port) }
  // The test setup doesn't start this app (any more): the tester still uses it, on a plain start, and the checker is told why it has nothing to read
  else { unrecorded = `${r.why}${r.output ? `: ${String(r.output).trim().split('\n').at(-1).slice(0, 200)}` : ''}`; restore() }
}
if (!rec) { const down = await start(); if (down) { say({ started: false, why: down }); stopApp(); process.exit(0) } }
server.listen(0, '127.0.0.1', () => say({ started: true, ctrl: server.address().port, port, recorded: !!rec, ...(unrecorded ? { unrecorded } : {}) }))

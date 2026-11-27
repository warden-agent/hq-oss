// The UI tester's browser relay (uitester.ts browserServer; Bug 453). Claude Code starts this as the tester's `browser` MCP server, inside the browser's
// sandbox; it starts the real one (Playwright MCP) and passes every line on, both ways, as it is. One thing it does itself: when HQ's scenario tools ask
// (uitestmcp.mjs, at start_scenario), it sends Playwright MCP `browser_close` and keeps the answer. The tester's next step then opens a new browser, whose
// profile is in memory only (`--isolated`), so a scenario starts with nothing an earlier one left: no localStorage, sessionStorage, cookies or IndexedDB.
// The host resets the app's files before each scenario; the browser used to stay open for a whole session of five, and remembered. The tester is never
// asked to close anything and never sees it happen, so it costs no tokens and no step of a scenario's budget (the hooks only see the tester's own calls).
// Spike 2026-11-27 (Playwright MCP 0.0.84, Claude Code 2.1.322): the close takes about 25 ms and the next page about 190 ms; a page that had stored a value
// in all four places found none after it, an HttpOnly cookie included; the console file the next answer names is a new one, in the same folder.
// The asking goes over a unix socket in the browser's own folder, the only place its sandbox lets it write: one connection, any bytes, one line back
// ("ok", or "failed <why>"). With no browser open (a session's first scenario, or two asks in a row) there is nothing to close, and it says ok at once.
// Plain Node, no imports from HQ. Its arguments: the socket's path, then the command to run with its own arguments.
import { spawn } from 'node:child_process'
import net from 'node:net'
import readline from 'node:readline'

const [ask, command, ...args] = process.argv.slice(2)
const CLOSE_MS = Number(process.env.HQ_UITEST_CLOSE_MS) || 15_000
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })
child.on('error', (e) => { process.stderr.write(`hq browser relay: ${command} wouldn't start (${e.message})\n`); process.exit(1) })
child.on('exit', (code) => process.exit(code ?? 0)) // it ends when Claude Code closes its input, and this with it
child.stdin.on('error', () => {}) // it went first: `exit` says so
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig) } catch { /* gone */ } })

let open = false // has the tester used the browser since the last close?
let closing = false, n = 0
const held = [] // what Claude Code sent while a close was under way: passed on after it, so a step never lands in the browser that is going
const mine = new Map() // this relay's own calls, by id: the answers that stay here

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (l) => {
  if (l.includes('"tools/call"')) open = true
  if (closing) held.push(l); else child.stdin.write(`${l}\n`)
}).on('close', () => { try { child.stdin.end() } catch { /* gone */ } })
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => {
  if (mine.size && l.includes('"hq-fresh-')) {
    let m = null; try { m = JSON.parse(l) } catch { /* not one message: passed on */ }
    const got = m && mine.get(m.id); if (got) { mine.delete(m.id); got(m); return }
  }
  process.stdout.write(`${l}\n`)
})

/** Closes the browser, if the tester has one open. The answer is HQ's, for its scenario tools. */
async function fresh() {
  if (!open) return 'ok'
  const id = `hq-fresh-${++n}`; let timer
  closing = true
  try {
    const answer = new Promise((resolve) => mine.set(id, resolve))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'browser_close', arguments: {} } })}\n`)
    const m = await Promise.race([answer, new Promise((resolve) => { timer = setTimeout(() => resolve(null), CLOSE_MS) })])
    if (!m) return `failed the browser didn't close within ${Math.round(CLOSE_MS / 1000)} s`
    const said = m.error?.message ?? (m.result?.isError ? (m.result.content ?? []).map((c) => c?.text ?? '').join(' ') : '')
    if (m.error || m.result?.isError) return `failed ${String(said).replace(/^### Error\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'the browser tools refused to close it'}`
    open = false; return 'ok'
  } finally {
    clearTimeout(timer); mine.delete(id); closing = false
    for (const l of held.splice(0)) child.stdin.write(`${l}\n`)
  }
}
let last = Promise.resolve() // one ask at a time
const server = net.createServer((c) => {
  c.on('error', () => {})
  c.once('data', () => { last = last.then(fresh).then((a) => c.end(`${a}\n`), (e) => c.end(`failed ${String(e?.message ?? e).slice(0, 200)}\n`)) })
})
// No socket (its folder is gone, the path is taken): the browser still works, and the scenario tools find nobody to ask, which HQ's summary then says
server.on('error', (e) => process.stderr.write(`hq browser relay: can't listen on ${ask} (${e.message})\n`))
server.listen(ask)

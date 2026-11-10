// HQ's tools relay (Bug 78). Each agent's Claude Code starts this as its "hq" MCP server and talks to it over stdin/stdout; it
// passes every message on to the backend's HTTP MCP server and the answer back. Agents used to connect to the backend
// directly. When the backend was down for more than about 15 s, Claude Code (2.1.300) tried to reconnect five times, gave
// up, and the agent had no HQ tools for the rest of its session, with nothing said; an engineer can't even run /mcp. Claude
// Code never drops a server it started itself for as long as that runs, so this one just keeps running. A call made while
// the backend is down waits for it, however long, and goes through when it's back. A progress note every 30 s holds off
// Claude Code's idle limit, 30 minutes for a server like this one (spike 2026-11-09 with the limit set to 90 s: a call with
// notes was still waiting at 259 s, one without was dropped at 90 s, and the relay stayed connected either way). After two
// minutes Claude Code itself moves a waiting call to the background and lets the agent go on; the answer still arrives, and
// wakes the agent. One case can't simply be sent again: a tool call the backend had received when it went down. HQ can't
// tell whether it went through, so the agent is told to check first.
// Plain Node with no imports from HQ: it runs with the backend's node, as a child of the agent's Claude Code.
import fs from 'node:fs'
import http from 'node:http'
import readline from 'node:readline'

const url = new URL(process.env.HQ_MCP_URL ?? 'http://127.0.0.1:4782/mcp')
const tokenFile = process.env.HQ_TOKEN_FILE ?? ''
const RETRY_MS = Number(process.env.HQ_RELAY_RETRY_MS ?? 1000), PROGRESS_MS = Number(process.env.HQ_RELAY_PROGRESS_MS ?? 30_000)
/** Asking twice changes nothing, so these are sent again even when the backend went down halfway through one. */
const REPEATABLE = new Set(['initialize', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'])
const LOST = 'HQ restarted while it was handling this call, so it may or may not have gone through. Check first (get_ticket, list_tickets '
  + 'or read_inbox show how things stand now), and call it again only if it didn\'t.'
const ENDED = 'HQ has ended this session\'s access to its tools (the session was stopped or replaced). Stop here.'

const log = (s) => { try { process.stderr.write(`hq relay: ${s}\n`) } catch { /* nobody is reading */ } }
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const rpcError = (id, message) => ({ jsonrpc: '2.0', id, error: { code: -32000, message } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : [v] } catch { return [] } }

// The token is read from its file, never passed in the environment (`ps` shows that to every program of this user), and
// kept: HQ deletes the file when it ends the session, and from then on the backend answers 401.
let token = ''
const bearer = () => { if (!token) try { token = fs.readFileSync(tokenFile, 'utf8').trim() } catch { /* 401 says it */ } return token }
let protocol = '' // the version agreed at initialize, sent with every later message as an HTTP client would

/** One POST of one message. `refused`: nothing was listening, so the backend never saw it. `lost`: it got there, and the
 *  answer never came back whole. Otherwise the status and the messages the backend sent back (plain JSON, or one per event). */
function post(msg, waited = 0, started = () => {}) {
  return new Promise((resolve) => {
    let reached = false
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer()}`,
      ...(protocol ? { 'mcp-protocol-version': protocol } : {}), ...(waited ? { 'x-hq-waited-ms': String(waited) } : {}) }
    // A connection of its own: on a kept one, a backend that has just gone can't be told from one that took the message and died
    const req = http.request(url, { method: 'POST', agent: false, headers }, (res) => {
      const chunks = []; let whole = false
      res.on('data', (c) => chunks.push(c)); res.on('error', () => {})
      res.on('end', () => {
        whole = true
        const text = Buffer.concat(chunks).toString('utf8'), type = String(res.headers['content-type'] ?? '')
        const events = () => text.split(/\r?\n\r?\n/).map((e) => e.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n'))
        const messages = (type.includes('text/event-stream') ? events().flatMap(json) : json(text)).filter((x) => x && typeof x === 'object')
        resolve({ status: res.statusCode ?? 0, messages })
      })
      res.on('close', () => { if (!whole) resolve({ lost: true }) })
    })
    req.on('socket', (s) => { if (s.connecting) s.once('connect', () => { reached = true }); else reached = true })
    req.on('error', () => resolve(reached ? { lost: true } : { refused: true }))
    started(req); req.end(JSON.stringify(msg))
  })
}

const calls = new Map() // requests under way, by id: Claude Code may cancel one (Escape)
let downSince = 0

/** A request from Claude Code: exactly one answer goes back, however long the backend is away. */
async function relay(m) {
  const call = { cancelled: false, req: null }; calls.set(m.id, call)
  const began = Date.now(), progressToken = m.params?._meta?.progressToken
  let noted = began, notes = 0, waited = 0
  try {
    for (;;) {
      const r = await post(m, waited, (req) => { call.req = req })
      if (call.cancelled) return
      if (r.refused || (r.lost && REPEATABLE.has(m.method))) {
        if (!downSince) { downSince = Date.now(); log('the backend isn\'t answering; holding calls until it does') }
        if (progressToken !== undefined && Date.now() - noted >= PROGRESS_MS) {
          noted = Date.now()
          const message = `Waiting for HQ to come back (${Math.round((noted - began) / 1000)} s so far)`
          out({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: ++notes, message } })
        }
        await sleep(RETRY_MS); if (call.cancelled) return
        waited = Date.now() - began; continue
      }
      if (downSince) { log(`the backend is back after ${Math.round((Date.now() - downSince) / 1000)} s`); downSince = 0 }
      // a tool's own error, so the agent reads the words rather than a protocol failure
      if (r.lost) return void out(m.method === 'tools/call' ? { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: LOST }], isError: true } } : rpcError(m.id, LOST))
      const ok = r.status >= 200 && r.status < 300, mine = (x) => x.id === m.id && ('result' in x || 'error' in x)
      if (!ok || !r.messages.some(mine)) {
        const said = r.messages.map((x) => x.error?.message ?? x.error).find((s) => typeof s === 'string')
        return void out(rpcError(m.id, r.status === 401 ? ENDED : `HQ answered ${r.status}${said ? `: ${said}` : ' with no result'}.`))
      }
      for (const x of r.messages) if (x.jsonrpc === '2.0') {
        if (m.method === 'initialize' && mine(x) && typeof x.result?.protocolVersion === 'string') protocol = x.result.protocolVersion
        out(x)
      }
      return
    }
  } finally { calls.delete(m.id) }
}

function take(m) {
  if (!m || typeof m !== 'object') return
  const request = typeof m.method === 'string' && m.id !== undefined && m.id !== null
  if (request && m.method === 'ping') return void out({ jsonrpc: '2.0', id: m.id, result: {} }) // "are you there?" is asked of this relay, and it is
  if (request) return void relay(m).catch((e) => { log(`${m.method} failed: ${e}`); out(rpcError(m.id, `HQ's tools relay hit an error: ${String(e).slice(0, 200)}`)) })
  if (m.method === 'notifications/cancelled') { const c = calls.get(m.params?.requestId); if (c) { c.cancelled = true; c.req?.destroy() } return }
  void post(m) // other notes: passed on once. The backend keeps nothing between messages, so one that misses it changes nothing.
}

// It ends only with its Claude Code: stdin closes when that exits (a stopped session's hang-up and Claude Code's own signals end it too).
process.on('uncaughtException', (e) => log(`error: ${e?.stack ?? e}`))
process.on('unhandledRejection', (e) => log(`error: ${e}`))
for (const s of [process.stdout, process.stdin]) s.on('error', () => process.exit(0)) // nobody is on the other end any more
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (l) => { if (l.trim()) for (const m of json(l)) take(m) })
lines.on('close', () => process.exit(0))

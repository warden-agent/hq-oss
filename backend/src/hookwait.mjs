// Bug 85: the PermissionRequest hook, run by each agent's Claude Code as a command. It passes the hook's JSON to HQ and prints
// HQ's answer. Claude Code used to call HQ itself (an http hook set to block when HQ can't be reached): while the backend was
// down for a restart, every step that needed HQ's OK was refused ("Denied by PermissionRequest hook"), the agent took that as
// a fault, gave up, and nothing told it when HQ was back. Here a request waits for HQ instead: nothing listening, or the
// connection dropped before a whole answer came, means try again in a second, until the time limit. Sending one again is
// safe: HQ's answer to a permission request doesn't change by asking twice, and a plan sent again re-attaches to its review
// (gate.ts). If HQ is still away at the limit, the agent is told to stop and wait, and a note is left in its folder: the
// backend sees it when it's back (agents.ts) and tells the agent to carry on, so the wait has something that ends it.
// Plain Node with no imports from HQ: it runs with the backend's node, as a child of the agent's Claude Code.
// Usage: node hookwait.mjs <hooks URL, without the token> <token file> <time limit in seconds>
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const [base = '', tokenFile = '', limitArg = '600'] = process.argv.slice(2)
const RETRY_MS = Number(process.env.HQ_HOOKWAIT_RETRY_MS ?? 1000)
const deadline = Date.now() + Number(limitArg) * 1000
/** Left in the agent's folder when it was told to wait for HQ; the backend reads it on start and on the agent's next hook (delivery.ts HQ_AWAY_MARK). */
const MARK = 'hq-unreachable'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const deny = (message) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } })
const answer = (s) => new Promise((r) => process.stdout.write(s, () => r(undefined)))
const minutes = () => Math.max(1, Math.round(Number(limitArg) / 60))
const ENDED = 'HQ has ended this session\'s access (the session was stopped or replaced). Stop here.'

function readStdin() {
  return new Promise((resolve) => { const chunks = []; process.stdin.on('data', (c) => chunks.push(c)); process.stdin.on('end', () => resolve(Buffer.concat(chunks))) })
}

/** One POST. `away`: nothing answered (not listening, or the connection broke before the whole answer). Otherwise the status
 *  and body. Its own connection each time, cut at the deadline. The token goes in the X-HQ-Token header (Bug 87), so no error
 *  can show it; `inPath` sends it the old way, `/hooks/<token>`, to a backend from before that change. */
function post(body, token, inPath) {
  return new Promise((resolve) => {
    const left = deadline - Date.now(), url = base.replace(/\/$/, '') + (inPath ? `/${token}` : '')
    const headers = { 'content-type': 'application/json', ...(inPath ? {} : { 'x-hq-token': token }) }
    const req = http.request(url, { method: 'POST', agent: false, headers }, (res) => {
      const chunks = []; let whole = false
      res.on('data', (c) => chunks.push(c)); res.on('error', () => {})
      res.on('end', () => { whole = true; resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }) })
      res.on('close', () => { if (!whole) resolve({ away: true }) })
    })
    const timer = setTimeout(() => { req.destroy() }, Math.max(1, left))
    req.on('error', () => resolve({ away: true })); req.on('close', () => clearTimeout(timer))
    req.end(body)
  })
}

const body = await readStdin()
let token = ''
try { token = fs.readFileSync(tokenFile, 'utf8').trim() } catch { /* deleted: HQ ended the session */ }
if (!token) { await answer(deny(ENDED)); process.exit(0) }
for (;;) {
  let r = await post(body, token, false)
  if (!r.away && r.status === 404) r = await post(body, token, true) // a backend that doesn't read the header yet
  if (!r.away && r.status >= 200 && r.status < 300) { await answer(r.text); process.exit(0) }
  if (!r.away && (r.status === 401 || r.status === 403)) { await answer(deny(ENDED)); process.exit(0) }
  if (!r.away && r.status !== 502 && r.status !== 503 && r.status !== 504) {
    await answer(deny(`HQ couldn't answer this request (HTTP ${r.status}). Try once more; if it happens again, report_blocked.`)); process.exit(0)
  }
  if (Date.now() + RETRY_MS >= deadline) break
  await sleep(RETRY_MS)
}
try { fs.writeFileSync(path.join(path.dirname(tokenFile), MARK), String(Date.now())) } catch { /* the folder is gone too */ }
await answer(deny(`HQ (the control room) has been unreachable for ${minutes()} min, probably restarting, so this step can't get its OK. It isn't a `
  + 'fault in your work and it isn\'t a "no". Don\'t retry and don\'t report it: end your turn now. HQ sends you a message when it\'s back; then carry on '
  + 'from here and run this step again.'))
process.exit(0)

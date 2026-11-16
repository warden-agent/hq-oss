// Bug 112: the PreToolUse hook for an engineer's (and the Launch helper's) Bash commands, run by its Claude Code as a command. It passes the hook's JSON to HQ and
// prints HQ's answer, and HQ holds a build or a full test run there until its turn comes (Bug 76, heavy.ts). Claude Code used to call HQ itself (an http hook):
// with the backend down for a restart that call failed at once, a failed hook counts as no answer, and every build and test run began straight away, all at
// the same moment. A command HQ was holding in its line began too, when the restart cut its connection.
// Here "HQ is away" (nothing listening, or the connection dropped before a whole answer came) means: a build or full test run asks again every second until HQ
// answers, and then waits its turn there as always. Any other command goes ahead at once, as before. Asking twice is safe: HQ counts a command by its id.
// Nothing waits for good: after <away limit> seconds of asking with no HQ, or <total limit> seconds in all, the command goes ahead anyway.
// Which commands are heavy: heavykind.ts, the rules HQ itself goes by, with the project's own test command from the file HQ keeps for this (heavy.ts
// saveTestCmds). Both are read only once HQ doesn't answer, so a command with HQ up costs one request.
// Plain Node: it runs with the backend's node, as a child of the agent's Claude Code. The token goes in the X-HQ-Token header, never in the URL (Bug 87).
// Usage: node turnwait.mjs <hooks URL> <token file> <away limit s> <total limit s> <test commands file> <repo id>
import fs from 'node:fs'
import http from 'node:http'

const [base = '', tokenFile = '', awayArg = '600', totalArg = '1845', cmdsFile = '', repoId = ''] = process.argv.slice(2)
const RETRY_MS = Number(process.env.HQ_HOOKWAIT_RETRY_MS ?? 1000)
const deadline = Date.now() + Number(totalArg) * 1000, awayLimitMs = Number(awayArg) * 1000
/** No decision: Claude Code starts the command. Also what a hook that failed used to mean. */
const GO = '{}'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const answer = (s) => new Promise((r) => process.stdout.write(s, () => r(undefined)))
const go = async (text = GO) => { await answer(text); process.exit(0) }

function readStdin() {
  return new Promise((resolve) => { const chunks = []; process.stdin.on('data', (c) => chunks.push(c)); process.stdin.on('end', () => resolve(Buffer.concat(chunks))) })
}
/** One POST. `away`: nothing answered (not listening, or the connection broke before the whole answer). Otherwise the status and body. Its own connection
 *  each time, cut at the total limit: HQ then sees the hook dropped and gives its place in the line away. */
function post(body, token) {
  return new Promise((resolve) => {
    const req = http.request(base, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'x-hq-token': token } }, (res) => {
      const chunks = []; let whole = false
      res.on('data', (c) => chunks.push(c)); res.on('error', () => {})
      res.on('end', () => { whole = true; resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }) })
      res.on('close', () => { if (!whole) resolve({ away: true }) })
    })
    const timer = setTimeout(() => { req.destroy() }, Math.max(1, deadline - Date.now()))
    req.on('error', () => resolve({ away: true })); req.on('close', () => clearTimeout(timer))
    req.end(body)
  })
}
/** The project's test command as HQ last saved it; null when there's none, or no file to read. */
function testCmd() {
  try { const c = JSON.parse(fs.readFileSync(cmdsFile, 'utf8'))[repoId]; return typeof c === 'string' ? c : null } catch { return null }
}
/** Would HQ hold this command for a turn? Anything that can't be read or worked out counts as no: the command goes ahead, as it did before this script. */
async function heavy(body) {
  try {
    const hook = JSON.parse(body.toString('utf8')), input = hook.tool_input ?? {}
    const { heldKind } = await import('./heavykind.ts')
    return !!heldKind({ command: String(input.command ?? ''), background: input.run_in_background === true, plan: hook.permission_mode === 'plan' }, testCmd())
  } catch { return false }
}

const body = await readStdin()
let token = ''
try { token = fs.readFileSync(tokenFile, 'utf8').trim() } catch { /* deleted: HQ ended the session */ }
if (!token) await go()
let waits, awayMs = 0
for (;;) {
  const r = await post(body, token)
  if (!r.away && r.status >= 200 && r.status < 300) await go(r.text.trim() ? r.text : GO)
  if (!r.away && r.status !== 502 && r.status !== 503 && r.status !== 504) await go() // HQ is there and said no to the request itself (a token it ended, an error)
  waits ??= await heavy(body)
  if (!waits || awayMs + RETRY_MS > awayLimitMs || Date.now() + RETRY_MS >= deadline) await go()
  await sleep(RETRY_MS); awayMs += RETRY_MS
}

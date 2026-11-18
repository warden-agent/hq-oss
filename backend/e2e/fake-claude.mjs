#!/usr/bin/env node
// Stand-in for the Claude Code binary in HQ's e2e tests (HQ_CLAUDE_BIN): no model, no tokens. It reports SessionStart to HQ
// the way Claude Code's command hook does, locks its --worktree the way Claude Code does, then idles until killed. A killed
// Claude Code leaves that lock behind, and so does this. The tests act as the agent themselves, with its token.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const args = process.argv.slice(2)
// `--version`, as HQ asks it at start and before each launch (Bug 97): the harness says which one, and by default it's the one HQ was checked on
if (args.includes('--version')) { console.log(`${process.env.HQ_FAKE_VERSION ?? '0.0.0'} (Claude Code)`); process.exit(0) }
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
// `-p`: HQ's one-shot reader (src/checker.ts), which answers a plan or a diff check and ends. No model here: what it reads says what it answers. A line
// `FAKE-CHECK: <json>` anywhere in the prompt (a test puts it in the plan, or in a file of the diff) is the structured answer; with none, "ok". `FAKE-CHECK:
// error` is an API error (exit 1, as the real one), `hang` never answers, `garbage` answers with something that isn't the answer asked for, `hold <name>`
// answers "ok" once the test makes $HOME/<name>. Each call is logged to $HOME/fake-checks.jsonl, so a test can count them and read what the reader was shown.
if (args.includes('-p')) {
  let prompt = ''; for await (const c of process.stdin) prompt += c
  const said = /FAKE-CHECK: (.*)/.exec(prompt)?.[1]?.trim()
  const call = { pid: process.pid, system: flag('--system-prompt'), prompt, model: flag('--model'), tools: flag('--tools'),
    cwd: process.cwd(), mcp: flag('--mcp-config'), strictMcp: args.includes('--strict-mcp-config'),
    addDirs: args.flatMap((a, i) => a === '--add-dir' ? [args[i + 1]] : []), claudeEnv: Object.keys(process.env).filter((k) => /^CLAUDE/.test(k)) }
  fs.appendFileSync(path.join(process.env.HOME, 'fake-checks.jsonl'), `${JSON.stringify(call)}\n`)
  // The tester's call (src/tester.ts) comes with HQ's browser tools as an MCP server. The stand-in starts no server and no browser: it writes what that server
  // would have, to the file HQ reads (HQ_TESTER_OUT). A `FAKE-TESTER: <json>` line in the prompt (a test puts it in a criterion's text) is that file's content;
  // with none, a short try that found nothing. `FAKE-TESTER: hang` never answers, `error` is an API error, `silent` ends without the server having written.
  if (flag('--mcp-config')?.includes('"browse"')) {
    const told = /FAKE-TESTER: (.*)/.exec(prompt)?.[1]?.trim()
    if (told === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}) }
    if (told === 'error') { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'API Error: Overloaded' })); process.exit(1) }
    const clean = { started: true, why: null, actions: [{ tool: 'open', path: '/', ok: true }, { tool: 'click', role: 'button', name: 'Add', ok: true }],
      report: { tried: ['Opened the start page', 'Pressed Add'], problems: [] } }
    if (told !== 'silent') fs.writeFileSync(process.env.HQ_TESTER_OUT, JSON.stringify(told ? { ...clean, ...JSON.parse(told) } : clean))
    console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Done.', usage: { input_tokens: 19000, output_tokens: 1200 }, duration_ms: 9 })); process.exit(0)
  }
  // The UI tester (src/uitester.ts). Its planning call answers scenarios: `FAKE-PLAN: <json>` in the prompt (a test puts it in a criterion's text), else two.
  // `FAKE-PLAN: error` is an API error, `hang` never answers.
  if (/^You plan how to test/.test(flag('--system-prompt') ?? '')) {
    const plan = /FAKE-PLAN: (.*)/.exec(prompt)?.[1]?.trim()
    if (plan === 'error') { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'API Error: Overloaded' })); process.exit(1) }
    if (plan === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}) }
    const structured_output = plan ? JSON.parse(plan) : { scenarios: [{ kind: 'basic', title: 'See the list', goal: 'Open the app and see the list of items on it.' },
      { kind: 'weird', title: 'Add nothing', goal: 'Press Add with an empty name and see what the app says.' }] }
    console.log(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output, usage: { input_tokens: 3000, output_tokens: 500 }, total_cost_usd: 0.01 })); process.exit(0)
  }
  // The backend checker (src/backendcheck.ts) reads the recordings of the tester's run. `FAKE-BACKEND: <json>` in its prompt is its answer: a test puts it in
  // a backend criterion's text, where the other readers (which also see criteria) don't take it for theirs. `FAKE-CHECK:` works for it too, as for any reader.
  const backend = /^You check what a web app's backend did/.test(flag('--system-prompt') ?? '') ? /FAKE-BACKEND: (.*)/.exec(prompt)?.[1]?.trim() : null
  if (backend) {
    console.log(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: JSON.parse(backend), usage: { input_tokens: 9000, output_tokens: 700 }, duration_ms: 7 }))
    process.exit(0)
  }
  // Its sessions come with the browser and HQ's scenario tools. The stand-in starts neither: it does what they and Claude Code's hooks would, against the
  // tester's host (src/uitesthost.mjs, which is real: the app runs under it): for each scenario in the prompt, start it, open the page, look, click Add, and
  // finish it. As a browser would, it asks the app for the page when it opens it, and POSTs to /api/add when it clicks (at the address the host gave it).
  // `FAKE-UITEST: <json>` (by scenario id) is what it reports for each; with none, "ok". `hang` never answers; `error` is an API error.
  const uitest = JSON.parse(flag('--mcp-config') ?? '{}').mcpServers?.uitest
  if (uitest) {
    const told = /FAKE-UITEST: (.*)/.exec(prompt)?.[1]?.trim(), ctrl = JSON.parse(uitest.args[1]).ctrl
    if (told === 'error') { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'API Error: Overloaded' })); process.exit(1) }
    const host = async (what, body) => (await fetch(`http://127.0.0.1:${ctrl}/${what}`, { method: 'POST', body: JSON.stringify(body) })).json()
    let n = 0
    const tool = async (name, input, answer, act) => { const h = { tool_name: `mcp__browser__browser_${name}`, tool_input: input, tool_use_id: `t${++n}` }
      const pre = await host('pre', h); if (pre.hookSpecificOutput) return pre.hookSpecificOutput.permissionDecisionReason
      if (act) await act().then((r) => r.text()).catch(() => {})
      await host('post', { ...h, tool_response: [{ type: 'text', text: answer }] }) }
    const reports = told && told !== 'hang' ? JSON.parse(told) : {}
    for (const [, id] of prompt.matchAll(/^### (s-\d+)/gm)) {
      const s = await host('start', { id }); if (!s.ok) break
      if (told === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}) }
      await tool('navigate', { url: s.url }, `### Ran Playwright code\n\`\`\`js\nawait page.goto('${s.url}');\n\`\`\`\n### Page\n- Page URL: ${s.url}`, () => fetch(s.url))
      await tool('snapshot', {}, '### Page\n- Page URL: /\n### Snapshot\n```yaml\n- textbox "Name" [ref=e2]\n- button "Add" [ref=e3]\n```')
      await tool('click', { element: 'Add button', ref: 'e3' }, "### Ran Playwright code\n```js\nawait page.getByRole('button', { name: 'Add' }).click();\n```",
        () => fetch(`${s.url}api/add`, { method: 'POST', body: '{"name":"Dune"}' }))
      await host('finish', { id, report: reports[id] ?? { outcome: 'ok', notes: [], findings: [] } })
    }
    console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Done.', usage: { input_tokens: 20000, output_tokens: 1000 }, total_cost_usd: 0.05 })); process.exit(0)
  }
  if (said === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}) } // the timer keeps it alive: Node ends a script that only waits
  const hold = said?.startsWith('hold ') ? path.join(process.env.HOME, said.slice(5)) : null // Bug 208: the test acts while the reader has it
  while (hold && !fs.existsSync(hold)) await new Promise((r) => setTimeout(r, 100))
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1500, cache_read_input_tokens: 0, output_tokens: 300 }
  if (said === 'crash') { console.error('Error: the stand-in fell over\n    at somewhere\n        ^'); process.exit(2) }
  if (said === 'error') { console.log(JSON.stringify({ type: 'result', is_error: true, api_error_status: 529, result: 'API Error: Overloaded', usage })); process.exit(1) }
  if (said === 'garbage') { console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Looks fine to me!', usage })); process.exit(0) }
  const structured_output = said && !hold ? JSON.parse(said) : { verdict: 'ok', findings: [] }
  console.log(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(structured_output), structured_output, usage, duration_ms: 5 })); process.exit(0)
}
const settings = JSON.parse(fs.readFileSync(flag('--settings'), 'utf8'))
const worktree = flag('--worktree')
if (worktree) {
  const wt = path.join(process.cwd(), '.claude', 'worktrees', worktree)
  try { execFileSync('git', ['-C', process.cwd(), 'worktree', 'lock', '--reason', `claude session ${worktree} (pid ${process.pid} start ${new Date().toUTCString()})`, wt], { stdio: 'pipe' }) }
  catch (e) { console.error(`fake-claude: could not lock ${wt}: ${String(e.stderr ?? e).trim()}`) }
}
// Claude Code's own status file (Bug 62, presence.ts), which the tests then change as Claude Code would: hq.session(). Written before HQ hears of the session, so
// it is there once the agent shows as started, and never lands after a test's dialog to look newer than its alert (Bug 159). Whole or not at all: a temp file
// that HQ and hq.session() pass over (not .json), renamed into place.
const sessions = path.join(process.env.HOME, '.claude', 'sessions'), own = path.join(sessions, `${process.pid}.json`); fs.mkdirSync(sessions, { recursive: true })
fs.writeFileSync(`${own}.tmp`, JSON.stringify({ pid: process.pid, sessionId: flag('--session-id'), status: 'busy', statusUpdatedAt: Date.now() })); fs.renameSync(`${own}.tmp`, own)
// Runs HQ's own SessionStart command, as Claude Code does: the token comes from the agent's header file (Bug 87)
const start = { hook_event_name: 'SessionStart', session_id: flag('--session-id'), transcript_path: null, cwd: process.cwd(), source: 'startup', model: 'fake' }
execFileSync('/bin/sh', ['-c', settings.hooks.SessionStart[0].hooks[0].command], { input: JSON.stringify(start), stdio: ['pipe', 'ignore', 'inherit'] })
console.log(`fake-claude ${flag('--name') ?? ''} up (pid ${process.pid})`)
// Claude Code 2.1.300's screen when it waits at its prompt (Bug 25 tests): the input box and a footer with no "esc to interrupt"
if (process.env.HQ_FAKE_IDLE_SCREEN) console.log(`\n✻ Baked for 2s · done\n\n${'─'.repeat(60)}\n❯ \n${'─'.repeat(60)}\n  ⏸ manual mode on · ? for shortcuts · ← for agents`)
// A screen a test draws (hq.screen()), shown whenever it changes: a dialog's menu, say
const drawn = process.env.HQ_FAKE_SCREEN_DIR && path.join(process.env.HQ_FAKE_SCREEN_DIR, `${flag('--session-id')}.txt`); let shown = ''
setInterval(() => { if (!drawn) return; let t = ''; try { t = fs.readFileSync(drawn, 'utf8') } catch { return } if (t !== shown) { shown = t; process.stdout.write(`\x1b[2J\x1b[H${t}`) } }, 200)
// A command a test starts as this agent's Bash command (hq.spawn()): like Claude Code, a shell child of this process in a process group of its own (Bug 96)
const asked = process.env.HQ_FAKE_SCREEN_DIR && path.join(process.env.HQ_FAKE_SCREEN_DIR, `${flag('--session-id')}.spawn`)
setInterval(() => {
  if (!asked) return; let cmd = ''; try { cmd = fs.readFileSync(asked, 'utf8'); fs.rmSync(asked) } catch { return }
  const c = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' }); fs.writeFileSync(`${asked}ed`, String(c.pid))
}, 100)

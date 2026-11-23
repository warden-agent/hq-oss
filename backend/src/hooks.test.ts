// The hooks server (hooks.ts) asked directly: one request per hook, as Claude Code sends them, and what each does to the agent's row, what the page
// is told, which notices open, and what HQ answers. Until now only the end-to-end suite reached this file, through a whole HQ. Nothing in hooks.ts
// is changed for these: where HQ does something one might not expect, the test says what it does.
// Real SQLite in a temp HQ_HOME, the real server on a port the OS picks, and a stand-in tmux on PATH (no real tmux is called). A new agent per test.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-hooks-'))
process.env.HQ_HOME = path.join(root, 'hq'); process.env.HQ_HOOKS_PORT = '0'
const bin = path.join(root, 'bin'); fs.mkdirSync(bin)
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
[ "$1" = -S ] || exit 9 # every call names HQ's socket (Bug 242)
shift 2
case "$1" in
  display-message) echo 0 ;;
  capture-pane) printf '%s\\n' '--------------------' '> ' ;;
esac
exit 0
`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
const { migrate, run, q } = await import('./db.ts')
migrate()
const { getAgent } = await import('./agents.ts')
const { bus } = await import('./events.ts')
const { openAttention } = await import('./attention.ts')
const { sha } = await import('./util.ts')
const { TOKEN_HEADER } = await import('./roles.ts')
const { startHooksServer } = await import('./hooks.ts')

const srv = startHooksServer(); await new Promise((r) => srv.once('listening', r))
const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
after(() => { srv.close(); srv.closeAllConnections(); fs.rmSync(root, { recursive: true, force: true }) })

/** What the page has been told about each agent beyond its row: the activity line under its box is sent, never stored (Bug 98). */
const shown = new Map<string, Record<string, unknown>>()
bus.on('patch', (p: { entity: string; id: string; patch: Record<string, unknown> | null }) => { if (p.entity === 'agent' && p.patch) shown.set(p.id, { ...shown.get(p.id), ...p.patch }) })

type Made = { id: string; token: string }
let n = 0
/** An agent as a launch leaves it (agents.ts), without the terminal: its row, with the hash of a token of its own, and its session's row. */
function agent(role: 'engineer' | 'tpm' | 'launcher' = 'engineer'): Made {
  const id = `${role}-${++n}`, token = `token-of-${id}`
  run(`INSERT INTO agents(id, role, model_alias, tmux_session, cwd, token_hash, status, in_plan_mode, started_at, last_event_at)
    VALUES (?, ?, 'sonnet', ?, '/tmp', ?, 'launching', 0, 1, 1)`, id, role, `hq-${id}`, sha(token))
  run('INSERT INTO sessions(id, agent_id, started_at) VALUES (?,?,?)', `ses-${id}`, id, 1)
  return { id, token }
}
/** One hook, as Claude Code posts it: the event's fields as JSON with the three every hook carries (its session, its transcript, its folder), and the
 *  agent's token in a header (Bug 87). */
async function hook(a: Made, event: string, body: Record<string, unknown> = {}, token: string | null = a.token): Promise<{ status: number; json: any }> {
  const r = await fetch(`${url}/hooks`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === null ? {} : { [TOKEN_HEADER]: token }) },
    body: JSON.stringify({ hook_event_name: event, session_id: `session-${a.id}`, transcript_path: `/tmp/${a.id}.jsonl`, cwd: '/tmp', ...body }) })
  return { status: r.status, json: await r.json() }
}
const errors = (a: Made) => q<{ payload: string }>("SELECT payload FROM events WHERE agent_id = ? AND kind = 'hook.error'", a.id).map((e) => JSON.parse(e.payload).error as string)
const row = (a: Made) => getAgent(a.id)!
const activity = (a: Made) => shown.get(a.id)?.activity
const notices = (a: Made, kind: string) => openAttention().filter((x) => x.kind === kind && x.agent_id === a.id)
const tool = (name: string, input: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => ({ tool_name: name, tool_input: input, tool_use_id: `toolu_${++n}`, ...more })
const decision = (r: { json: any }) => r.json.hookSpecificOutput?.decision

test('a session starts, a prompt comes, the turn ends: working, working and "Thinking", then idle', async () => {
  const a = agent()
  assert.deepEqual(await hook(a, 'SessionStart', { source: 'startup', model: 'sonnet' }), { status: 200, json: {} })
  assert.equal(row(a).status, 'working'); assert.equal(row(a).claude_session_id, `session-${a.id}`); assert.equal(row(a).transcript_path, `/tmp/${a.id}.jsonl`)
  assert.deepEqual(await hook(a, 'UserPromptSubmit', { prompt: 'Build it' }), { status: 200, json: {} })
  assert.equal(row(a).status, 'working'); assert.equal(activity(a), 'Thinking')
  assert.deepEqual(await hook(a, 'PreToolUse', tool('Read', { file_path: '/repo/src/list.js' })), { status: 200, json: {} })
  assert.equal(activity(a), 'Reading src/list.js')
  assert.deepEqual(await hook(a, 'Stop', { last_assistant_message: 'Done.' }), { status: 200, json: {} })
  assert.equal(row(a).status, 'idle'); assert.equal(activity(a), null); assert.equal(shown.get(a.id)?.last_message, 'Done.')
})

test('Bug 94: a helper the agent started in the background keeps it working after its turn ends; when the helper ends it is idle', async () => {
  const a = agent(); await hook(a, 'UserPromptSubmit', { prompt: 'Look it up' })
  await hook(a, 'PostToolUse', tool('Agent', { description: 'look things up' }, { tool_response: { isAsync: true, agentId: 'helper-1', description: 'look things up' } }))
  await hook(a, 'Stop', { last_assistant_message: 'Waiting for my helper.' })
  assert.equal(row(a).status, 'working'); assert.equal(activity(a), 'Subagent: look things up')
  await hook(a, 'PreToolUse', tool('Read', { file_path: '/repo/README.md' }, { agent_id: 'helper-1' })) // the helper at work
  assert.equal(activity(a), 'Subagent: look things up · Reading repo/README.md')
  await hook(a, 'SubagentStop', { agent_id: 'helper-1' })
  assert.equal(row(a).status, 'idle'); assert.equal(activity(a), null)
})

test('Bug 25: a tool call by a helper after the turn has ended leaves the agent idle, and its box says nothing new', async () => {
  const a = agent(); await hook(a, 'UserPromptSubmit', { prompt: 'Go' }); await hook(a, 'Stop', { last_assistant_message: 'Done.' })
  assert.equal(row(a).status, 'idle')
  assert.deepEqual(await hook(a, 'PreToolUse', tool('Read', { file_path: '/repo/a.js' }, { agent_id: 'claude-codes-own-helper' })), { status: 200, json: {} })
  assert.equal(row(a).status, 'idle'); assert.equal(activity(a), null)
  await hook(a, 'SubagentStop', { agent_id: 'claude-codes-own-helper' }); assert.equal(row(a).status, 'idle')
  await hook(a, 'PreToolUse', tool('Read', { file_path: '/repo/a.js' })) // the agent's own tool call does make it working
  assert.equal(row(a).status, 'working'); assert.equal(activity(a), 'Reading repo/a.js')
})

test('Bug 72: a turn that ends with an API error leaves the agent blocked, with the reason and a notice; Bug 178: a new prompt ends both', async () => {
  const a = agent(); await hook(a, 'UserPromptSubmit', { prompt: 'Go' })
  assert.deepEqual(await hook(a, 'StopFailure', { error: 'overloaded_error' }), { status: 200, json: {} })
  assert.equal(row(a).status, 'blocked'); assert.equal(row(a).blocked_why, 'api_error'); assert.equal(activity(a), null)
  assert.equal(notices(a, 'api_error').length, 1); assert.match(notices(a, 'api_error')[0]!.detail, /turn ended with an API error: overloaded_error/)
  await hook(a, 'UserPromptSubmit', { prompt: 'Try again' })
  assert.equal(row(a).status, 'working'); assert.equal(row(a).blocked_why, null); assert.deepEqual(notices(a, 'api_error'), [])
})

test('a /clear does not end the agent; a session that ends does, and takes its token with it', async () => {
  const a = agent(); await hook(a, 'SessionStart', { source: 'startup' })
  assert.deepEqual(await hook(a, 'SessionEnd', { reason: 'clear' }), { status: 200, json: {} })
  assert.equal(row(a).status, 'working'); assert.equal(row(a).ended_at, null); assert.equal(row(a).token_revoked_at, null)
  assert.deepEqual(await hook(a, 'SessionEnd', { reason: 'other' }), { status: 200, json: {} })
  assert.equal(row(a).status, 'exited'); assert.equal(row(a).ended_why, 'session:other'); assert.ok(row(a).ended_at); assert.ok(row(a).token_revoked_at)
  // A prompt that comes late from that session is turned away at the door: its token is no good any more
  assert.deepEqual(await hook(a, 'UserPromptSubmit', { prompt: 'One more thing' }), { status: 403, json: { error: 'bad token' } })
  assert.equal(row(a).status, 'exited')
})

test('a late hook from an agent HQ already counts as gone, its token still good, is logged and does not bring it back', async () => {
  const a = agent(); await hook(a, 'SessionStart', { source: 'startup' })
  run("UPDATE agents SET status = 'exited', ended_why = 'lost' WHERE id = ?", a.id) // gone some other way, between two hooks
  assert.deepEqual(await hook(a, 'UserPromptSubmit', { prompt: 'One more thing' }), { status: 200, json: {} })
  assert.equal(row(a).status, 'exited'); assert.equal(row(a).ended_why, 'lost')
  assert.deepEqual(await hook(a, 'StopFailure', { error: 'overloaded_error' }), { status: 200, json: {} })
  assert.equal(row(a).status, 'exited'); assert.equal(row(a).blocked_why, null)
  assert.equal(notices(a, 'api_error').length, 1) // the notice does open: an ended agent's API error is one auto mode acts on, so it is not among those that end with their agent
  assert.deepEqual(errors(a), [])
})

test('Bug 324: a SessionStart that names no transcript, or no session, still starts the agent; both rows take what is missing as null', async () => {
  const a = agent() // Claude Code sends both with every hook (2.1.322), so this is HQ's own guard: before the fix the session's row was given
  // undefined, SQLite refused it, and the whole hook was dropped (the agent stayed launching, with a hook.error)
  const session = (m: Made) => ({ ...q<{ claude_session_id: string | null; transcript_path: string | null }>(
    'SELECT claude_session_id, transcript_path FROM sessions WHERE agent_id = ?', m.id)[0] })
  assert.deepEqual(await hook(a, 'SessionStart', { source: 'startup', transcript_path: undefined }), { status: 200, json: {} })
  assert.equal(row(a).status, 'working'); assert.equal(row(a).claude_session_id, `session-${a.id}`); assert.equal(row(a).transcript_path, null)
  assert.deepEqual(session(a), { claude_session_id: `session-${a.id}`, transcript_path: null }); assert.deepEqual(errors(a), [])
  const b = agent()
  assert.deepEqual(await hook(b, 'SessionStart', { source: 'startup', session_id: undefined, transcript_path: undefined }), { status: 200, json: {} })
  assert.equal(row(b).status, 'working'); assert.equal(row(b).claude_session_id, null); assert.equal(row(b).transcript_path, null)
  assert.deepEqual(session(b), { claude_session_id: null, transcript_path: null }); assert.deepEqual(errors(b), [])
})

test('a permission request: HQ\'s own tools are allowed, Bash is refused while planning, and an engineer\'s Bash is allowed after', async () => {
  const a = agent()
  assert.deepEqual(decision(await hook(a, 'PermissionRequest', tool('mcp__hq__get_ticket', {}, { permission_mode: 'plan' }))), { behavior: 'allow' })
  assert.equal(row(a).in_plan_mode, 1)
  const no = decision(await hook(a, 'PermissionRequest', tool('Bash', { command: 'npm test' }, { permission_mode: 'plan' })))
  assert.equal(no.behavior, 'deny'); assert.equal(no.message, "HQ: 'npm test' is not allowed during planning; run it after plan approval.")
  assert.deepEqual(decision(await hook(a, 'PermissionRequest', tool('Bash', { command: 'npm test' }, { permission_mode: 'acceptEdits' }))), { behavior: 'allow' })
  assert.equal(row(a).in_plan_mode, 0); assert.deepEqual(notices(a, 'unexpected_prompt'), [])
})

test('a permission request for anything else is refused and the user is told: a TPM\'s WebFetch, and a TPM\'s Bash too', async () => {
  const t = agent('tpm')
  const no = decision(await hook(t, 'PermissionRequest', tool('WebFetch', { url: 'https://example.com' }, { permission_mode: 'default' })))
  assert.equal(no.behavior, 'deny'); assert.match(no.message, /^HQ: 'WebFetch' would need approval and is not allowed here\./)
  assert.equal(notices(t, 'unexpected_prompt').length, 1); assert.match(notices(t, 'unexpected_prompt')[0]!.detail, /WebFetch needed approval .*denied by policy$/)
  const bash = decision(await hook(t, 'PermissionRequest', tool('Bash', { command: 'ls' }, { permission_mode: 'default' }))) // only engineers and the Launch helper are sandboxed
  assert.equal(bash.behavior, 'deny'); assert.match(notices(t, 'unexpected_prompt')[0]!.detail, /Bash needed approval/)
})

test('HQ keeps the model and the settings: a model switch is refused, a settings change is blocked for an engineer and not for a TPM', async () => {
  const e = agent(), t = agent('tpm'), l = agent('launcher')
  const sw = await hook(e, 'PreModelSwitch', { from_model: 'sonnet', to_model: 'opus', source: 'user' })
  assert.deepEqual(sw.json.hookSpecificOutput, { hookEventName: 'PreModelSwitch', permissionDecision: 'deny', permissionDecisionReason: 'HQ controls models for this agent.' })
  const change = { source: 'user_settings', file_path: '/Users/x/.claude/settings.json' }
  assert.deepEqual((await hook(e, 'ConfigChange', change)).json, { decision: 'block', reason: 'HQ: configuration changes are not allowed' })
  assert.deepEqual((await hook(l, 'ConfigChange', change)).json, { decision: 'block', reason: 'HQ: configuration changes are not allowed' })
  assert.deepEqual((await hook(t, 'ConfigChange', change)).json, {})
})

test('a TPM is never compacted by Claude Code itself: HQ blocks it and asks for a fresh start; an engineer\'s, or one the user asked for, goes ahead', async () => {
  const t = agent('tpm'), e = agent()
  assert.deepEqual((await hook(t, 'PreCompact', { trigger: 'auto' })).json, { decision: 'block', reason: 'HQ fresh-starts the TPM instead of compacting' })
  assert.equal(notices(t, 'tpm_rotate').length, 1)
  assert.deepEqual((await hook(t, 'PreCompact', { trigger: 'manual' })).json, {})
  assert.deepEqual((await hook(e, 'PreCompact', { trigger: 'auto' })).json, {}); assert.deepEqual(notices(e, 'tpm_rotate'), [])
})

test('Bug 62: a dialog notice blocks the agent and tells the user; a plan review\'s own notice does not; the session\'s end takes the notice with it', async () => {
  const a = agent(); await hook(a, 'UserPromptSubmit', { prompt: 'Go' })
  await hook(a, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use the plan tool' })
  assert.equal(row(a).status, 'working'); assert.deepEqual(notices(a, 'dialog'), [])
  await hook(a, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }) // not a dialog
  assert.equal(row(a).status, 'working'); assert.deepEqual(notices(a, 'dialog'), [])
  await hook(a, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  assert.equal(row(a).status, 'blocked'); assert.equal(row(a).blocked_why, 'dialog'); assert.equal(notices(a, 'dialog').length, 1)
  await hook(a, 'SessionEnd', { reason: 'logout' }); assert.equal(row(a).status, 'exited'); assert.deepEqual(notices(a, 'dialog'), [])
})

test('the usage limit: told it will not resume by itself the agent is paused with a notice; told it has resumed, it works again', async () => {
  const a = agent(); await hook(a, 'UserPromptSubmit', { prompt: 'Go' })
  await hook(a, 'Notification', { notification_type: 'quota_auto_resume_disabled', message: 'Usage limit reached' })
  assert.equal(row(a).status, 'paused'); assert.equal(row(a).paused_reason, 'quota_auto_resume_disabled'); assert.equal(notices(a, 'usage_limit').length, 1)
  await hook(a, 'Notification', { notification_type: 'quota_auto_resume_fired', message: 'Resuming' })
  assert.equal(row(a).status, 'working'); assert.equal(row(a).paused_reason, null); assert.deepEqual(notices(a, 'usage_limit'), [])
})

// The two parts of hooks.ts that no test reached, by the coverage report of both suites (2026-11-20): an agent's task list, and a mod's unknown action
test('an agent\'s task list: each task it creates is counted on its box, and one it completes is counted done', async () => {
  const a = agent(), tasks = () => q<{ task_id: string; subject: string | null; status: string }>('SELECT task_id, subject, status FROM task_progress WHERE agent_id = ? ORDER BY position', a.id)
  await hook(a, 'PostToolUse', tool('TaskCreate', { subject: 'Write the list' }, { tool_response: { id: '1' } }))
  await hook(a, 'PostToolUse', tool('TaskCreate', { subject: 'Test the list' }, { tool_response: { id: '2' } }))
  assert.deepEqual(tasks().map((t) => ({ ...t })), [{ task_id: '1', subject: 'Write the list', status: 'pending' }, { task_id: '2', subject: 'Test the list', status: 'pending' }])
  assert.deepEqual([shown.get(a.id)?.steps_done, shown.get(a.id)?.steps_total], [0, 2])
  await hook(a, 'PostToolUse', tool('TaskUpdate', { taskId: '1', status: 'completed' }))
  assert.deepEqual(tasks().map((t) => [t.task_id, t.subject, t.status]), [['1', 'Write the list', 'completed'], ['2', 'Test the list', 'pending']]) // its words are kept
  assert.deepEqual([shown.get(a.id)?.steps_done, shown.get(a.id)?.steps_total], [1, 2])
  await hook(a, 'PostToolUse', tool('TaskUpdate', {})) // names no task and says nothing: nothing to count
  assert.equal(tasks().length, 2); assert.deepEqual(errors(a), [])
})

test('a mod is let in by its agent\'s token, an action HQ does not know is not found, and its events are logged', async () => {
  const a = agent(), mod = (token: string, action: string, body: unknown = {}) => fetch(`${url}/mod/${token}/${action}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }))
  assert.deepEqual(await mod('not-its-token', 'event', { kind: 'session.start' }), { status: 403, json: { error: 'bad token' } })
  assert.deepEqual(await mod(a.token, 'nonsense'), { status: 404, json: {} })
  assert.deepEqual(await mod(a.token, 'event', { kind: 'session.start', hasToken: true }), { status: 200, json: { ok: true } })
  assert.equal(q<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND kind = 'mod.session.start'", a.id)[0]!.n, 1); assert.ok(row(a).mod_seen_at)
})

test('at the door: a wrong token is refused, no token is not found, and a request with no event is answered and changes nothing', async () => {
  const a = agent()
  assert.deepEqual(await hook(a, 'SessionStart', {}, 'not-its-token'), { status: 403, json: { error: 'bad token' } })
  assert.deepEqual(await hook(a, 'SessionStart', {}, null), { status: 404, json: {} })
  const r = await fetch(`${url}/hooks`, { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: a.token }, body: '{}' })
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), {})
  assert.equal(row(a).status, 'launching'); assert.equal(row(a).last_event_at, 1)
})

// Bug 122: what the Agents menu says under an agent that has ended (frontend/src/api.ts endedLine), and that every way an agent
// ends (agents.ts update) clears its activity line in the same patch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { alertFrom, endedLine, type Agent } from '../../frontend/src/api.ts'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-ended-'))
const { migrate, run } = await import('./db.ts')
const { bus } = await import('./events.ts')
const { update, lost, getAgent } = await import('./agents.ts')
migrate()

const NOW = new Date(2026, 10, 13, 1, 30).getTime(), AT = new Date(2026, 10, 13, 1, 17).getTime()
const time = new Date(AT).toLocaleString([], { hour: 'numeric', minute: '2-digit' })
const eng = (o: Record<string, unknown> = {}): Agent => ({ id: 'eng-1', role: 'engineer', status: 'exited', ticket_id: 't1', repo_id: 'r1', started_at: 100, ended_at: AT, ended_why: null, ...o })
const line = (a: Agent, others: Agent[] = []) => endedLine(a, { agents: [a, ...others] }, NOW)

test('a fresh start reads "replaced" once a newer agent has the same ticket; before that it ended for one', () => {
  const old = eng({ ended_why: 'fresh_start' })
  assert.equal(line(old, [eng({ id: 'eng-2', status: 'working', started_at: 200, ended_at: null })]), `replaced by a fresh start · ${time}`)
  assert.equal(line(old), `ended for a fresh start · ${time}`)
  assert.equal(line(old, [eng({ id: 'eng-0', started_at: 50 })]), `ended for a fresh start · ${time}`, 'an older engineer replaced nothing')
  assert.equal(line(old, [eng({ id: 'eng-9', ticket_id: 't2', started_at: 200 })]), `ended for a fresh start · ${time}`, "another ticket's engineer isn't its successor")
  const tpm = (o: Record<string, unknown>) => eng({ role: 'tpm', ticket_id: null, ended_why: 'fresh_start', ...o })
  assert.equal(line(tpm({ id: 'tpm-1' }), [tpm({ id: 'tpm-2', started_at: 200, status: 'idle' })]), `replaced by a fresh start · ${time}`)
  assert.equal(line(tpm({ id: 'tpm-1' }), [tpm({ id: 'tpm-2', started_at: 200, repo_id: 'r2' })]), `ended for a fresh start · ${time}`, "another project's TPM")
})

test('other endings never say "replaced", even with a newer engineer on the ticket', () => {
  const newer = eng({ id: 'eng-2', status: 'working', started_at: 200 })
  const cases: [string | null, string][] = [['user', 'stopped by you'], ['finished', 'stopped: its ticket is done'], ['merged', 'stopped: its work was merged'],
    ['cancelled', 'stopped: its ticket was cancelled'], ['parked', 'stopped: its work was parked'], ['cleared', 'stopped: the project was cleared'],
    ['lost', 'its process ended without HQ stopping it'], ['session:prompt_input_exit', 'its session ended'], ['session:', 'its session ended'],
    ['stopped', 'stopped by HQ'], ['something new', 'stopped by HQ'], [null, 'ended']]
  for (const [why, text] of cases) assert.equal(line(eng({ ended_why: why }), [newer]), `${text} · ${time}`, String(why))
  assert.equal(line(eng({ ended_why: 'replaced by auto mode' })), `replaced by auto mode · ${time}`)
})

test('a running agent has no line; an old row says what it knows and no more; another day gives the date', () => {
  for (const status of ['working', 'idle', 'launching', 'paused']) assert.equal(line(eng({ status, ended_why: 'user' })), null, status)
  assert.equal(line(eng({ ended_at: null })), null, 'nothing recorded: no line, never a "?"')
  assert.equal(line(eng({ ended_at: null, ended_why: 'user' })), 'stopped by you')
  const before = new Date(2026, 10, 11, 23, 5).getTime()
  assert.equal(line(eng({ ended_why: 'user', ended_at: before })), `stopped by you · ${new Date(before).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`)
})

test('every way an agent ends clears its activity line in the same patch; other updates leave it alone', () => {
  const seen: Record<string, unknown>[] = []
  bus.on('patch', (p: { entity: string; id: string; patch: Record<string, unknown> }) => { if (p.entity === 'agent' && p.id.startsWith('eng-u')) seen.push(p.patch) })
  const add = (id: string) => run(`INSERT INTO agents(id, role, model_alias, tmux_session, cwd, token_hash, status, in_plan_mode, started_at)
    VALUES (?, 'engineer', 'sonnet', ?, '/tmp', ?, 'working', 0, 1)`, id, `hq-${id}`, id)
  add('eng-u1'); add('eng-u2')
  update('eng-u1', { status: 'idle' }, { activity: 'Thinking' }); assert.equal(seen.at(-1)!.activity, 'Thinking')
  update('eng-u1', { status: 'exited', ended_why: 'user' }, { activity: 'Running: npm test' }); assert.deepEqual([seen.at(-1)!.activity, seen.at(-1)!.ended_why], [null, 'user'])
  lost('eng-u2'); const p = seen.find((x) => x.status === 'exited' && x.ended_why === 'lost'); assert.ok(p); assert.equal(p.activity, null)
  assert.equal(getAgent('eng-u2')!.ended_why, 'lost')
  const ended = getAgent('eng-u1')!; lost('eng-u1') // a late "gone" for an agent that had already ended keeps why and when it did
  assert.deepEqual([getAgent('eng-u1')!.ended_why, getAgent('eng-u1')!.ended_at], [ended.ended_why, ended.ended_at])
})

test('Bugs 153, 165: an alert about an agent that has ended says whose it was, so it is not read as the running one\'s', () => {
  const tpm = (o: Record<string, unknown>) => eng({ role: 'tpm', ticket_id: null, display_name: 'TPM shop', ...o })
  const old = tpm({ id: 'tpm-1', ended_why: 'user' }), now = tpm({ id: 'tpm-2', status: 'idle', started_at: 200, ended_at: null })
  const from = (x: Record<string, unknown>, agents: Agent[]) => alertFrom({ kind: 'mod_missing', ...x }, { agents }, NOW)
  assert.deepEqual(from({ agent_id: 'tpm-1' }, [old, now]), { tag: 'earlier TPM', line: `From an earlier TPM shop, which has ended (stopped by you · ${time}).` })
  assert.deepEqual(from({ agent_id: 'tpm-1' }, [old]), { tag: 'TPM ended', line: `From TPM shop, which has ended (stopped by you · ${time}).` })
  assert.equal(from({ agent_id: 'tpm-2' }, [old, now]), null, 'the running one\'s own alert')
  assert.equal(from({ agent_id: null }, [old]), null); assert.equal(from({ agent_id: 'tpm-9' }, [old]), null, 'not in the list: nothing to say')
  for (const kind of ['agent_exited', 'engineer_exited']) assert.equal(alertFrom({ agent_id: 'tpm-1', kind }, { agents: [old, now] }, NOW), null, `${kind} says so itself`)
  const e1 = eng({ display_name: 'eng T-01', ended_why: 'replaced by auto mode' }), e2 = eng({ id: 'eng-2', status: 'working', started_at: 200, ended_at: null })
  assert.equal(from({ agent_id: 'eng-1' }, [e1, e2])?.tag, 'earlier engineer')
  assert.equal(from({ agent_id: 'eng-1' }, [eng({ ended_at: null })])?.line, 'From eng-1, which has ended.', 'an old row with nothing recorded')
})

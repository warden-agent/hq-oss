// Bug 370: HQ's notice that a ticket's spec changed reached its engineer only after the turn it built the old version in had ended. While the agent's own
// turn is at work, such a notice (delivery.ts MID_TURN_REASONS) isn't handed to the mod: its next tool step carries it in (stepNotes). Held at most
// HQ_MID_TURN_HOLD_S; once the turn ends, or the hold does, the mod hands it out as before. Real SQLite in a temp HQ_HOME; a clock the test moves.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-midturn-'))
const realNow = Date.now
let clock = realNow()
Date.now = () => clock
const { migrate, run, one, setSetting } = await import('./db.ts')
migrate()
const { getAgent, update } = await import('./agents.ts')
const { emit } = await import('./events.ts')
const { sendMessage, nextBatchFor, modLook, stepNotes, turnAtWork } = await import('./delivery.ts')
after(() => { Date.now = realNow; fs.rmSync(process.env.HQ_HOME!, { recursive: true, force: true }) })

const HOLD_MS = 600_000 // the default HQ_MID_TURN_HOLD_S
let n = 0
/** An engineer whose own turn is at work: working, and a prompt started its turn. */
function engineer(): string {
  const id = `eng-${++n}`
  run(`INSERT INTO agents(id, role, model_alias, tmux_session, cwd, token_hash, status, in_plan_mode, started_at, last_event_at)
    VALUES (?, 'engineer', 'sonnet', ?, '/tmp', 'x', 'working', 0, 1, 1)`, id, `hq-${id}`)
  hookEvent(id, 'hook.SessionStart'); hookEvent(id, 'hook.UserPromptSubmit')
  return id
}
const hookEvent = (id: string, kind: string, payload: Record<string, unknown> = {}): void => { emit({ agentId: id, source: 'hook', kind, payload }) }
const spec = (id: string) => sendMessage({ channel: 'dm', from: 'hq', to: id, reason: 'spec_change', body: "HQ: the TPM updated T-01's spec. Call get_ticket to read it." })
const fyi = (id: string, body = 'A note from the TPM.') => sendMessage({ channel: 'dm', from: 'hq', to: id, reason: 'fyi', body })
const msg = (id: string) => one<{ delivered_at: number | null; delivery_method: string | null; ack_at: number | null }>('SELECT * FROM messages WHERE id = ?', id)!
const look = (id: string) => modLook(getAgent(id)!)

test('a spec change goes in at the working agent\'s next step, once; the mod gets the rest at once', () => {
  const id = engineer(), s = spec(id), f = fyi(id)
  const { batch, due } = look(id)
  assert.ok(batch, 'the ordinary note goes to the mod as before'); assert.match(batch.text, /A note from the TPM/); assert.doesNotMatch(batch.text, /updated T-01/)
  assert.equal(msg(f.id).delivery_method, 'mod'); assert.equal(msg(s.id).delivered_at, null)
  assert.equal(due, null) // a batch was handed out
  const notes = stepNotes(id)
  assert.equal(notes, `HQ: this message came in while you work. Read it now, before your next step:\n\n[spec_change] from HQ [msg ${s.id}]: ${s.body}`)
  assert.deepEqual([msg(s.id).delivery_method, msg(s.id).delivered_at, msg(s.id).ack_at], ['hook', clock, clock])
  assert.equal(stepNotes(id), null, 'read once')
  const ev = one<{ payload: string }>("SELECT payload FROM events WHERE agent_id = ? AND kind = 'message.at_step'", id)!
  assert.deepEqual(JSON.parse(ev.payload), { ids: [s.id], text: s.body })
})

test('two changes in one step go in together; nothing else rides along', () => {
  const id = engineer(), a = spec(id), b = spec(id); fyi(id, 'Not for a step.')
  const notes = stepNotes(id)!
  assert.match(notes, /^HQ: these messages came in while you work\. Read them now, before your next step:/)
  assert.ok(notes.includes(`[msg ${a.id}]`) && notes.includes(`[msg ${b.id}]`)); assert.doesNotMatch(notes, /Not for a step/)
})

test('held while no step comes: the mod is told when the hold ends, and gets it then', () => {
  const id = engineer(), s = spec(id)
  const first = look(id)
  assert.equal(first.batch, null); assert.equal(first.due, s.created_at + HOLD_MS + 1)
  clock = s.created_at + HOLD_MS - 1; assert.equal(look(id).batch, null)
  clock = s.created_at + HOLD_MS + 1
  const late = look(id).batch; assert.ok(late, 'after the hold, as before'); assert.match(late.text, /updated T-01/)
  clock += 1000
})

test('once its turn has ended, a spec change goes to the mod at once, however the turn ended', () => {
  for (const [kind, payload] of [['hook.Stop', {}], ['hook.StopFailure', {}], ['mod.turn.complete', { isAborted: true }]] as const) {
    const id = engineer(); hookEvent(id, kind, payload)
    assert.equal(turnAtWork(getAgent(id)!), false, kind) // still 'working' (a helper or a background run would keep it so)
    spec(id); const b = look(id).batch; assert.ok(b, kind); assert.match(b.text, /updated T-01/)
  }
  const id = engineer(); hookEvent(id, 'mod.turn.complete', { agentId: 'helper-1' }) // a helper's turn ended, not its own
  assert.equal(turnAtWork(getAgent(id)!), true)
})

test('a plan review and a dialog hold it too; an idle agent, an API error and a typed batch do not', () => {
  const at = (fields: Parameters<typeof update>[1]) => { const id = engineer(); update(id, fields); return turnAtWork(getAgent(id)!) }
  assert.equal(at({ status: 'plan_review' }), true)
  assert.equal(at({ status: 'blocked', blocked_why: 'dialog' }), true)
  assert.equal(at({ status: 'blocked', blocked_why: 'api_error' }), false)
  assert.equal(at({ status: 'idle' }), false)
  assert.equal(at({ status: 'paused' }), false)
  const id = engineer(); spec(id)
  const typed = nextBatchFor(getAgent(id)!, 'typed'); assert.ok(typed, 'HQ types only into a waiting prompt: no turn there to wait for'); assert.match(typed.text, /updated T-01/)
})

test('a step carries nothing to an agent that takes no messages now', () => {
  const cases: [string, Parameters<typeof update>[1]][] = [['a fresh start', { fresh_start_at: clock }], ['someone at its terminal', { takeover_locked_until: clock + 60_000 }],
    ['paused', { status: 'paused' }], ['stopped', { status: 'exited' }]]
  for (const [what, fields] of cases) {
    const id = engineer(), s = spec(id); update(id, fields)
    assert.equal(stepNotes(id), null, what); assert.equal(msg(s.id).delivered_at, null, what)
  }
  setSetting('paused_roles', ['engineer'])
  const id = engineer(); spec(id); assert.equal(stepNotes(id), null, 'engineers paused'); setSetting('paused_roles', [])
  assert.ok(stepNotes(id), 'and once they are resumed')
})

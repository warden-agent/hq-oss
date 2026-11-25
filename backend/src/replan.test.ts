// Bug 371: which changes ask for a new plan (replan.ts), against a real SQLite DB in a temp HQ_HOME. What it must not catch matters as much: auto mode on
// (HQ's plan check answers plans, as before), the switch off, a ticket with no plan handed in yet, a finished one, and one being fixed after it was.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-replan-'))
after(() => fs.rmSync(process.env.HQ_HOME!, { recursive: true, force: true }))
const { migrate, run, setSetting } = await import('./db.ts')
migrate()
const { beforeChange, changeAsksReplan, replanDue } = await import('./replan.ts')
type Ticket = import('./records.ts').Ticket

const at = Date.now()
run("INSERT INTO repos(id, name, path, kind, created_at, auto_mode) VALUES ('off', 'off', '/tmp/hq-replan-off', 'local', ?, 0), ('on', 'on', '/tmp/hq-replan-on', 'local', ?, 1)", at, at)
const tk = (o: Partial<Ticket>): Ticket => ({ status: 'implementing', plan_round: 1, prior_status: null, replan_after: null, ...o }) as Ticket

test('auto off: a started ticket with a plan handed in asks for a new plan, while it plans, waits for review, builds, asks or is escalated', () => {
  for (const status of ['planning', 'plan_review', 'implementing', 'awaiting_answer', 'escalated'] as const) assert.equal(changeAsksReplan(tk({ status }), 'off'), true, status)
})

test('it does not ask with auto on, with the switch off, before any plan, once finished, or while the ticket is fixed after it finished', () => {
  assert.equal(changeAsksReplan(tk({}), 'on'), false) // auto mode: HQ's plan check answers plans; the engineer builds on, as before
  assert.equal(changeAsksReplan(tk({ status: 'planning', plan_round: 0 }), 'off'), false) // the first plan isn't written yet: it is written for the new spec
  for (const status of ['queued', 'pr_ready', 'pr_open', 'resolving', 'merged', 'cancelled'] as const) assert.equal(changeAsksReplan(tk({ status }), 'off'), false, status)
  assert.equal(changeAsksReplan(tk({ status: 'awaiting_answer', prior_status: 'resolving' }), 'off'), false) // a question while fixing a finished ticket
  setSetting('replan_on_change', 'off')
  try { assert.equal(changeAsksReplan(tk({}), 'off'), false) } finally { setSetting('replan_on_change', 'on') }
})

test('a new plan owed holds only while auto is off and the switch on; a plan of a later round settles it, by round, not by time', () => {
  const owed = tk({ replan_after: 2 })
  assert.equal(replanDue(owed, 'off'), true); assert.equal(replanDue(owed, 'on'), false); assert.equal(replanDue(tk({}), 'off'), false)
  setSetting('replan_on_change', 'off')
  try { assert.equal(replanDue(owed, 'off'), false) } finally { setSetting('replan_on_change', 'on') }
  assert.deepEqual([1, 2, 3].map((r) => beforeChange(owed, r)), [true, true, false])
  assert.equal(beforeChange(tk({}), 1), false)
})

test('Bug 371 follow-up: the transcript says which model response a tool call came in, as Claude Code 2.1.322 writes it (one line per tool call)', async () => {
  const { responseOf } = await import('./replan.ts')
  const file = path.join(process.env.HQ_HOME!, 'transcript.jsonl'), call = (msg: string, name: string, id: string) => JSON.stringify({ type: 'assistant',
    message: { id: msg, role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } })
  fs.writeFileSync(file, [call('msg_1', 'Write', 'toolu_W'), JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['HQ: …'] } }),
    call('msg_1', 'ExitPlanMode', 'toolu_E1'), JSON.stringify({ type: 'api-request-blob', content: [{ type: 'tool_use', id: 'toolu_W', name: 'Write' }] }), 'not json'].join('\n'))
  assert.deepEqual(responseOf(file, 'toolu_W'), { step: 'msg_1', plan: 'msg_1' }) // the plan was decided with the step that brought the notice in
  fs.appendFileSync(file, `\n${call('msg_2', 'EnterPlanMode', 'toolu_P')}\n${call('msg_3', 'ExitPlanMode', 'toolu_E2')}\n`)
  assert.deepEqual(responseOf(file, 'toolu_W'), { step: 'msg_1', plan: 'msg_3' }) // a later response
  assert.deepEqual(responseOf(path.join(process.env.HQ_HOME!, 'none.jsonl'), 'toolu_W'), { step: null, plan: null }) // no transcript: can't tell
})

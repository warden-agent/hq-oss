// Bug 330: one look of the mod's waiting `next` request (delivery.ts modLook) gives two answers: the batch to hand out now, and otherwise when
// to look again. Both must come from one reading of the clock. They used to come from two, and a batch that fell due between the readings was
// in neither answer: not yet due for the first, already past for the second. The request then slept to its backstop (5 s) or to its end.
// Here the clock moves on a millisecond every time HQ reads it, which is the worst a real clock does between two lines. Real SQLite in a temp
// HQ_HOME; no timers and no server.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-modlook-'))
const realNow = Date.now
let clock = realNow()
Date.now = () => clock++ // every reading is a millisecond after the one before
const { migrate, run, one, setSetting } = await import('./db.ts')
migrate()
const { getAgent } = await import('./agents.ts')
const { sendMessage, nextBatchFor, modLook } = await import('./delivery.ts')
after(() => { Date.now = realNow; fs.rmSync(process.env.HQ_HOME!, { recursive: true, force: true }) })

const RECEIVE_S = 1
setSetting('batch_receive_s', RECEIVE_S)
let n = 0
/** A working agent with one message, handed out once in a batch the mod never reports getting. */
function agentWithLostBatch(): { id: string; lost: NonNullable<ReturnType<typeof nextBatchFor>> } {
  const id = `tpm-${++n}`
  run(`INSERT INTO agents(id, role, model_alias, tmux_session, cwd, token_hash, status, in_plan_mode, started_at, last_event_at)
    VALUES (?, 'tpm', 'sonnet', ?, '/tmp', 'x', 'working', 0, 1, 1)`, id, `hq-${id}`)
  sendMessage({ channel: 'dm', from: 'user', to: id, reason: 'fyi', body: 'Lost note.' })
  const lost = nextBatchFor(getAgent(id)!); assert.ok(lost, 'handed out the first time'); assert.match(lost.text, /Lost note/)
  return { id, lost }
}
const droppedAt = (batchId: string) => one<{ dropped_at: number | null }>('SELECT dropped_at FROM batches WHERE id = ?', batchId)!.dropped_at

// `early`: the look's own reading of the clock, in ms before (-) or after (+) the moment the batch falls due
for (const early of [-3, -2, -1, 0, 1, 2, 3]) {
  test(`a look ${early < 0 ? `${-early} ms before` : early ? `${early} ms after` : 'in the very millisecond'} a batch falls due does not lose it`, () => {
    const { id, lost } = agentWithLostBatch(), dueAt = lost.handed_at! + RECEIVE_S * 1000
    clock = dueAt + early
    const { batch, due } = modLook(getAgent(id)!)
    if (early > 0) { // past due: this look puts it back and hands it out again
      assert.equal(batch?.text, lost.text); assert.notEqual(batch?.id, lost.id); assert.ok(droppedAt(lost.id), 'the lost batch was put back'); return
    }
    // not past due by this look's reading: nothing yet, and the look says to come back as it falls due, not at the three-minute mark
    assert.equal(batch, null); assert.equal(droppedAt(lost.id), null)
    assert.equal(due, dueAt + 1, `look again at ${due === null ? 'no time at all' : `${due - dueAt} ms after it falls due`}`)
    clock = due
    const again = modLook(getAgent(id)!).batch
    assert.equal(again?.text, lost.text, 'the look at that time hands it out again'); assert.notEqual(again?.id, lost.id)
  })
}

test('with nothing handed out and nothing waiting, a look has no time to come back at', () => {
  const id = `tpm-${++n}`
  run(`INSERT INTO agents(id, role, model_alias, tmux_session, cwd, token_hash, status, in_plan_mode, started_at, last_event_at)
    VALUES (?, 'tpm', 'sonnet', ?, '/tmp', 'x', 'working', 0, 1, 1)`, id, `hq-${id}`)
  assert.deepEqual(modLook(getAgent(id)!), { batch: null, due: null })
})

test('a batch the mod got is not handed out again, and the look comes back when it stops holding the rest', () => {
  const { id, lost } = agentWithLostBatch()
  run('UPDATE batches SET received_at = ? WHERE id = ?', lost.handed_at! + 5, lost.id)
  clock = lost.handed_at! + RECEIVE_S * 1000 + 50
  const { batch, due } = modLook(getAgent(id)!)
  assert.equal(batch, null); assert.equal(droppedAt(lost.id), null); assert.equal(due, lost.handed_at! + 180_000 + 1)
})

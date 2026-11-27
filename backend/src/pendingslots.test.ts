// Bug 422: a start the last backend went down in the middle of left its engineer's port block under `pending-<ticket>`, which counts as taken for good.
// At start-up it goes to the engineer that start launched (one still running, on that ticket, whose launch script has those ports), or is freed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-pendingslots-'))
const { migrate, q, run } = await import('./db.ts')
migrate()
const { takenSlots } = await import('./runports.ts')
const { settlePendingSlots, slotEnv } = await import('./slots.ts')
const { agentDir } = await import('./agents.ts')

let t0 = Date.now()
/** An engineer on `ticket`, its launch script giving it `base` (none: no script). */
function eng(id: string, ticket: string, base: number | null, status = 'working'): void {
  run("INSERT INTO agents(id, role, ticket_id, model_alias, token_hash, status, started_at) VALUES (?, 'engineer', ?, 'opus', ?, ?, ?)", id, ticket, id, status, t0++)
  if (base === null) return
  fs.mkdirSync(agentDir(id), { recursive: true })
  fs.writeFileSync(path.join(agentDir(id), 'launch.sh'), `#!/bin/bash\nexport HQ_AGENT_ID='${id}'\nexport HQ_PORT_BASE='${base}'\nexport DB_NAME='x'\n`)
}
const slot = (idx: number, holder: string | null, base: number) =>
  run('INSERT INTO worker_slots(idx, agent_id, env) VALUES (?,?,?)', idx, holder, JSON.stringify(slotEnv(idx, base)))
const holders = () => Object.fromEntries(q<{ idx: number; agent_id: string | null }>('SELECT idx, agent_id FROM worker_slots ORDER BY idx').map((r) => [r.idx, r.agent_id]))

test('Bug 422: each cut-short start\'s ports go to the engineer it launched, or are freed; nothing else is touched', () => {
  eng('eng-a', 'tk-a', 13000); slot(1, 'pending-tk-a', 13000) // still running: its ports, by its id now
  eng('eng-b', 'tk-b', 13010, 'exited'); slot(2, 'pending-tk-b', 13010) // ended (or its terminal was found gone at start-up): free
  slot(3, 'pending-tk-c', 13020) // the backend went down before the session began: no engineer, free
  // what it must not catch: an engineer on the ticket whose own launch named other ports, one that holds its own block, one on another ticket
  eng('eng-d1', 'tk-d', 13090); eng('eng-d2', 'tk-d', 13040); slot(4, 'eng-d2', 13040); eng('eng-d3', 'tk-x', 13030); slot(5, 'pending-tk-d', 13030)
  eng('eng-e', 'tk-e', null); slot(6, 'pending-tk-e', 13050) // no launch script to tell: not guessed
  eng('eng-f', 'tk-f', 13060); slot(7, 'eng-f', 13060); slot(8, null, 13070) // ordinary rows stay as they are
  assert.deepEqual(takenSlots().map((r) => r.idx).sort(), [1, 2, 3, 4, 5, 6, 7], 'before: every pending row counts as taken')

  const did = settlePendingSlots()
  assert.deepEqual(did, [{ idx: 1, ticket: 'tk-a', to: 'eng-a' }, { idx: 2, ticket: 'tk-b', to: null }, { idx: 3, ticket: 'tk-c', to: null },
    { idx: 5, ticket: 'tk-d', to: null }, { idx: 6, ticket: 'tk-e', to: null }])
  assert.deepEqual(holders(), { 1: 'eng-a', 2: null, 3: null, 4: 'eng-d2', 5: null, 6: null, 7: 'eng-f', 8: null })
  assert.deepEqual(takenSlots().map((r) => r.idx).sort(), [1, 4, 7])
  // the engineer it went to ends: freed by its id, as any engineer's
  run("UPDATE agents SET status = 'exited' WHERE id = 'eng-a'"); assert.deepEqual(takenSlots().map((r) => r.idx).sort(), [4, 7])
  assert.deepEqual(settlePendingSlots(), [], 'a second start finds nothing to do')
})

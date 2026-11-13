// Bug 98: a tab is sent only the agent values it doesn't have yet (pagefeed.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageFeed } from './pagefeed.ts'

const agent = (patch: Record<string, unknown> | null, id = 'eng-1') => ({ entity: 'agent', id, patch })

test('a hook that changes nothing the page shows sends nothing', () => {
  const f = pageFeed(); f.snapshot([{ id: 'eng-1', status: 'working', in_plan_mode: 0, activity: 'Reading src/a.ts', last_event_at: 1 } as never])
  assert.equal(f.patch(agent({ last_event_at: 2 })), null, 'the time of the last hook')
  assert.equal(f.patch(agent({ mod_seen_at: 3 })), null, 'the mod\'s poll')
  assert.equal(f.patch(agent({ last_event_at: 4, status: 'working', in_plan_mode: 0 })), null, 'a status it already has')
  assert.equal(f.patch(agent({ last_event_at: 5, activity: 'Reading src/a.ts' })), null, 'the same activity line again')
})

test('what changed still goes, and only that: activity, a cleared activity, status, plan mode, steps', () => {
  const f = pageFeed(); f.snapshot([{ id: 'eng-1', status: 'working', in_plan_mode: 1, activity: 'Thinking' } as never])
  assert.deepEqual(f.patch(agent({ last_event_at: 2, status: 'working', activity: 'Editing src/b.ts' }))?.patch, { activity: 'Editing src/b.ts' })
  assert.deepEqual(f.patch(agent({ in_plan_mode: 0 }))?.patch, { in_plan_mode: 0 })
  assert.deepEqual(f.patch(agent({ status: 'idle', activity: null, last_message: 'Done.' }))?.patch, { status: 'idle', activity: null, last_message: 'Done.' })
  assert.equal(f.patch(agent({ activity: null })), null, 'null twice')
  assert.deepEqual(f.patch(agent({ status: 'working', activity: 'Thinking' }))?.patch, { status: 'working', activity: 'Thinking' }, 'back to an older value')
  assert.deepEqual(f.patch(agent({ steps_done: 1, steps_total: 3 }))?.patch, { steps_done: 1, steps_total: 3 }, 'a field the snapshot didn\'t have')
})

test('a new agent arrives whole, a removed one goes, and other rows are never thinned', () => {
  const f = pageFeed(); f.snapshot([])
  const row = { id: 'eng-2', role: 'engineer', status: 'launching', ticket_id: 't1', last_event_at: null, mod_seen_at: null, token_hash: undefined }
  assert.deepEqual(f.patch(agent(row, 'eng-2'))?.patch, { id: 'eng-2', role: 'engineer', status: 'launching', ticket_id: 't1' })
  assert.equal(f.patch(agent({ status: 'launching' }, 'eng-2')), null)
  assert.deepEqual(f.patch(agent(null, 'eng-2')), agent(null, 'eng-2'))
  assert.deepEqual(f.patch(agent({ status: 'launching' }, 'eng-2'))?.patch, { status: 'launching' }, 'gone: the tab has nothing')
  const t = { entity: 'ticket', id: 't1', patch: { status: 'building' } }
  assert.equal(f.patch(t), t); assert.equal(f.patch(t), t)
})

test('a fresh snapshot is what the tab has now; two tabs keep their own', () => {
  const a = pageFeed(), b = pageFeed()
  a.snapshot([{ id: 'eng-1', status: 'working' } as never]); b.snapshot([{ id: 'eng-1', status: 'working' } as never])
  assert.ok(a.patch(agent({ status: 'idle' }))); assert.ok(b.patch(agent({ status: 'idle' })), 'the other tab is told too')
  a.snapshot([{ id: 'eng-1', status: 'working' } as never]) // a reconnect, or a clear
  assert.deepEqual(a.patch(agent({ status: 'idle' }))?.patch, { status: 'idle' })
  assert.equal(b.patch(agent({ status: 'idle' })), null)
})

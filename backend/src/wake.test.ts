// Bug 99: which changes wake an agent's waiting `next` request, and which don't.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentChanged, listen, wake, wakeAll, waitingCount } from './wake.ts'

function waiter(status: string): { w: { status: string; wake: () => void }; woken: () => number } {
  let n = 0; return { w: { status, wake: () => { n++ } }, woken: () => n }
}

test('a wake reaches only that agent\'s waiting requests; wakeAll reaches every one', () => {
  const a = waiter('idle'), b = waiter('idle'); const offA = listen('a', a.w), offB = listen('b', b.w)
  wake('a'); assert.equal(a.woken(), 1); assert.equal(b.woken(), 0)
  wake(null); wake('nobody'); assert.equal(a.woken() + b.woken(), 1)
  wakeAll(); assert.equal(a.woken(), 2); assert.equal(b.woken(), 1)
  offA(); offB(); wakeAll(); assert.equal(a.woken(), 2); assert.equal(waitingCount(), 0)
})

test('a hook writing the same status again wakes nothing; a status change or a hold does', () => {
  const a = waiter('working'); const off = listen('a', a.w)
  agentChanged('a', { status: 'working', last_event_at: 1 }) // every PreToolUse while it works
  agentChanged('a', { mod_seen_at: 2 }); agentChanged('a', { last_event_at: 3, in_plan_mode: 0 })
  assert.equal(a.woken(), 0)
  agentChanged('a', { status: 'idle' }); assert.equal(a.woken(), 1)
  a.w.status = 'paused'; agentChanged('a', { status: 'working' }); assert.equal(a.woken(), 2) // a pause lifted
  agentChanged('a', { takeover_locked_until: 0 }); agentChanged('a', { fresh_start_at: 5 }); assert.equal(a.woken(), 4)
  off()
})

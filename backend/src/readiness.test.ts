// Merge-first readiness: which tickets may start, in what order.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { depsProblem, hasDependents, launchBlocker, readyDependents, readyTickets, unmergedDeps } from './readiness.ts'

const t = (key: string, status: string, deps: string[] = [], assignee: string | null = null) => ({ key, status, deps: JSON.stringify(deps), assignee_agent_id: assignee })

test('a ticket waits until every dependency is merged', () => {
  const all = [t('UI-1', 'pr_open'), t('UI-2', 'queued', ['UI-1']), t('UI-5', 'queued', ['UI-9']), t('UI-7', 'queued', ['UI-1', 'UI-2'])]
  assert.deepEqual(unmergedDeps(all[1]!, all), ['UI-1']) // pushed / PR open is not enough
  assert.deepEqual(unmergedDeps(all[2]!, all), ['UI-9']) // a key with no ticket counts as not merged
  all[0]!.status = 'merged'
  assert.deepEqual(unmergedDeps(all[1]!, all), [])
  assert.deepEqual(unmergedDeps(all[3]!, all), ['UI-2'])
})

test('readyTickets: queued, no engineer, deps merged; merge order first, then key order', () => {
  const all = [t('UI-1', 'pr_open'), t('UI-2', 'queued', ['UI-1']), t('UI-3', 'queued'), t('UI-4', 'queued', []), t('UI-10', 'queued'), t('UI-6', 'queued', [], 'eng-1'), t('UI-8', 'planning'), t('UI-9', 'cancelled')]
  assert.deepEqual(readyTickets(all, []).map((x) => x.key), ['UI-3', 'UI-4', 'UI-10'])
  assert.deepEqual(readyTickets(all, ['UI-10', 'UI-4']).map((x) => x.key), ['UI-10', 'UI-4', 'UI-3'])
  all[0]!.status = 'merged'
  assert.deepEqual(readyTickets(all, []).map((x) => x.key), ['UI-2', 'UI-3', 'UI-4', 'UI-10'])
})

test('launchBlocker: one engineer per ticket; an exited one allows a relaunch', () => {
  const k = (status: string) => ({ key: 'APP-2', status })
  const none = { starting: false, liveEngineer: null }
  assert.equal(launchBlocker(k('queued'), none), null)
  assert.equal(launchBlocker(k('planning'), none), null) // its engineer exited mid-ticket: a relaunch is allowed
  assert.equal(launchBlocker(k('queued'), { starting: true, liveEngineer: null }), 'APP-2 is already starting an engineer')
  assert.equal(launchBlocker(k('planning'), { starting: false, liveEngineer: 'eng-1' }), 'APP-2 already has an engineer (eng-1)')
  assert.equal(launchBlocker(k('cancelled'), { starting: true, liveEngineer: 'eng-1' }), 'APP-2 is cancelled')
  for (const s of ['pr_ready', 'pr_open', 'merged']) assert.equal(launchBlocker(k(s), none), `APP-2 is already finished (${s})`)
})

test('readyDependents: the "Ready now" list of a merge, empty once everything it unblocked has started or been cancelled', () => {
  const k = (key: string, status: string, deps: string[], assignee: string | null = null) => ({ key, status, deps: JSON.stringify(deps), assignee_agent_id: assignee })
  const all = [k('A', 'merged', []), k('B', 'queued', ['A']), k('C', 'queued', ['A', 'X']), k('X', 'implementing', [], 'eng-x'), k('D', 'queued', [])]
  assert.deepEqual(readyDependents('A', all, []).map((t) => t.key), ['B']) // C still waits on X; D doesn't wait on A
  assert.ok(hasDependents('A', all)); assert.ok(!hasDependents('D', all))
  all[1] = k('B', 'planning', ['A'], 'eng-b') // B started
  assert.deepEqual(readyDependents('A', all, []), [])
  all[1] = k('B', 'cancelled', ['A']); all[2] = k('C', 'cancelled', ['A', 'X'])
  assert.ok(!hasDependents('A', all)) // cancelled tickets don't count as waiting
})

test('depsProblem (Bug 50): itself, unknown, removed and loops are refused; a fine list is null', () => {
  const t = (key: string, deps: string[] = [], status = 'queued') => ({ key, status, assignee_agent_id: null, deps: JSON.stringify(deps) })
  const all = [t('T1', [], 'merged'), t('T2', ['T1']), t('T3', [], 'cancelled'), t('T4', ['T3']), t('T5', ['T4'])]
  assert.equal(depsProblem('T4', ['T2'], all), null)
  assert.equal(depsProblem('T4', [], all), null)
  assert.match(depsProblem('T4', ['T4'], all)!, /can't wait on itself/)
  assert.match(depsProblem('T4', ['T9'], all)!, /no ticket T9/)
  assert.match(depsProblem('T4', ['T3'], all)!, /T3 was removed/)
  assert.equal(depsProblem('T4', ['T5'], all), 'that makes a loop: T4 → T5 → T4')
  assert.equal(depsProblem('T2', ['T5'], all), null) // T5 → T4 → T3 (removed): no way back to T2
})

// The UI's "needs you" list (Bug 24, frontend/src/needs.ts): what counts in the tab title and what pops up a notification.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goodNews, keysText, needsYou, newNeeds, titleFor, yourTurn } from '../../frontend/src/needs.ts'

const state = () => ({
  repos: [{ id: 'r1', name: 'demo' }, { id: 'r2', name: 'api-server' }],
  features: [{ id: 'f1', repo_id: 'r1', status: 'planning' }, { id: 'f2', repo_id: 'r2', status: 'planning' }, { id: 'f3', repo_id: 'r1', status: 'cancelled' }],
  tickets: [{ id: 't1', key: 'T1', feature_id: 'f1' }, { id: 't2', key: 'T2', feature_id: 'f1' }, { id: 't3', key: 'T3', feature_id: 'f2' }, { id: 't4', key: 'T4', feature_id: 'f3' }],
  agents: [{ id: 'tpm-2', feature_id: 'f2' }],
  reviews: [{ id: 'R-1', ticket_id: 't1', status: 'open' }, { id: 'R-0', ticket_id: 't1', status: 'superseded' }],
  attention: [{ id: 1, kind: 'stuck', agent_id: 'tpm-2', detail: 'TPM search: no events for 10 min' }, { id: 2, kind: 'merged', ticket_id: 't2', detail: 'T2 merged.' },
    { id: 3, kind: 'blocked', ticket_id: 't2', detail: 'eng T2: needs a key', resolved_at: 5 }],
})
const acts: Record<string, 'merge' | 'fix'> = { t2: 'merge', t3: 'fix', t4: 'merge' }

test('needsYou: plans waiting, finished tickets and alerting notices, in every repo, each named by its repo', () => {
  assert.deepEqual(needsYou(state(), (t) => acts[t.id] ?? null).map((n) => [n.key, n.text, n.repoId]), [
    ['review:R-1', "demo: T1's plan is waiting for you", 'r1'],
    ['merge:t2', 'demo: T2 is finished and waiting for you to merge it', 'r1'],
    ['fix:t3', 'api-server: T3 clashes with main: press Fix conflicts', 'r2'],
    ['attention:1', 'api-server: TPM search: no events for 10 min', 'r2'], // stuck alerts; "merged" (info), a resolved one and a cancelled feature don't
  ])
})

test('Bug 61: a run\'s finished and stopped notices count for their project, and go from the count once resolved', () => {
  const s = { ...state(), reviews: [], attention: [{ id: 9, kind: 'auto_finished:r1', detail: 'demo: auto mode finished (T1).' },
    { id: 10, kind: 'auto_stopped:r2', detail: 'api-server: auto mode stopped.' }] }
  const open = (x: typeof s) => needsYou(x, () => null).map((n) => [n.key, n.repoId])
  assert.deepEqual(open(s), [['attention:9', 'r1'], ['attention:10', 'r2']]); assert.equal(titleFor(open(s).length), '(2) HQ')
  const read = { ...s, attention: s.attention.slice(1) } // what the UI holds once the patch with resolved_at has come in
  assert.deepEqual(open(read), [['attention:10', 'r2']]); assert.equal(titleFor(open(read).length), '(1) HQ')
})

test('goodNews (Bug 61): finished and merged are green; anything that may need the user is not', () => {
  for (const k of ['merged', 'conflicts_fixed', 'auto_finished:r1']) assert.equal(goodNews(k), true, k)
  for (const k of ['auto_stopped:r1', 'auto_parked', 'message_for_user', 'blocked', 'dialog', 'repo_cleared:r1', 'backend_error']) assert.equal(goodNews(k), false, k)
})

test('newNeeds: nothing pops up on the first look (page load, reconnect); later only what is new', () => {
  const s = state(), now = needsYou(s, (t) => acts[t.id] ?? null)
  const first = newNeeds(null, now); assert.deepEqual(first.fresh, [])
  assert.deepEqual(newNeeds(first.seen, now).fresh, []) // the same items again (a reconnect snapshot)
  s.reviews.push({ id: 'R-2', ticket_id: 't2', status: 'open' })
  const later = newNeeds(first.seen, needsYou(s, (t) => acts[t.id] ?? null))
  assert.deepEqual(later.fresh.map((n) => n.key), ['review:R-2'])
  assert.ok(later.seen.has('review:R-2') && later.seen.has('review:R-1'))
})

test('titleFor: "(N) HQ" while something needs you, plain "HQ" otherwise', () => {
  assert.equal(titleFor(0), 'HQ'); assert.equal(titleFor(3), '(3) HQ')
})

test('yourTurn (Bug 43, Bug 52): the project TPM\'s open questions, and every feature\'s ready tickets in merge order when a slot is free', () => {
  const f = { id: 'f1', repo_id: 'r1', status: 'planning', merge_order: '["T2","T1"]', created_at: 1 }
  const s = {
    repos: [{ id: 'r1', name: 'notes' }, { id: 'r2', name: 'other' }], reviews: [], attention: [],
    features: [f, { id: 'f9', repo_id: 'r1', status: 'cancelled', created_at: 2 }, { id: 'f4', repo_id: 'r1', status: 'planning', merge_order: '[]', created_at: 3 }],
    tickets: [{ id: 't1', key: 'T1', feature_id: 'f1', status: 'queued', assignee_agent_id: null, deps: '[]' },
      { id: 't2', key: 'T2', feature_id: 'f1', status: 'queued', assignee_agent_id: null, deps: '[]' },
      { id: 't3', key: 'T3', feature_id: 'f1', status: 'queued', assignee_agent_id: null, deps: '["T1"]' },
      { id: 't9', key: 'T9', feature_id: 'f9', status: 'queued', assignee_agent_id: null, deps: '[]' },
      { id: 't4', key: 'T4', feature_id: 'f4', status: 'queued', assignee_agent_id: null, deps: '[]' }],
    agents: [] as any[], settings: { concurrency_cap: 1 },
    asks: [{ id: 'ask-1', repo_id: 'r1', feature_id: null, question: 'Dark or light?', choices: '["Dark","Light"]', answered_at: null },
      { id: 'ask-2', repo_id: 'r1', question: 'Old one', choices: '[]', answered_at: 5 }, { id: 'ask-9', repo_id: 'r2', question: 'Elsewhere', choices: '[]', answered_at: null }],
  }
  assert.deepEqual(yourTurn(s, 'r1'), { asks: [{ id: 'ask-1', question: 'Dark or light?', choices: ['Dark', 'Light'], action: false }], start: ['T2', 'T1', 'T4'] }) // f9 is cancelled
  const full = { ...s, agents: [{ id: 'e1', role: 'engineer', status: 'working', ticket_id: 'tx' }] }
  assert.deepEqual(yourTurn(full, 'r1').start, [], 'the parallel limit is full: nothing to press')
  assert.deepEqual(yourTurn({ ...full, working: 0 }, 'r1').start, ['T2', 'T1', 'T4'], 'forRepo\'s count of every repo wins')
  const finished = { ...full, tickets: [...s.tickets, { id: 'tx', key: 'TX', feature_id: 'f8', status: 'pr_ready', assignee_agent_id: 'e1', deps: '[]' }] }
  assert.deepEqual(yourTurn(finished, 'r1').start, ['T2', 'T1', 'T4'], 'a finished engineer doesn\'t use a slot')
  assert.deepEqual(needsYou(s, () => null).map((n) => [n.key, n.text, n.ref]), [
    ['ask:ask-1', 'notes: the TPM asked: Dark or light?', { tpm: 'r1' }], ['start:r1:T2,T1,T4', 'notes: T2, T1 and T4 are ready to start', { tpm: 'r1' }],
    ['ask:ask-9', 'other: the TPM asked: Elsewhere', { tpm: 'r2' }]])
  assert.deepEqual([keysText(['T1']), keysText(['T1', 'T2', 'T3'])], ['T1', 'T1, T2 and T3'])
})

test('yourTurn (Bug 50): a ticket the TPM asked to remove is not offered to start alongside "Remove it"', () => {
  const t = (id: string, key: string) => ({ id, key, feature_id: 'f1', status: 'queued', assignee_agent_id: null, deps: '[]' })
  const s = { repos: [], features: [{ id: 'f1', repo_id: 'r1', status: 'planning', merge_order: '[]', created_at: 1 }], agents: [], reviews: [], attention: [],
    tickets: [t('a', 'T1'), t('b', 'T2')], settings: { concurrency_cap: 2 },
    asks: [{ id: 'ask-1', repo_id: 'r1', feature_id: 'f1', question: 'Remove T1?', choices: '["Remove it","Keep it"]', action: '{"kind":"cancel_ticket","ticket":"a"}', answered_at: null }] }
  const turn = yourTurn(s as any, 'r1')
  assert.deepEqual(turn.start, ['T2']); assert.equal(turn.asks[0]!.action, true)
})

// The findings loop's rules (findingrules.ts): what makes two findings the same one, what a run's findings add, the user's decisions, two strikes, replays
// judged in code, and the words. Pure: no DB, no processes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { afterCheck, decide, fromTester, ticketGone, dueForReplay, findingKey, findingLines, judgeInCode, MAX_PER_RUN,
   stepWords, take, ticketBlock, toSend, type Fresh, type Kept } from './findingrules.ts'
import type { Step } from './loopinputs.ts'

const add: Step[] = [{ action: 'navigate', url: '/?tab=reading' }, { action: 'fill', role: 'textbox', name: 'Item', text: 'Dune' }, { action: 'click', role: 'button', name: 'Add' }]
const dupFlag = { kind: 'duplicate' as const, method: 'POST', path: '/api/reading/fill', why: 'POST /api/reading/fill twice within 2 ms' }
const ui = (what = 'Pressing Add gives no sign anything happened.', o: Partial<Fresh> = {}): Fresh =>
  ({ source: 'ui', by: 'tester', what, expected: 'The new item shows in the list at once.', criterion: 'T-01 A1', steps: add, evidence: { scenario: 's-01', rows: [], flags: [] }, ...o })
const be = (o: Partial<Fresh> = {}): Fresh => ({ source: 'backend', by: 'checker', what: 'Fill from wishlist added Emma twice.', expected: 'One Emma record.', criterion: 'T-02 A3', steps: add,
  evidence: { scenario: 's-02', rows: ['| 14:02:05.011 | api | POST /api/reading/fill → 200 ⚠ 2x |'], flags: [dupFlag] }, ...o })
const kept = (f: Fresh, o: Partial<Kept> = {}): Kept => ({ ...take([], [f], { repoId: 'r1', runId: 'run1', next: 1 }).add[0]!, ...o })
const noRule = () => null

test('the same finding is the same whatever words the model used; the key comes from steps, flags and criterion', () => {
  assert.equal(findingKey(ui()), findingKey(ui('Nothing tells you the item went in after Add.')))
  assert.equal(findingKey(ui()), findingKey(ui('x', { steps: add.map((s) => s.action === 'fill' ? { ...s, text: 'bread' } : s) }))) // typed differently: same place
  assert.notEqual(findingKey(ui()), findingKey(ui('x', { steps: [...add.slice(0, 2), { action: 'click', role: 'button', name: 'Clear' }] })))
  assert.notEqual(findingKey(ui()), findingKey(ui('x', { criterion: 'T-01 A2' })))
  assert.equal(findingKey(be()), 'backend|duplicate|POST /api/reading/fill') // a flag-led backend finding is its flag on its endpoint, whatever the steps
  assert.equal(findingKey(be({ steps: [] })), findingKey(be()))
  assert.notEqual(findingKey(be()), findingKey(ui('x', { evidence: be().evidence }))) // a UI finding never keys by a flag
})
test('a run\'s findings: new ones get ids, the same one again is "seen again", an ignored or fine one never comes back, one being fixed waits for its replay', () => {
  const first = take([], [ui(), be(), ui('Same thing in other words, Add says nothing.')], { repoId: 'r1', runId: 'run1', next: 1 })
  assert.deepEqual(first.add.map((k) => k.id), ['P-1', 'P-2']); assert.equal(first.dropped, 1)
  const [p1, p2] = first.add as [Kept, Kept]
  const again = take([p1, p2], [ui('Add: no feedback.')], { repoId: 'r1', runId: 'run2', next: 3 })
  assert.deepEqual(again.add, []); assert.deepEqual(again.seen.map((k) => [k.id, k.runs]), [['P-1', ['run1', 'run2']]])
  const back = take([{ ...p1, state: 'fixed', tickets: ['T-05'] }], [ui()], { repoId: 'r1', runId: 'run3', next: 3 }) // a fixed one seen again: a regression
  assert.deepEqual([back.add.length, back.seen[0]?.state, back.seen[0]?.strikes, back.seen[0]?.checks.at(-1)?.result], [0, 'new', 1, 'broken']); assert.match(back.seen[0]!.back!, /found it again/)
  for (const state of ['closed', 'fixing', 'sent', 'flagged'] as const) {
    const r = take([{ ...p1, state }], [ui()], { repoId: 'r1', runId: 'run3', next: 3 }); assert.deepEqual([r.add.length, r.seen.length, r.dropped], [0, 0, 1], state)
  }
  const many = Array.from({ length: MAX_PER_RUN + 4 }, (_, i) => ui(`Problem number ${i} with the list.`, { criterion: `T-01 A${i + 1}` }))
  const capped = take([], many, { repoId: 'r1', runId: 'run1', next: 1 }); assert.equal(capped.add.length, MAX_PER_RUN); assert.equal(capped.dropped, 4)
})
test('the user\'s decisions: wording, Fix, Ignore, a rule only where no criterion covers it, and nothing on a finding broken twice', () => {
  const k = kept(ui())
  const fixed = decide(k, 'fix', { wording: '  Add  shows nothing happened. ' }, noRule); assert.ok(!('error' in fixed))
  assert.equal(fixed.decision, 'fix'); assert.equal(fixed.wording, 'Add shows nothing happened.')
  assert.match((decide(k, 'fix', { wording: 'bad' }, noRule) as { error: string }).error, /at least 10/)
  assert.match((decide(k, 'rule', { rule: 'When an item is added, it shows.' }, noRule) as { error: string }).error, /already breaks a criterion \(T-01 A1\)/)
  const un = kept(ui('Two tabs show different lists after an add.', { source: 'unspecified', criterion: undefined }))
  assert.match((decide(un, 'rule', {}, noRule) as { error: string }).error, /Write the rule/)
  assert.match((decide(un, 'rule', { rule: 'It works well' }, () => 'too vague') as { error: string }).error, /too vague/)
  const ruled = decide(un, 'rule', { rule: 'When an item is added in one tab, the other tab shows it after a reload.' }, noRule); assert.ok(!('error' in ruled) && ruled.rule)
  const back = decide(fixed as Kept, null, {}, noRule); assert.ok(!('error' in back)); assert.equal(back.decision, undefined); assert.equal(back.wording, 'Add shows nothing happened.')
  assert.match((decide({ ...k, state: 'flagged' }, 'fix', {}, noRule) as { error: string }).error, /won't make another/)
  assert.match((decide({ ...k, state: 'fixing' }, 'ignore', {}, noRule) as { error: string }).error, /being fixed/)
  const s = toSend([{ ...k, decision: 'fix' }, { ...k, id: 'P-2', decision: 'ignore' }, { ...k, id: 'P-3' }, { ...k, id: 'P-4', decision: 'rule' }, { ...k, id: 'P-5', decision: 'fine' }])
  assert.deepEqual([s.send.map((x) => x.id), s.close.map((x) => x.id)], [['P-1', 'P-4'], ['P-2', 'P-5']])
})
test('a replay: fixed is done; broken once goes back to the user as still broken; broken after two tickets is flagged, and unknown changes nothing', () => {
  const k: Kept = { ...kept(be()), state: 'fixing', tickets: ['T-05'], decision: 'fix', sent_at: 1 }
  const c = (result: 'fixed' | 'broken' | 'unknown', run = 'run2') => ({ run, at: 10, result, how: 'replay' as const, why: 'w' })
  assert.equal(afterCheck(k, c('fixed')).state, 'fixed')
  const once = afterCheck(k, c('broken')); assert.deepEqual([once.state, once.strikes, once.decision, once.sent_at], ['new', 1, undefined, undefined])
  const twice = afterCheck({ ...once, state: 'fixing', tickets: ['T-05', 'T-07'] }, c('broken', 'run3')); assert.deepEqual([twice.state, twice.strikes], ['flagged', 2])
  const unk = afterCheck(k, c('unknown')); assert.equal(unk.state, 'fixing'); assert.equal(unk.checks.length, 1)
  assert.equal(afterCheck(unk, c('fixed')).checks.length, 1) // one look per run: the later one replaces it
})
test('a cancelled or undone fix ticket sends its finding back to the user, with no strike; only the tester\'s own findings count as the tester\'s', () => {
  const k: Kept = { ...kept(be()), state: 'fixing', tickets: ['T-05'], decision: 'fix', sent_at: 1 }
  const b = ticketGone(k, 'T-05', 'its fix ticket T-05 was cancelled')!
  assert.deepEqual([b.state, b.tickets, b.strikes, b.decision, b.back], ['new', [], 0, undefined, 'its fix ticket T-05 was cancelled'])
  assert.equal(ticketGone({ ...k, state: 'fixed' }, 'T-05', 'undone')!.state, 'new') // a run undone takes its fix out of main
  assert.equal(ticketGone({ ...k, tickets: ['T-03', 'T-05'], strikes: 1 }, 'T-05', 'x')!.strikes, 1)
  assert.equal(ticketGone(k, 'T-09', 'x'), null); assert.equal(ticketGone({ ...k, state: 'closed' }, 'T-05', 'x'), null)
  assert.equal(fromTester(kept(ui())), true); assert.equal(fromTester(kept(ui('A UI problem the checker saw in the recording.', { by: 'checker' }))), false)
  assert.equal(fromTester({ source: 'ui' } as Kept), true); assert.equal(fromTester({ source: 'backend' } as Kept), false) // kept before `by` existed
})
test('a replay is due once every ticket of a finding has merged, and only once after the last one', () => {
  const k: Kept = { ...kept(be()), state: 'fixing', tickets: ['T-05'] }, merged = (at: Record<string, number>) => (key: string) => at[key] ?? null
  assert.equal(dueForReplay([k], merged({})).length, 0)
  assert.equal(dueForReplay([k], merged({ 'T-05': 100 })).length, 1)
  assert.equal(dueForReplay([{ ...k, checks: [{ run: 'r', at: 150, result: 'broken', how: 'replay', why: '' }] }], merged({ 'T-05': 100 })).length, 0)
  assert.equal(dueForReplay([{ ...k, checks: [{ run: 'r', at: 150, result: 'unknown', how: 'replay', why: '' }] }], merged({ 'T-05': 100 })).length, 1) // unknown: look again
  assert.equal(dueForReplay([{ ...k, state: 'new' }], merged({ 'T-05': 100 })).length, 0)
})
test('code judges a replay where it can: the flag on the same endpoint, or every expect on the page; else nobody can tell in code', () => {
  const k = kept(be())
  assert.deepEqual(judgeInCode(k, { flags: [] })?.result, 'fixed')
  assert.deepEqual(judgeInCode(k, { flags: [{ ...dupFlag, path: '/api/items' }] })?.result, 'fixed') // another endpoint's flag isn't this finding
  assert.match(judgeInCode(k, { flags: [dupFlag] })!.why, /again: POST \/api\/reading\/fill twice/)
  const u = kept(ui('x is wrong with it', { expect: [{ role: 'listitem', name: 'Dune', visible: true }] }))
  assert.equal(judgeInCode(u, { flags: [], expect: [{ ok: true }] })?.result, 'fixed')
  assert.match(judgeInCode(u, { flags: [], expect: [{ ok: false }] })!.why, /the "Dune" listitem shows is still not true/)
  assert.equal(judgeInCode(kept(ui()), { flags: [] }), null)
  assert.equal(judgeInCode(kept(be({ evidence: { scenario: 's', rows: [], flags: [] } })), { flags: [] }), null)
})
test('the words: steps as a person says them, the fix ticket\'s block, and the summary\'s lines', () => {
  assert.deepEqual(add.map(stepWords), ['open /?tab=reading', 'type "Dune" into the "Item" box', 'click the "Add" button'])
  assert.equal(stepWords({ action: 'back' }), 'go back'); assert.equal(stepWords({ action: 'press', text: 'Escape' }), 'press Escape')
  const k: Kept = { ...kept(be()), wording: 'Emma ends up on the list twice.', strikes: 1, tickets: ['T-05'],
    checks: [{ run: 'r2', at: 1, result: 'broken', how: 'replay', why: 'the replay showed it again' }] }
  const b = ticketBlock(k)
  for (const s of ['## Finding P-1 (behind the screen)', "What's wrong: Emma ends up on the list twice.", 'It breaks: T-02 A3', '1. open /?tab=reading', '⚠ 2x', 'T-05', 'replays these steps'])
    assert.ok(b.includes(s), s)
  const all: Kept[] = [
    { ...kept(ui()), id: 'P-1', state: 'fixed', checks: [{ run: 'run2', at: 1, result: 'fixed', how: 'replay', why: '' }] },
    { ...kept(be()), id: 'P-2', state: 'new', tickets: ['T-05'], strikes: 1, checks: [{ run: 'run2', at: 1, result: 'broken', how: 'replay', why: 'seen again' }] },
    { ...kept(be()), id: 'P-3', state: 'flagged', tickets: ['T-05', 'T-07'], strikes: 2, checks: [{ run: 'run2', at: 1, result: 'broken', how: 'checker', why: 'still two' }] },
    { ...kept(ui('Clear has no confirm step at all.')), id: 'P-4', first_run: 'run2', runs: ['run2'] },
    { ...kept(ui('Old problem seen again in this run.')), id: 'P-5', runs: ['run1', 'run2'] },
    { ...kept(ui('Not this run at all.')), id: 'P-6' },
  ]
  const lines = findingLines(all, 'run2'), starts = ['- ✓ P-1 fixed:', '- ✗ P-2 still broken after T-05', '- ⚑ P-3 still broken after 2', '- New P-4 (on the screen, T-01 A1)', '- Seen again P-5:']
  assert.equal(lines.length, starts.length); starts.forEach((st, i) => assert.ok(lines[i]!.startsWith(st), lines[i]))
  assert.match(findingLines(all, 'run2')[2]!, /won't make a third/)
})

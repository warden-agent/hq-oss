// The tester's rules (testerrules.ts): which of a run's features it tries, what it is told, what of its report HQ keeps whatever it wrote, and the summary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepReport, testerPrompt, toTry, triedLines, triedOf, type Tried } from './testerrules.ts'
import type { Criterion } from './criteria.ts'

const ui = (id: string, text: string): Criterion => ({ id, kind: 'ui', text }), be = (id: string, text: string): Criterion => ({ id, kind: 'backend', text })
const F = [{ id: 'f1', handle: 'F-1', title: 'Due dates' }, { id: 'f2', handle: 'F-2', title: 'Reading list' }, { id: 'f3', handle: null, title: 'An old feature' }]
const merged = [
  { id: 't1', key: 'T-01', feature_id: 'f1', criteria: [be('A1', 'The API returns due_on.'), ui('A2', 'The list shows each due date.')] },
  { id: 't2', key: 'T-02', feature_id: 'f1', criteria: [ui('A1', 'Books near their due date say "Due soon".')] },
  { id: 't3', key: 'T-03', feature_id: 'f2', criteria: [be('A1', 'Lists are saved.')] }, // nothing for a browser
  { id: 't4', key: 'T-04', feature_id: 'f3', criteria: [ui('A1', 'The page has a title.')] },
  { id: 't5', key: 'T-05', feature_id: 'f2', criteria: [] }, // a ticket from before criteria were a list
]
test('what the tester tries: per feature, the screen criteria of the run\'s merged tickets that nobody has tried yet', () => {
  assert.deepEqual(toTry(merged, F, new Set()), [
    { featureId: 'f1', handle: 'F-1', title: 'Due dates', tickets: ['t1', 't2'],
      criteria: [{ id: 'T-01 A2', text: 'The list shows each due date.' }, { id: 'T-02 A1', text: 'Books near their due date say "Due soon".' }] },
    { featureId: 'f3', handle: 'An old feature', title: 'An old feature', tickets: ['t4'], criteria: [{ id: 'T-04 A1', text: 'The page has a title.' }] }])
  assert.deepEqual(toTry(merged, F, new Set(['t1', 't4'])).map((x) => [x.handle, x.tickets]), [['F-1', ['t2']]]) // the run went on after an earlier try
  assert.deepEqual(toTry(merged, F, new Set(['t1', 't2', 't4'])), []); assert.deepEqual(toTry([], F, new Set()), [])
})
test('what it is told: the feature, its criteria by ticket and id, the cap and the date', () => {
  const [f] = toTry(merged, F, new Set())
  assert.equal(testerPrompt(f!, 15, '2026-11-17'), '## What was built: Due dates\n- T-01 A2 (screen): The list shows each due date.\n- T-02 A1 (screen): Books near their due date say "Due soon".\n\n'
    + 'The app\'s start page is "/". You have 15 actions. Today is 2026-11-17.\n')
})
test('of its report HQ keeps problems about the criteria it was given, at most five, each cut to size; the rest is dropped', () => {
  const ids = ['T-01 A2', 'T-02 A1', 'T-03 A3']
  const p = (criterion: string, what = 'Dune is due back tomorrow and has no "Due soon" label.', steps: unknown = ['Open /', 'Look at Dune']) => ({ criterion, what, steps })
  const said = [p('T-01 A2'), p('t-02a1'), p('A3'), p('A1'), p('A2'), p('T-09 A1'), p('T-01 A2', 'Bad.'), 'nonsense', null]
  const r = keepReport({ tried: ['Opened the list', '', 7, 'x'.repeat(300)], problems: said }, ids)
  assert.deepEqual(r.problems.map((x) => x.criterion), ['T-01 A2', 'T-02 A1', 'T-03 A3', 'T-02 A1', 'T-01 A2']) // a bare id counts when only one ticket has it
  assert.deepEqual(r.tried, ['Opened the list', '7', 'x'.repeat(160)]); assert.deepEqual(r.problems[0]!.steps, ['Open /', 'Look at Dune'])
  assert.deepEqual(keepReport({ problems: [p('A1')] }, ['T-01 A1', 'T-02 A1']).problems, []) // which A1? it doesn't say
  assert.equal(keepReport({ problems: Array.from({ length: 9 }, () => p('T-01 A2')) }, ids).problems.length, 5)
  assert.deepEqual(keepReport({ problems: [p('T-01 A2', 'w'.repeat(900), Array.from({ length: 20 }, (_, i) => `step ${i} ${'s'.repeat(200)}`))] }, ids).problems.map((x) =>
    [x.what.length, x.steps.length, x.steps[0]!.length]), [[400, 8, 120]])
  for (const raw of [null, 'done', 5, {}, { tried: 'all of it', problems: 'none' }]) assert.deepEqual(keepReport(raw, ids), { tried: [], problems: [] })
})
test('the summary: a line per feature, each problem under it with its steps; a try HQ couldn\'t have says why, unless that is just how the project is set up', () => {
  const base = { feature: 'F-1', title: 'Due dates', tickets: ['t1'] }, cost = { actions: 6, ms: 12_000, tokens: 20_000, model: 'sonnet' }
  const all: Tried[] = [
    { ...base, state: 'tried', tried: ['a', 'b', 'c', 'd'], problems: [{ criterion: 'T-01 A2', what: 'Dune is due back tomorrow and has no label.', steps: ['Open /', 'Look at Dune'] },
      { criterion: 'T-02 A1', what: 'No message for an empty name.', steps: [] }], ...cost },
    { feature: 'F-2', title: 'Reading list', tickets: ['t3'], state: 'tried', tried: ['a'], problems: [], ...cost, actions: 1 },
    { feature: 'F-3', title: 'Reminders', tickets: ['t4'], state: 'skipped', why: "the tester couldn't be asked (API Error: Overloaded)" },
    { feature: 'F-4', title: 'Quiet', tickets: ['t5'], state: 'skipped', why: 'HQ has no start steps for this project', quiet: true }]
  assert.deepEqual(triedLines(all), ['- F-1 Due dates: tried 4 things in 6 actions, found 2 problems', '  - T-01 A2: Dune is due back tomorrow and has no label. (Open / → Look at Dune)',
    '  - T-02 A1: No message for an empty name.', '- F-2 Reading list: tried 1 thing in 1 action, found nothing wrong',
    "- F-3 Reminders: not tried: the tester couldn't be asked (API Error: Overloaded)"])
  assert.deepEqual(triedLines([]), []); assert.deepEqual(triedOf(null), []); assert.deepEqual(triedOf('not json'), []); assert.deepEqual(triedOf(JSON.stringify(all)), all)
})

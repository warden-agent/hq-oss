import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costOf, keepPlan, keepReport, knownCriterion, numbered, onPage, stepOf, stepsOf, stepWords, uiTestLines, whatsNew, type Scenario, type UiTest } from './uitesterrules.ts'

const O = 'http://localhost:4321'
test('steps come from the code the browser ran, in a form a script can replay: role and name, label, text, the value typed, the path opened', () => {
  assert.deepEqual(stepOf(`await page.goto('${O}/#reading');`, O), { action: 'navigate', url: '/#reading', code: `await page.goto('${O}/#reading')` })
  assert.deepEqual(stepOf(`await page.goto('${O}');`, O)?.url, '/')
  assert.deepEqual(stepOf("await page.getByRole('button', { name: 'Add' }).click();", O), { action: 'click', role: 'button', name: 'Add',
    code: "await page.getByRole('button', { name: 'Add' }).click()" })
  assert.deepEqual(stepOf("await page.getByRole('textbox', { name: 'Item\\'s name' }).fill('Dune');", O), { action: 'fill', role: 'textbox', name: 'Item\'s name', value: 'Dune',
    code: "await page.getByRole('textbox', { name: 'Item\\'s name' }).fill('Dune')" })
  assert.deepEqual(stepOf("await page.getByRole('textbox', { name: 'Name' }).press('Enter');", O)?.value, 'Enter')
  assert.deepEqual(stepOf("await page.keyboard.press('Escape');", O), { action: 'press', value: 'Escape', code: "await page.keyboard.press('Escape')" })
  assert.deepEqual(stepOf("await page.getByLabel('Quantity').fill('2');", O), { action: 'fill', label: 'Quantity', value: '2', code: "await page.getByLabel('Quantity').fill('2')" })
  assert.deepEqual(stepOf("await page.getByText('Fill from wishlist').click();", O)?.text, 'Fill from wishlist')
  assert.deepEqual(stepOf("await page.getByRole('combobox', { name: 'Shop' }).selectOption(['Aldi']);", O)?.value, 'Aldi')
  assert.deepEqual(stepOf("await page.getByRole('checkbox', { name: 'Dune' }).check();", O)?.action, 'check')
  assert.deepEqual(stepOf("await page.getByRole('row', { name: 'Dune' }).getByRole('button', { name: 'Remove' }).dblclick();", O)?.role, 'row') // the first locator names it
  assert.deepEqual(stepOf('await page.goBack();', O), { action: 'back', code: 'await page.goBack()' })
  // What isn't a step: a screenshot, a wait, a comment
  assert.equal(stepOf("await page.screenshot({ path: 'x.png' });", O), null); assert.equal(stepOf('// Screenshot viewport', O), null)
  assert.equal(stepOf("await page.getByText('Saved').waitFor();", O), null)
  const answer = "### Ran Playwright code\n```js\nawait page.getByRole('textbox', { name: 'Name' }).fill('Dune');\nawait page.getByRole('button', { name: 'Add' }).click();\n```\n### Page\n- x"
  assert.deepEqual(stepsOf(answer, O).map((s) => s.action), ['fill', 'click']); assert.deepEqual(stepsOf('### Error\nRef e5 not found', O), [])
  assert.equal(stepWords(stepsOf(answer, O)[0]!), 'type "Dune" in textbox "Name"'); assert.equal(stepWords({ action: 'navigate', url: '/', code: '' }), 'open /')
})

test('what\'s new is the run\'s screen criteria in plain words, named so a finding can point at one; nothing behind the screen', () => {
  const n = whatsNew([{ key: 'T-01', title: 'Add', criteria: [{ id: 'A1', kind: 'ui', text: 'Shows Dune ×2.' }, { id: 'A2', kind: 'backend', text: 'One record.' }] },
    { key: 'T-02', title: 'Tick', criteria: [{ id: 'A1', kind: 'ui', text: 'Crossed out.' }] }])
  assert.deepEqual(n, { lines: ['- [T-01 A1] Shows Dune ×2.', '- [T-02 A1] Crossed out.'], ids: ['T-01 A1', 'T-02 A1'] })
  assert.equal(knownCriterion('t-01 a1', n.ids), 'T-01 A1'); assert.equal(knownCriterion('A1', n.ids), null) // two tickets have an A1: which one?
  assert.equal(knownCriterion('[T-02 A1]', n.ids), 'T-02 A1')
})

test('the plan HQ keeps: at most n scenarios of the three kinds, none twice, each with a goal; retries go first; numbered', () => {
  const raw = { scenarios: [
    { kind: 'basic', title: 'Add Dune', goal: 'Add Dune ×2 and see it in the list.', criteria: ['T-01 A1', 'Z9'] },
    { kind: 'weird', title: 'Add Dune again', goal: 'add Dune ×2, and see it in the list' }, // the same goal
    { kind: 'clever', title: 'Hack', goal: 'Read the source code of the page.' }, // not a kind
    { kind: 'complex', title: 'X', goal: 'Too short a title.' }, { kind: 'weird', title: 'Empty', goal: 'Short.' },
    { kind: 'weird', title: 'Empty name', goal: 'Press Add with no name and see what happens.' },
    { kind: 'complex', title: 'Wish and read', goal: 'Wish for a book, fill the list from the wishlist, and read it.' }] }
  const plan = keepPlan(raw, 2, ['T-01 A1'], [{ title: 'Again: no message', goal: 'Press Add with no name. Expected: a message.' }])
  assert.deepEqual(plan.map((s) => [s.id, s.kind, s.title, s.criteria ?? null]), [['s-01', 'retry', 'Again: no message', null], ['s-02', 'basic', 'Add Dune', ['T-01 A1']],
    ['s-03', 'weird', 'Empty name', null]])
  assert.deepEqual(keepPlan('nonsense', 30, []), []); assert.deepEqual(keepPlan({ scenarios: 'x' }, 30, []), [])
})

const S: Scenario = { id: 's-04', kind: 'weird', title: 'Empty name', goal: 'Press Add with no name.' }
const nav = { action: 'navigate' as const, url: '/', code: 'g' }, type = { action: 'fill' as const, role: 'textbox', name: 'Name', value: '', code: 'f' },
  add = { action: 'click' as const, role: 'button', name: 'Add', code: 'c' }
test('a report: findings of a known kind with something to say, at most three, each with HQ\'s own steps up to the action it names and what HQ saw', () => {
  const pages = [{ after: 1, text: '- textbox "Name" [ref=e2]\n- button "Add" [ref=e3]' }, { after: 3, text: '- alert: Give it a name\n- button "Add"' }]
  const r = keepReport({ outcome: 'problem', notes: ['Hesitated: no hint what Name means', ''], findings: [
    { kind: 'no_feedback', at_step: 3, what: 'Pressing Add showed nothing at first.', expected: 'A message', criterion: 'a1', looked_for: { role: 'alert' } },
    { kind: 'unclear_label', at_step: 2, what: 'The field says Name but wants a product.', expected: 'Product', looked_for: { role: 'button', name: 'Save' } },
    { kind: 'odd', what: 'Not a kind HQ knows of at all.', expected: '' }, { kind: 'broken', what: 'short' },
    { kind: 'broken', at_step: 99, what: 'Some later thing was broken too.', expected: 'x' }, { kind: 'stuck', at_step: 1, what: 'A fourth one, past the cap.', expected: 'x' }] },
  S, [[nav], [type], [add]], pages, ['T-01 A1'])
  assert.equal(r.outcome, 'problem'); assert.deepEqual(r.notes, ['Hesitated: no hint what Name means'])
  assert.deepEqual(r.findings.map((f) => [f.kind, f.steps.length, f.criterion ?? null, JSON.stringify(f.expect ?? null)]), [
    ['no_feedback', 3, 'T-01 A1', '[{"role":"alert","visible":true}]'], // the page it read after the third action has the alert
    ['unclear_label', 2, null, '[{"role":"button","name":"Save","visible":false}]'], // the page before it had no Save button
    ['broken', 3, null, 'null']]) // past the last action: all of them
  assert.equal(r.findings[0]!.scenario, 's-04'); assert.deepEqual(numbered(r.findings).map((f) => f.id), ['U1', 'U2', 'U3'])
  // No findings: "ok" unless it says unspecified; "problem" with nothing HQ could keep has no verdict
  assert.equal(keepReport({ outcome: 'ok' }, S, [], [], []).outcome, 'ok'); assert.equal(keepReport({ outcome: 'unspecified' }, S, [], [], []).outcome, 'unspecified')
  assert.equal(keepReport({ outcome: 'problem', findings: [{ kind: 'nope' }] }, S, [], [], []).outcome, 'unspecified')
  assert.equal(keepReport(null, S, [], [], []).outcome, 'ok')
})

test('an element on the page, from the page text: by role and name, or by text', () => {
  const page = '- generic [ref=e1]:\n  - heading "Library" [level=1]\n  - button "Add" [ref=e7]\n  - text: Nothing to read right now'
  assert.equal(onPage(page, { role: 'button', name: 'Add' }), true); assert.equal(onPage(page, { role: 'button', name: 'Remove' }), false)
  assert.equal(onPage(page, { role: 'heading' }), true); assert.equal(onPage(page, { text: 'Nothing to read' }), true); assert.equal(onPage(page, {}), false)
})

test('what each browser tool counts against: actions, looks or screenshots', () => {
  assert.deepEqual(['click', 'navigate', 'snapshot', 'wait_for', 'take_screenshot'].map(costOf), ['actions', 'actions', 'looks', 'looks', 'screenshots'])
})

test('the summary: a count, each finding with its steps, then one line per scenario that went fine, had no verdict or didn\'t run; a quiet skip says nothing', () => {
  const u: UiTest = { at: 1, state: 'done', model: 'sonnet', tokens: 1, cost_usd: 0, ms: 1, sessions: 1, scenarios: [
    { id: 's-01', kind: 'basic', title: 'Add Dune', outcome: 'ok', actions: 3 }, { id: 's-02', kind: 'weird', title: 'Empty name', outcome: 'problem', actions: 2 },
    { id: 's-03', kind: 'weird', title: 'Double add', outcome: 'unspecified', actions: 4 },
    { id: 's-04', kind: 'complex', title: 'Shop', outcome: 'not_run', actions: 0, why: 'the session ended early' }],
  findings: [{ id: 'U1', scenario: 's-02', kind: 'no_feedback', what: 'Nothing happened.', expected: 'A message', criterion: 'T-01 A2', steps: [nav, add] }] }
  assert.deepEqual(uiTestLines(u), ['- 4 scenarios: 1 fine, 1 finding, 1 unspecified, 1 not run',
    '- U1 (no feedback, s-02 Empty name, T-01 A2): Nothing happened. Expected: A message Steps: open / → click button "Add"',
    '- s-01 Add Dune: fine', '- s-03 Double add: no verdict (the map and criteria don\'t say what should happen)', '- s-04 Shop: not run (the session ended early)'])
  assert.deepEqual(uiTestLines({ at: 1, state: 'skipped', why: 'no start steps', quiet: true }), []); assert.deepEqual(uiTestLines(null), [])
  const long = { ...u, findings: [{ ...u.findings[0]!, steps: [nav, ...Array.from({ length: 10 }, () => add)] }] } // a long chain: the last seven, and how many came before
  assert.match(uiTestLines(long)[1]!, /Steps: \(4 steps before\) → click button "Add"( → click button "Add"){6}$/)
  assert.deepEqual(uiTestLines({ at: 1, state: 'skipped', why: 'the app didn\'t start' }), ['- Not tried: the app didn\'t start'])
})

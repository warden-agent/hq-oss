import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cantTry, costOf, keepPlan, keepReport, knownCriterion, numbered, onPage, PLAN_SCHEMA, stepOf, stepsOf, stepWords, uiTestLines, whatsNew, type Scenario, type UiTest } from './uitesterrules.ts'

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
  assert.deepEqual(stepOf("await page.getByRole('row', { name: 'Dune' }).getByRole('button', { name: 'Remove' }).dblclick();", O), { action: 'click', role: 'button',
    name: 'Remove', css: 'internal:role=row[name="Dune"i] >> internal:role=button[name="Remove"i]',
    code: "await page.getByRole('row', { name: 'Dune' }).getByRole('button', { name: 'Remove' }).dblclick()" }) // the last locator names it, inside the first (Bug 198)
  assert.deepEqual(stepOf('await page.goBack();', O), { action: 'back', code: 'await page.goBack()' })
  // What isn't a step: a screenshot, a wait, a comment
  assert.equal(stepOf("await page.screenshot({ path: 'x.png' });", O), null); assert.equal(stepOf('// Screenshot viewport', O), null)
  assert.equal(stepOf("await page.getByText('Saved').waitFor();", O), null)
  const answer = "### Ran Playwright code\n```js\nawait page.getByRole('textbox', { name: 'Name' }).fill('Dune');\nawait page.getByRole('button', { name: 'Add' }).click();\n```\n### Page\n- x"
  assert.deepEqual(stepsOf(answer, O).map((s) => s.action), ['fill', 'click']); assert.deepEqual(stepsOf('### Error\nRef e5 not found', O), [])
  assert.equal(stepWords(stepsOf(answer, O)[0]!), 'type "Dune" in textbox "Name"'); assert.equal(stepWords({ action: 'navigate', url: '/', code: '' }), 'open /')
})

test('Bug 173: a step the browser ran through locator(\'<selector>\') keeps that selector and which match it took, and reads as what was clicked', () => {
  const remove = "await page.locator('button:has-text(\"Remove\")').first().click()" // as Playwright MCP wrote it in the real run
  assert.deepEqual(stepOf(`${remove};`, O), { action: 'click', css: 'button:has-text("Remove")', nth: 0, code: remove })
  assert.equal(stepWords(stepOf(remove, O)!), 'click the "Remove" button')
  assert.deepEqual(stepOf("await page.locator('li >> text=Dune').nth(2).click();", O), { action: 'click', css: 'li >> text=Dune', nth: 2,
    code: "await page.locator('li >> text=Dune').nth(2).click()" })
  assert.deepEqual(stepOf("await page.locator('#list li').last().hover();", O)?.nth, -1)
  const one = stepOf("await page.locator('#name').fill('Dune');", O)!; assert.deepEqual([one.css, one.nth, one.value], ['#name', undefined, 'Dune'])
  assert.equal(stepWords(one), 'type "Dune" in the "#name"')
  // A locator inside a locator, a match taken half-way, a plain hasText
  assert.equal(stepOf("await page.locator('ul').locator('button.remove').first().click();", O)?.css, 'ul >> button.remove')
  assert.equal(stepOf("await page.locator('li').first().locator('button').click();", O)?.css, 'li >> nth=0 >> button')
  assert.equal(stepOf("await page.locator('li', { hasText: 'Dune' }).getByText('x').click();", O)?.text, 'x') // a getBy… call still names it, as before
  assert.equal(stepOf("await page.locator('li', { hasText: 'Dune' }).click();", O)?.css, 'li:has-text("Dune")')
  // What a selector can't say stays as it was: the code only, no element (never a wrong one)
  for (const c of ["await page.locator('li').filter({ has: page.getByText('Dune') }).click()", "await page.locator(sel).click()", "await page.locator('li', { has: x }).click()",
    "await page.locator('iframe').contentFrame().locator('a').click()", "await page.locator('').click()"]) {
    const s = stepOf(c, O)!; assert.deepEqual([s.action, s.css, s.role, s.text], ['click', undefined, undefined, undefined], c)
  }
  assert.equal(stepOf("await page.locator('li').filter({ hasText: 'Dune' }).click()", O)?.css, 'li >> internal:has-text="Dune"i') // a filter on text: Bug 198
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

test('Bug 257: a scenario\'s criteria come from its about list, or from [id]s in its goal; pass checks and button names are not criteria', () => {
  const ids = ['GREET-1 A1', 'GREET-1 A2', 'GREET-1 A3']
  const raw = { scenarios: [ // what Haiku answered: its own pass checks in `criteria`, the ids only in the goal
    { kind: 'basic', title: 'Empty name', criteria: ['Leave the name field empty and press Add', 'No new entry appears in the list'],
      goal: 'Press [Add] with nothing typed and be told a name is needed. [GREET-1 A3]' },
    { kind: 'weird', title: 'Across noon', goal: 'Reload the page after noon and see the greeting change. [GREET-1 A1] [GREET-1 A2]' },
    { kind: 'basic', title: 'Greeting', goal: 'Open the page and see the greeting for the time of day.', about: ['GREET-1 A1', 'A2', 'Z9', 'GREET-1 A1'] },
    { kind: 'complex', title: 'Both', goal: 'Add a name, then reload and see the greeting and the name.', about: ['GREET-1 A3; GREET-1 A2'] },
    { kind: 'weird', title: 'Nothing new', goal: 'Press the back button twice from the start page.', about: [] },
    { kind: 'weird', title: 'Bracketed words', goal: 'Type [hello], press [Add] and see it listed.', criteria: ['The page says "hello"'] }] }
  assert.deepEqual(keepPlan(raw, 30, ids).map((s) => s.criteria ?? null), [['GREET-1 A3'], ['GREET-1 A1', 'GREET-1 A2'], ['GREET-1 A1', 'GREET-1 A2'],
    ['GREET-1 A3', 'GREET-1 A2'], null, null])
  assert.ok(JSON.parse(PLAN_SCHEMA).properties.scenarios.items.required.includes('about'))
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

test('Bug 223: a scenario the tester couldn\'t try from the browser is "couldn\'t test", never a finding, whether it says so or writes it as one', () => {
  const G: Scenario = { id: 's-03', kind: 'basic', title: 'Morning greeting', goal: 'Open the page in the morning and see Good morning.', criteria: ['GREET-1 A1'] }
  const clock = { kind: 'missing', at_step: 1, what: 'I couldn\'t change the clock to check the morning greeting.', expected: 'Good morning before noon', criterion: 'A1' }
  // As the prompt asks: its own outcome and words. What it listed as findings anyway is a note: there is no verdict, so nothing to fix
  const said = keepReport({ outcome: 'couldnt_test', couldnt_test: 'The greeting depends on the time of day, and I can\'t change the computer\'s clock.',
    notes: ['Saw Good afternoon'], findings: [clock] }, G, [[nav]], [], ['GREET-1 A1'])
  assert.deepEqual(said, { outcome: 'couldnt_test', why: 'The greeting depends on the time of day, and I can\'t change the computer\'s clock.', findings: [],
    notes: ['Saw Good afternoon', 'I couldn\'t change the clock to check the morning greeting.'] })
  assert.equal(keepReport({ outcome: 'couldnt_test' }, G, [], [], []).why, 'the tester couldn\'t try it from the browser')
  // As run 2's tester did: a "problem" whose one finding is that it couldn't change the clock (P-1, P-2 waiting for Fix/Ignore)
  const wrote = keepReport({ outcome: 'problem', notes: [], findings: [clock] }, G, [[nav]], [], ['GREET-1 A1'])
  assert.deepEqual([wrote.outcome, wrote.why, wrote.findings.length], ['couldnt_test', 'I couldn\'t change the clock to check the morning greeting.', 0])
  // A real finding beside it: the finding is the verdict; what it couldn't check is a note
  const real = { kind: 'broken', at_step: 1, what: 'The greeting says Good evening at 3 pm.', expected: 'Good afternoon' }
  const both = keepReport({ outcome: 'problem', notes: [], findings: [clock, real] }, G, [[nav]], [], ['GREET-1 A1'])
  assert.deepEqual([both.outcome, both.findings.map((f) => f.what), both.notes], ['problem', ['The greeting says Good evening at 3 pm.'],
    ['Couldn\'t check: I couldn\'t change the clock to check the morning greeting.']])
  assert.equal(keepReport({ outcome: 'ok', couldnt_test: 'Waiting a day for the reminder.' }, G, [], [], []).notes.at(-1), 'Couldn\'t check: Waiting a day for the reminder.')
})

test('Bug 260: a "problem" with no finding but couldnt_test filled in is "couldn\'t test", with its words; an "ok" one says what it couldn\'t check', () => {
  const G: Scenario = { id: 's-01', kind: 'basic', title: 'Greeting against the clock', goal: 'See Good morning before noon.', criteria: ['GREET-1 A1'] }
  const clock = 'I could not change the clock to see the morning greeting; it is afternoon here.'
  // What the real Haiku run said: "problem", no findings, couldnt_test filled in
  const haiku = keepReport({ outcome: 'problem', notes: ['Saw Good afternoon'], findings: [], couldnt_test: clock }, G, [], [], ['GREET-1 A1'])
  assert.deepEqual(haiku, { outcome: 'couldnt_test', why: clock, findings: [], notes: ['Saw Good afternoon'] })
  // Its only finding one HQ can't keep (an unknown kind): the same
  assert.equal(keepReport({ outcome: 'problem', findings: [{ kind: 'nope', what: 'Something odd here.' }], couldnt_test: clock }, G, [], [], []).outcome, 'couldnt_test')
  // Not caught: a real finding beside it stays the verdict; a couldnt_test that says nothing leaves "problem" with nothing kept as before
  const real = { kind: 'broken', at_step: 1, what: 'The greeting says Good evening at 3 pm.', expected: 'Good afternoon' }
  assert.deepEqual(keepReport({ outcome: 'problem', findings: [real], couldnt_test: clock }, G, [[nav]], [], []).outcome, 'problem')
  for (const empty of ['', '  ', 'N/A', 'none', 'None.', 'n/a', '-', '—', 'nothing']) {
    const k = keepReport({ outcome: 'problem', findings: [], couldnt_test: empty }, G, [], [], [])
    assert.deepEqual([k.outcome, k.why, k.notes], ['unspecified', 'the tester saw a problem but reported no finding HQ could keep', []], JSON.stringify(empty))
    assert.deepEqual(keepReport({ outcome: 'ok', couldnt_test: empty }, G, [], [], []), { outcome: 'ok', findings: [], notes: [] }, JSON.stringify(empty))
  }
  // "ok" with something it couldn't check stays fine, and carries what: the summary line says it; "unspecified" keeps its own verdict
  const ok = keepReport({ outcome: 'ok', couldnt_test: 'Waiting a day for the reminder.' }, G, [], [], [])
  assert.deepEqual([ok.outcome, ok.why], ['ok', 'Waiting a day for the reminder.'])
  assert.deepEqual(keepReport({ outcome: 'unspecified', couldnt_test: clock }, G, [], [], []).outcome, 'unspecified')
  const u: UiTest = { at: 1, state: 'done', model: 'haiku', tokens: 1, cost_usd: 0, ms: 1, sessions: 1, findings: [], scenarios: [
    { id: 's-01', kind: 'basic', title: G.title, actions: 2, criteria: G.criteria, outcome: haiku.outcome, why: haiku.why },
    { id: 's-02', kind: 'basic', title: 'Reminder', actions: 3, outcome: ok.outcome, why: ok.why }] }
  assert.deepEqual(uiTestLines(u), ['- 2 scenarios: 1 fine, 0 findings, 0 unspecified, 1 couldn\'t test',
    `- s-01 Greeting against the clock: couldn't test it from a browser, so GREET-1 A1 has no verdict here (${clock})`,
    '- s-02 Reminder: fine, but it couldn\'t check from a browser: Waiting a day for the reminder.'])
  assert.ok(!uiTestLines(u).some((l) => /no verdict \(the tester saw a problem/.test(l)))
})

test('what counts as "couldn\'t try it from the browser" in a finding\'s words: the machine\'s clock, never what the app does with time', () => {
  for (const w of ['I couldn\'t change the clock to check the morning greeting', 'I can’t set the system clock to the morning', 'There is no way to fake the current time',
    'Unable to change the browser\'s time zone', 'I could not adjust the time of day', 'Cannot move my clock forward to the afternoon', 'couldnt change the device time']) {
    assert.equal(cantTry(w), true, w)
  }
  for (const w of ['I couldn\'t set the time on the reminder: the box ignored my typing', 'I couldn\'t change the alarm clock\'s sound', 'I couldn\'t change the clock format to 24 hours',
    'I couldn\'t change the date of the booking', 'I couldn\'t find the Save button', 'The clock on the page shows the wrong time', 'I couldn\'t verify the book was saved: no message',
    'Couldn\'t change the time zone in Settings: the list is empty', 'I couldn\'t set the clock picker to 9:00']) {
    assert.equal(cantTry(w), false, w)
  }
  // and such a finding stays a finding
  const reminder = { kind: 'stuck', at_step: 1, what: 'I couldn\'t set the time on the reminder: the box ignored my typing', expected: 'x' }
  const k = keepReport({ outcome: 'problem', findings: [reminder] }, S, [[nav]], [], [])
  assert.deepEqual([k.outcome, k.findings.length], ['problem', 1])
})

test('an element on the page, from the page text: by role and name, or by text', () => {
  const page = '- generic [ref=e1]:\n  - heading "Library" [level=1]\n  - button "Add" [ref=e7]\n  - text: Nothing to read right now'
  assert.equal(onPage(page, { role: 'button', name: 'Add' }), true); assert.equal(onPage(page, { role: 'button', name: 'Remove' }), false)
  assert.equal(onPage(page, { role: 'heading' }), true); assert.equal(onPage(page, { text: 'Nothing to read' }), true); assert.equal(onPage(page, {}), false)
})

test('Bug 198: a chain keeps the element it ends on, inside what it sits in, and the match it took; one plain getBy… call stays as it was', () => {
  // the entry's examples: the button inside the row or list item, not the row
  const inRow = stepOf("await page.getByRole('row', { name: 'Dune' }).locator('button').click();", O)!
  assert.deepEqual([inRow.role, inRow.css, inRow.nth], [undefined, 'internal:role=row[name="Dune"i] >> button', undefined])
  assert.equal(stepWords(inRow), 'click the button in the row "Dune"')
  assert.equal(stepOf("await page.getByRole('listitem').locator('button').click();", O)?.css, 'internal:role=listitem >> button')
  // what Playwright MCP's code generator writes for one of several same buttons (seen on a real app): the match is kept, words say which
  const edit = stepOf("await page.getByRole('button', { name: 'Edit' }).nth(1).click();", O)!
  assert.deepEqual([edit.role, edit.name, edit.nth, edit.css], ['button', 'Edit', 1, undefined]); assert.equal(stepWords(edit), 'click 2nd button "Edit"')
  assert.deepEqual(stepOf("await page.getByText('1').nth(2).click();", O)?.nth, 2)
  assert.equal(stepWords(stepOf("await page.getByRole('button', { name: 'Remove' }).last().click();", O)!), 'click last button "Remove"')
  // a row picked by its text (a string or a regex, as the generator writes it), then the button in it
  const row = stepOf("await page.getByRole('listitem').filter({ hasText: /^Rice1Remove$/ }).getByRole('button', { name: 'Remove' }).click();", O)!
  assert.deepEqual([row.role, row.name, row.css], ['button', 'Remove', 'internal:role=listitem >> internal:has-text=/^Rice1Remove$/ >> internal:role=button[name="Remove"i]'])
  assert.equal(stepWords(row), 'click button "Remove" in the listitem with "Rice1Remove"')
  const qty = stepOf("await page.getByRole('listitem').filter({ hasText: 'Rice' }).getByLabel('Qty').fill('3');", O)!
  assert.deepEqual([qty.label, qty.css, qty.value], ['Qty', 'internal:role=listitem >> internal:has-text="Rice"i >> internal:label="Qty"i', '3'])
  assert.equal(stepOf("await page.getByRole('row').nth(2).getByRole('button', { name: 'Edit' }).click();", O)?.css,
    'internal:role=row >> nth=2 >> internal:role=button[name="Edit"i]')
  // what the words can't say on their own (exact, other options, a regex, a test id, a title): found by the selector, still called by its words
  const add = stepOf("await page.getByRole('button', { name: 'Add', exact: true }).click();", O)!
  assert.deepEqual([add.role, add.name, add.css], ['button', 'Add', 'internal:role=button[name="Add"s]'])
  assert.equal(stepOf("await page.getByRole('heading', { name: 'Shelves', level: 2 }).click();", O)?.css, 'internal:role=heading[level=2][name="Shelves"i]')
  assert.equal(stepOf("await page.getByRole('button', { name: /Rem\\/ove/i }).click();", O)?.css, 'internal:role=button[name=/Rem\\/ove/i]')
  assert.equal(stepOf("await page.getByText('Say \"hi\"', { exact: true }).click();", O)?.css, 'internal:text="Say \\"hi\\""s')
  assert.equal(stepOf("await page.getByTestId('save').click();", O)?.css, 'internal:testid=[data-testid="save"s]')
  assert.equal(stepOf("await page.getByTitle('Close').click();", O)?.css, 'internal:attr=[title="Close"i]')
  // what it must NOT change: one plain getBy… call, maybe with first(), keeps no selector, as before
  for (const c of ["await page.getByRole('button', { name: 'Add' }).click()", "await page.getByRole('button', { name: 'Add' }).first().click()",
    "await page.getByText('Borrow').click()", "await page.getByLabel('Title').fill('x')", "await page.getByPlaceholder('Search').nth(0).fill('x')"]) {
    const s = stepOf(c, O)!; assert.deepEqual([s.css, s.nth], [undefined, undefined], c); assert.ok(s.role ?? s.text ?? s.label, c)
  }
  // and never a wrong element: what a selector can't say keeps none
  for (const c of ["await page.getByRole('button', { name: label }).click()", "await page.getByRole('listitem').filter({ has: page.getByText('x') }).click()",
    "await page.getByRole('listitem').nth(i).click()", "await page.getByRole('button', { name: 'Add', foo: 1 }).click()"]) {
    const s = stepOf(c, O)!; assert.deepEqual([s.css, s.role, s.name, s.text], [undefined, undefined, undefined, undefined], c)
  }
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
  // Bug 374: the project's own port was in use, so the tester's copy of the app ran on another: said once, under the count
  assert.equal(uiTestLines({ ...u, moved: [{ part: 'api', from: 8000, to: 50123, by: "HQ's preview of shop" }] })[1],
    "- HQ ran its own copy of the app on port 50123 instead of 8000 (in use by HQ's preview of shop)")
  const long = { ...u, findings: [{ ...u.findings[0]!, steps: [nav, ...Array.from({ length: 10 }, () => add)] }] } // a long chain: the last seven, and how many came before
  assert.match(uiTestLines(long)[1]!, /Steps: \(4 steps before\) → click button "Add"( → click button "Add"){6}$/)
  assert.deepEqual(uiTestLines({ at: 1, state: 'skipped', why: 'the app didn\'t start' }), ['- Not tried: the app didn\'t start'])
  // Bug 380: a plan paid for before the app turned out not to start keeps its cost, and the line says it (none, or under a cent: nothing said)
  assert.deepEqual(uiTestLines({ at: 1, state: 'skipped', why: 'the app didn\'t start', tokens: 3500, cost_usd: 0.04 }),
    ['- Not tried: the app didn\'t start (its plan of scenarios had cost $0.04)'])
  assert.deepEqual(uiTestLines({ at: 1, state: 'skipped', why: 'the app didn\'t start', tokens: 30, cost_usd: 0 }), ['- Not tried: the app didn\'t start'])
  // Bug 223: one it couldn't try from a browser is counted and said as such, with the criteria left without a verdict; not a finding
  const g = (id: string, criteria?: string[]) => ({ id, kind: 'basic' as const, title: `Greeting ${id}`, outcome: 'couldnt_test' as const, actions: 1,
    why: 'I couldn\'t change the clock', ...(criteria ? { criteria } : {}) })
  assert.deepEqual(uiTestLines({ ...u, scenarios: [u.scenarios[0]!, g('s-05', ['GREET-1 A1']), g('s-06', ['GREET-1 A1', 'GREET-1 A2']), g('s-07')], findings: [] }), [
    '- 4 scenarios: 1 fine, 0 findings, 0 unspecified, 3 couldn\'t test', '- s-01 Add Dune: fine',
    '- s-05 Greeting s-05: couldn\'t test it from a browser, so GREET-1 A1 has no verdict here (I couldn\'t change the clock)',
    '- s-06 Greeting s-06: couldn\'t test it from a browser, so GREET-1 A1, GREET-1 A2 have no verdict here (I couldn\'t change the clock)',
    '- s-07 Greeting s-07: couldn\'t test it from a browser, so it has no verdict here (I couldn\'t change the clock)'])
})

test('the summary when no scenario ran, all for one reason: that reason once (Bug 170); two reasons, or one that ran, keep a line each', () => {
  const s = (id: string, why: string) => ({ id, kind: 'basic' as const, title: `T ${id}`, outcome: 'not_run' as const, actions: 0, why })
  const base = { at: 1, state: 'done' as const, model: 'sonnet', tokens: 1, cost_usd: 0, ms: 1, sessions: 1, findings: [] }
  const why = 'HQ couldn\'t reset the app: port 3000, which its web part always uses, is taken'
  assert.deepEqual(uiTestLines({ ...base, scenarios: ['s-01', 's-02', 's-03'].map((id) => s(id, why)) }), [`- 3 scenarios, none run (${why})`])
  assert.deepEqual(uiTestLines({ ...base, scenarios: [s('s-01', why), s('s-02', 'the session ended before it')] }), ['- 2 scenarios: 0 fine, 0 findings, 0 unspecified, 2 not run',
    `- s-01 T s-01: not run (${why})`, '- s-02 T s-02: not run (the session ended before it)'])
  assert.deepEqual(uiTestLines({ ...base, scenarios: [s('s-01', why), { ...s('s-02', why), outcome: 'ok' }] }).length, 3)
  assert.deepEqual(uiTestLines({ ...base, scenarios: [s('s-01', why)] }), ['- 1 scenario: 0 fine, 0 findings, 0 unspecified, 1 not run', `- s-01 T s-01: not run (${why})`])
})

// The real parts behind the findings loop's seams (loopparts.ts), as index.ts plugs them in: what the UI tester kept for a run, on disk in HQ's own folder
// and in the tester's own shapes, read by the loop in the loop's shapes; the recordings the checker reads; the test setup's endpoint labels. Then the loop's
// end-of-run stage on those real parts, with the stand-in for Claude Code as the checker (e2e/fake-claude.mjs: no model, no tokens). A replay through the
// real scripted runner is in e2e/auto.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-loopparts-'))
process.env.HQ_HOME = path.join(home, 'hq'); process.env.HOME = home
process.env.HQ_CLAUDE_BIN = path.join(import.meta.dirname, '..', 'e2e', 'fake-claude.mjs')
const { migrate, run } = await import('./db.ts'); migrate()
const { inputs, plugIn } = await import('./loopinputs.ts')
const { loopExpect, loopStep, realParts } = await import('./loopparts.ts')
const { stepWords, ticketBlock } = await import('./findingrules.ts')
const F = await import('./findings.ts')
const { getRepo } = await import('./records.ts')
const { autoGen } = await import('./testrun.ts')
const { recordingDir, recordingId, uiTestDir } = await import('./uitester.ts')
const { setupFile } = await import('./testsetupstore.ts')
type UiStep = import('./uitesterrules.ts').Step

test('until HQ plugs the real parts in, the loop reads nothing and says HQ didn\'t connect them; index.ts plugs them in at start-up', async () => {
  assert.equal(inputs().uiRun('r1', 'run1'), null); assert.equal(inputs().recording('r1', 'run1/s-01'), null)
  assert.deepEqual(await inputs().runScenario('r1', []), { why: 'HQ\'s recorder and UI tester weren\'t connected to the findings loop when it started' })
  const index = fs.readFileSync(path.join(import.meta.dirname, 'index.ts'), 'utf8')
  assert.match(index, /plugIn\(realParts\)[^\n]*\n[\s\S]*startAutoLoop\(\)/, 'plugged in before the auto loop can end a run')
  plugIn(realParts); assert.equal(inputs().runScenario, realParts.runScenario)
})

test('a step the tester kept reads the same to the loop, the ticket and the scripted runner: what was typed, the key, the option, the field', () => {
  const s = (o: Omit<UiStep, 'code'>): UiStep => ({ ...o, code: 'await page…' })
  const cases: [UiStep, unknown, string][] = [
    [s({ action: 'navigate', url: '/?tab=reading' }), { action: 'navigate', url: '/?tab=reading' }, 'open /?tab=reading'],
    [s({ action: 'fill', role: 'textbox', name: 'Title', value: 'Dune' }), { action: 'fill', role: 'textbox', name: 'Title', text: 'Dune' }, 'type "Dune" into the "Title" box'],
    [s({ action: 'fill', label: 'Search books', value: 'emma' }), { action: 'fill', field: 'Search books', text: 'emma' }, 'type "emma" into the "Search books" box'],
    [s({ action: 'press', value: 'Enter' }), { action: 'press', text: 'Enter' }, 'press Enter'],
    [s({ action: 'select', role: 'combobox', name: 'Shelf', value: 'Fiction' }), { action: 'select', role: 'combobox', name: 'Shelf', value: 'Fiction' }, 'pick "Fiction" in the "Shelf" combobox'],
    [s({ action: 'click', text: 'Borrow' }), { action: 'click', name: 'Borrow' }, 'click the "Borrow"'], // an element named by its text alone
    [s({ action: 'click', role: 'button', name: 'Add' }), { action: 'click', role: 'button', name: 'Add' }, 'click the "Add" button'],
    [s({ action: 'uncheck', role: 'checkbox', name: 'Due soon' }), { action: 'uncheck', role: 'checkbox', name: 'Due soon' }, 'untick the "Due soon" checkbox'],
    [s({ action: 'back' }), { action: 'back' }, 'go back'],
    [s({ action: 'click', css: 'button:has-text("Remove")', nth: 0 }), { action: 'click', css: 'button:has-text("Remove")', nth: 0 }, 'click the "Remove" button'], // Bug 173
    [s({ action: 'fill', css: '#name', value: 'Dune' }), { action: 'fill', css: '#name', text: 'Dune' }, 'type "Dune" into the "#name"'],
    // Bug 198: the match it took, and the selector that finds it inside its row, go along with its words
    [s({ action: 'click', role: 'button', name: 'Edit', nth: 1 }), { action: 'click', role: 'button', name: 'Edit', nth: 1 }, 'click the 2nd "Edit" button'],
    [s({ action: 'click', role: 'button', name: 'Remove', css: 'internal:role=row[name="Dune"i] >> internal:role=button[name="Remove"i]' }),
      { action: 'click', role: 'button', name: 'Remove', css: 'internal:role=row[name="Dune"i] >> internal:role=button[name="Remove"i]' },
      'click the "Remove" button in the row "Dune"'],
    [s({ action: 'fill', label: 'Qty', css: 'internal:role=listitem >> internal:label="Qty"i', value: '3' }),
      { action: 'fill', field: 'Qty', css: 'internal:role=listitem >> internal:label="Qty"i', text: '3' }, 'type "3" into the "Qty" box in the listitem'],
  ]
  for (const [from, to, words] of cases) { assert.deepEqual(loopStep(from), to); assert.equal(stepWords(loopStep(from)), words) }
})

test('what the tester saw becomes what a fix should show: an element that was missing must be there; one that was there says nothing a script can check', () => {
  assert.deepEqual(loopExpect([{ role: 'alert', visible: false }]), [{ role: 'alert', visible: true }])
  assert.deepEqual(loopExpect([{ role: 'button', name: 'Save', visible: false }, { text: 'Added', visible: true }]), [{ role: 'button', name: 'Save', visible: true }])
  assert.equal(loopExpect([{ role: 'button', name: 'Add', visible: true }]), undefined) // it was there, and the finding is about something else
  assert.equal(loopExpect(undefined), undefined); assert.equal(loopExpect([{ visible: false }]), undefined) // names nothing
})

// A project, a run whose tester finished, and what the tester kept for it
const repoDir = path.join(home, 'library'); fs.mkdirSync(repoDir)
const sh = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: repoDir, encoding: 'utf8' })
sh('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repoDir, 'server.js'), 'export const add = () => {}\n'); sh('add', '.'); sh('commit', '-qm', 'first')
const now = Date.now()
run("INSERT INTO repos(id, name, path, kind, default_branch, created_at, tpm_agent_id) VALUES ('r1', 'library', ?, 'local', 'main', ?, 'tpm1')", repoDir, now)
run("INSERT INTO agents(id, role, repo_id, model_alias, token_hash, status, started_at) VALUES ('tpm1', 'tpm', 'r1', 'opus', 'x', 'idle', ?)", now)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, handle, created_at, updated_at) VALUES ('f1', 'r1', 'reading', 'Reading', 'a list', 'planning', 'F-1', ?, ?)", now, now)
const ROW = 'POST /api/items → 500 (3ms) ⚠ 500'
const verdict = { scenarios: [{ scenario: 's-01', clean: false, line: 'the add failed', findings: [{ type: 'backend', criterion: 'T-01 A2', what: 'Adding a book answered 500 and stored nothing.',
  expected: 'A 201 and one new record.', why: 'the call failed', rows: [ROW] }] }] }
const criteria = [{ id: 'A1', kind: 'ui', text: 'A new book shows in the list at once' },
  { id: 'A2', kind: 'backend', text: `Adding a book stores it once. FAKE-BACKEND: ${JSON.stringify(verdict)}` }]
run(`INSERT INTO tickets(id, feature_id, key, slug, title, status, criteria, created_at, updated_at) VALUES ('t1', 'f1', 'T-01', 't-01', 'Adding', 'merged', ?, ?, ?)`,
  JSON.stringify(criteria), now, now)
const uiTest = (o: Record<string, unknown>) => JSON.stringify({ at: now, state: 'done', scenarios: [], findings: [], ms: 1, tokens: 1, cost_usd: 0, model: 'sonnet', sessions: 1, ...o })
const addRun = (id: string, ui: string | null) => run("INSERT INTO auto_runs(id, repo_id, status, started_at, ui_test) VALUES (?, 'r1', 'running', ?, ?)", id, now, ui)
const code = 'await page…'
const steps: UiStep[] = [{ action: 'navigate', url: '/', code }, { action: 'fill', label: 'Title', value: 'Dune', code }, { action: 'click', role: 'button', name: 'Add', code }]
function keepRun(runId: string): string {
  const dir = uiTestDir('r1', runId); fs.mkdirSync(dir, { recursive: true })
  const plan = [{ id: 's-01', kind: 'basic', title: 'Add a book', goal: 'Add Dune and see it in the list.' }, { id: 's-02', kind: 'weird', title: 'Add nothing', goal: 'Press Add with no title.' },
    { id: 's-03', kind: 'complex', title: 'Never begun', goal: 'Borrow and return a book.' }]
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan))
  const f = (scenario: string, what: string, expect: unknown, n = steps.length) => ({ id: '', scenario, kind: 'no_feedback', what, expected: 'A message saying what happened.',
    steps: steps.slice(0, n), ...(n === steps.length ? { criterion: 'T-01 A1' } : {}), expect })
  fs.writeFileSync(path.join(dir, 's-01.json'), JSON.stringify({ scenario: plan[0], outcome: 'problem', steps, log: [], notes: [], recording: recordingId(runId, 's-01'),
    findings: [f('s-01', 'After Add nothing on the page says the book went in.', [{ role: 'alert', visible: false }])] }))
  fs.writeFileSync(path.join(dir, 's-02.json'), JSON.stringify({ scenario: plan[1], outcome: 'problem', steps: steps.slice(0, 1), log: [], notes: [], recording: null,
    findings: [f('s-02', 'Opening the page showed no list at all.', [{ role: 'button', name: 'Add', visible: true }], 1)] }))
  // s-01's recording, as the recorder leaves it: a reset, one action, the call it made, a line the server printed
  const rec = path.join(dir, 's-01.rec'); fs.mkdirSync(rec)
  const j = (name: string, rows: unknown[]) => fs.writeFileSync(path.join(rec, `${name}.jsonl`), rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
  j('actions', [{ at: 1000, phase: 'start', label: 'reset', action: 1 }, { at: 1500, phase: 'end', label: 'reset', action: 1, ok: true },
    { at: 2000, phase: 'start', label: 'click Add button', action: 2 }, { at: 2400, phase: 'end', label: 'click Add button', action: 2, ok: true }])
  j('api', [{ i: 1, at: 2010, end: 2013, ms: 3, method: 'POST', path: '/api/items', status: 500, action: 2, body: 'abc' }]); j('snaps', []); j('browser', [])
  fs.writeFileSync(path.join(rec, 'server.log'), '2012\tapp\tError: the title parser choked\n')
  return rec
}
fs.mkdirSync(path.dirname(setupFile('r1')), { recursive: true })
fs.writeFileSync(setupFile('r1'), JSON.stringify({ setup: { start: [{ part: 'app', run: 'node server.js' }], snapshot: ['data'], seed: 'true', notes: '',
  endpoints: [{ method: 'POST', path: '/api/items', kind: 'instant' }] } }))
const calls = (): any[] => { try { return fs.readFileSync(path.join(home, 'fake-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] } }

test('a run\'s tester results are read from HQ\'s folder in the loop\'s shapes, and only for a run whose tester finished', () => {
  addRun('run0', null); keepRun('run0'); assert.equal(realParts.uiRun('r1', 'run0'), null, 'stopped halfway: nothing of it counts')
  addRun('runS', JSON.stringify({ at: now, state: 'skipped', why: 'no start steps' })); assert.equal(realParts.uiRun('r1', 'runS'), null)
  assert.equal(realParts.uiRun('r1', 'no-such-run'), null)
  addRun('run1', uiTest({})); keepRun('run1')
  const ui = realParts.uiRun('r1', 'run1')!
  assert.deepEqual(ui.scenarios.map((s) => [s.scenario.id, s.outcome, s.recording, s.steps.length]), [['s-01', 'problem', 'run1/s-01', 3], ['s-02', 'problem', null, 1]]) // s-03 never ran
  assert.deepEqual(ui.findings.map((f) => [f.id, f.scenario, f.expect]), [['U1', 's-01', [{ role: 'alert', visible: true }]], ['U2', 's-02', undefined]])
  assert.deepEqual(ui.findings[0]!.steps[1], { action: 'fill', field: 'Title', text: 'Dune' }); assert.equal(ui.unrecorded, undefined)
  addRun('runU', uiTest({ unrecorded: 'the project has no test setup yet' })); keepRun('runU')
  assert.equal(realParts.uiRun('r1', 'runU')!.unrecorded, 'the project has no test setup yet')
})

test('a recording is read from its folder as the timeline the checker gets, with HQ\'s flags; an id that names no recording gets nothing', () => {
  const rec = realParts.recording('r1', 'run1/s-01')!
  assert.equal(rec.dir, recordingDir('r1', 'run1/s-01')); assert.equal(rec.id, 'run1/s-01')
  assert.deepEqual(rec.timeline.map((r) => `${r.source}: ${r.text}`), ['hq: reset the app to its seed', 'tester: click Add button', `api: ${ROW}`, 'server: app: Error: the title parser choked'])
  assert.deepEqual(rec.flags, [{ kind: 'error', method: 'POST', path: '/api/items', status: 500, why: '500' }]); assert.match(rec.markdown, /\| api \| POST \/api\/items → 500/)
  assert.match(rec.markdown, /^# s-01 Add a book\n/) // named as the tester's run named it
  for (const id of ['run1/s-02', 'run1/s-99', 'nope', '../run1/s-01', 'run1/../run1/s-01', 'run1/s-01/x', '']) assert.equal(realParts.recording('r1', id), null, id)
  assert.equal(realParts.recording('r2', 'run1/s-01'), null, 'another project\'s')
  assert.deepEqual(realParts.endpoints('r1'), [{ method: 'POST', path: '/api/items', kind: 'instant' }]); assert.deepEqual(realParts.endpoints('r2'), [])
})

test('the end of a run on the real parts: the tester\'s findings are kept in words a ticket can use, and the checker reads the run\'s recording and finds what the backend did', async () => {
  assert.equal(await F.afterUiTest(getRepo('r1')!, 'run1', autoGen(repoDir)), 'done')
  const all = F.findingsOf('r1')
  assert.deepEqual(all.map((k) => [k.id, k.source, k.by, k.criterion]), [['P-1', 'ui', 'tester', 'T-01 A1'], ['P-2', 'ui', 'tester', undefined], ['P-3', 'backend', 'checker', 'T-01 A2']])
  assert.deepEqual(all[0]!.expect, [{ role: 'alert', visible: true }]); assert.equal(all[1]!.expect, undefined)
  assert.match(ticketBlock(all[0]!), /type "Dune" into the "Title" box/); assert.equal(all[0]!.evidence.recording, 'run1/s-01')
  const p3 = all[2]!; assert.deepEqual(p3.evidence.rows, [ROW]); assert.deepEqual(p3.evidence.flags.map((f) => [f.kind, f.path]), [['error', '/api/items']])
  assert.equal(p3.key, 'backend|error|POST /api/items'); assert.equal(p3.evidence.recording, 'run1/s-01'); assert.deepEqual(p3.steps[1], { action: 'fill', field: 'Title', text: 'Dune' })
  const c = calls(); assert.equal(c.length, 1); assert.deepEqual(c[0].addDirs, [recordingDir('r1', 'run1/s-01')]) // the one scenario with a recording
  assert.match(c[0].prompt, /## Scenario s-01: Add a book\nGoal: Add Dune and see it in the list\.\nRaw logs: .*s-01\.rec\n/)
  assert.match(c[0].prompt, /\| tester \| click Add button \|\n.*\| api \| POST \/api\/items → 500 \(3ms\) ⚠ 500 \|/); assert.match(c[0].prompt, /- POST \/api\/items: instant/)
  assert.match(F.findingsSection('r1', 'run1'), /1 of 2 scenarios had no recording, so the backend checker couldn't judge them/)
})

test('a run that wasn\'t recorded says why, once, and the tester\'s own findings are still kept', async () => {
  fs.rmSync(path.join(uiTestDir('r1', 'runU'), 's-01.rec'), { recursive: true }) // as the tester leaves a run with no test setup: no recording folders
  assert.equal(await F.afterUiTest(getRepo('r1')!, 'runU', autoGen(repoDir)), 'done'); assert.equal(calls().length, 1, 'nothing to read: the checker isn\'t asked')
  assert.match(F.findingsSection('r1', 'runU'), /- The backend checker had nothing to read: the tester's run wasn't recorded \(the project has no test setup yet\)/)
  assert.deepEqual(F.findingsOf('r1').map((k) => [k.id, k.runs]).slice(0, 2), [['P-1', ['run1', 'runU']], ['P-2', ['run1', 'runU']]]) // seen again, not kept twice
})

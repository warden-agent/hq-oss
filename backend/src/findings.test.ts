// The findings loop end to end against a real DB, a real git repo and the stand-in for Claude Code (e2e/fake-claude.mjs: no model, no tokens), with stand-ins for
// the parts beside it (loopinputs.ts plugIn): Part 3's recordings and replays, and Part 4's UI tester run. Run summary → findings → the user's Fix / Ignore /
// rule → Send → the TPM's fix ticket → it merges → the next run replays it → ✓ fixed / ✗ still broken → a second ticket → ⚑ broken twice, no third ticket.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-findings-'))
process.env.HQ_HOME = path.join(home, 'hq'); process.env.HOME = home
process.env.HQ_CLAUDE_BIN = path.join(import.meta.dirname, '..', 'e2e', 'fake-claude.mjs'); process.env.HQ_CHECK_BATCH = '2'
const { migrate, run, q, setSetting } = await import('./db.ts'); migrate()
const { plugIn } = await import('./loopinputs.ts')
const F = await import('./findings.ts')
const { getRepo, ticketInRepo } = await import('./records.ts')
const { autoGen } = await import('./testrun.ts')
type Recorded = import('./loopinputs.ts').Recorded; type ScenarioRun = import('./loopinputs.ts').ScenarioRun; type Step = import('./loopinputs.ts').Step

const repoDir = path.join(home, 'library'); fs.mkdirSync(repoDir)
const sh = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: repoDir, encoding: 'utf8' })
sh('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repoDir, 'server.js'), 'export const fill = () => {}\n'); sh('add', '.'); sh('commit', '-qm', 'first')
const now = Date.now()
run("INSERT INTO repos(id, name, path, kind, default_branch, created_at, tpm_agent_id) VALUES ('r1', 'library', ?, 'local', 'main', ?, 'tpm1')", repoDir, now)
run("INSERT INTO agents(id, role, repo_id, model_alias, token_hash, status, started_at) VALUES ('tpm1', 'tpm', 'r1', 'opus', 'x', 'idle', ?)", now)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, handle, created_at, updated_at) VALUES ('f1', 'r1', 'reading', 'Reading', 'a list', 'planning', 'F-1', ?, ?)", now, now)
const ticket = (id: string, key: string, criteria: unknown[], status = 'merged') => run(`INSERT INTO tickets(id, feature_id, key, slug, title, status, criteria, created_at, updated_at)
  VALUES (?, 'f1', ?, ?, ?, ?, ?, ?, ?)`, id, key, key.toLowerCase(), key, status, JSON.stringify(criteria), now, now)
ticket('t1', 'T-01', [{ id: 'A1', kind: 'ui', text: 'Adding "Dune, 2" shows Dune ×2 in the list without a reload' }])
ticket('t2', 'T-02', [{ id: 'A1', kind: 'backend', text: 'Fill from wishlist adds each missing book exactly once' }, { id: 'A2', kind: 'backend', text: 'An empty name gets a 4xx from the API' }])
const repo = () => getRepo('r1')!
const calls = (): any[] => { try { return fs.readFileSync(path.join(home, 'fake-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] } }

const add: Step[] = [{ action: 'navigate', url: '/' }, { action: 'fill', role: 'textbox', name: 'Item', text: 'Dune, 2' }, { action: 'click', role: 'button', name: 'Add' }]
const fill: Step[] = [{ action: 'navigate', url: '/?tab=plan' }, { action: 'click', role: 'button', name: 'Fill from wishlist' }]
const dup = { kind: 'duplicate' as const, method: 'POST', path: '/api/reading/fill', why: 'POST /api/reading/fill twice within one action' }
const recDir = (id: string) => { const d = path.join(home, 'hq', 'projects', 'r1', 'scenarios', id); fs.mkdirSync(d, { recursive: true }); return d }
/** A recording as Part 3 makes it; `say` is the stand-in checker's answer for its batch (FAKE-CHECK in the timeline it reads). */
const rec = (id: string, rows: Recorded['timeline'], say?: unknown): Recorded => ({ id, dir: recDir(id), flags: rows.flatMap((r) => r.flags), steps: [], timeline: rows,
  markdown: [...rows.map((r) => `| ${r.at} | ${r.source} | ${r.text}${r.flags.length ? ' ⚠' : ''} |`), ...(say ? [`FAKE-CHECK: ${JSON.stringify(say)}`] : [])].join('\n') })
const dupRows = [{ at: 1, source: 'tester' as const, text: 'click "Fill from wishlist"', flags: [] }, { at: 2, source: 'api' as const, text: 'POST /api/reading/fill → 200 (12ms)', flags: [] },
  { at: 3, source: 'api' as const, text: 'POST /api/reading/fill → 200 ⚠ 2x', flags: [dup] }, { at: 4, source: 'data' as const, text: 'reading: +Emma, +Emma', flags: [] }]
const verdict = { scenarios: [
  { scenario: 's-01', clean: true, line: 'one book record added; nothing else changed', findings: [] },
  { scenario: 's-02', clean: false, line: 'Emma added twice', findings: [
    { type: 'backend', criterion: 't-02 a1', what: 'Fill from wishlist added Emma to the reading list twice.', expected: 'One Emma entry.', why: 'two POSTs in one click',
      rows: ['POST /api/reading/fill → 200 ⚠ 2x', 'reading: +Emma, +Emma'] },
    { type: 'backend', criterion: 'T-09 A1', what: 'The plan tab and the list tab disagree after a fill.', expected: 'Both show the same list.', why: 'stale', rows: ['a row nobody recorded'] }] }] }
const recs = new Map<string, Recorded>([['rec-1', rec('rec-1', [{ at: 1, source: 'api', text: 'POST /api/items → 201', flags: [] }], verdict)], ['rec-2', rec('rec-2', dupRows)]])
let ui: { scenarios: ScenarioRun[]; findings: any[] } | null = {
  scenarios: [{ scenario: { id: 's-01', kind: 'basic', title: 'Add Dune', goal: 'add Dune' }, steps: add, findings: [], recording: 'rec-1', outcome: 'ok' },
    { scenario: { id: 's-02', kind: 'complex', title: 'Fill from wishlist', goal: 'fill the list' }, steps: fill, findings: [], recording: 'rec-2', outcome: 'ok' },
    { scenario: { id: 's-03', kind: 'weird', title: 'Back button', goal: 'go back' }, steps: [], findings: [], recording: null, outcome: 'ok' }],
  findings: [{ id: 'U1', scenario: 's-01', kind: 'no_feedback', what: 'After Add nothing on the page says the item went in.', expected: 'The item shows in the list at once.',
      steps: add, criterion: 'T-01 A1' },
    { id: 'U2', scenario: 's-01', kind: 'unclear_label', what: 'The button says "Go" but it adds the item.', expected: 'A label that says Add.',
      steps: add.slice(0, 2).concat({ action: 'click', role: 'button', name: 'Go' }) }],
}
let replayed: Recorded | { why: string } = { why: 'not yet' }, replays = 0
plugIn({ uiRun: () => ui, recording: (_r, id) => recs.get(id) ?? null, endpoints: () => [{ method: 'POST', path: '/api/reading/fill', kind: 'normal' }],
  runScenario: async () => { replays++; return replayed } })

test('as a run ends: the UI tester\'s findings and the checker\'s are kept; the checker reads recordings with read tools only, in a checkout, batch by batch', async () => {
  assert.equal(await F.afterUiTest(repo(), 'run1', autoGen(repoDir)), 'done')
  const all = F.findingsOf('r1')
  assert.deepEqual(all.map((k) => [k.id, k.source, k.criterion]), [['P-1', 'ui', 'T-01 A1'], ['P-2', 'ui', undefined], ['P-3', 'backend', 'T-02 A1'], ['P-4', 'unspecified', undefined]])
  const p3 = all[2]!; assert.deepEqual(p3.evidence.flags, [dup]); assert.equal(p3.key, 'backend|duplicate|POST /api/reading/fill'); assert.deepEqual(p3.steps, fill)
  assert.deepEqual(all[3]!.evidence.rows, ['(no rows quoted) stale']) // a row the recording doesn't have is never kept as evidence
  const c = calls(); assert.equal(c.length, 1) // s-03 had no recording: two scenarios, one batch of two
  assert.equal(c[0].tools, 'Read,Grep,Glob'); assert.equal(c[0].model, 'opus'); assert.ok(c[0].strictMcp); assert.equal(c[0].mcp, '{"mcpServers":{}}')
  assert.deepEqual(c[0].addDirs, [recs.get('rec-1')!.dir, recs.get('rec-2')!.dir]); assert.ok(c[0].cwd.endsWith('/.claude/worktrees/hq-test-checker'), c[0].cwd)
  assert.match(c[0].prompt, /T-02 A1: Fill from wishlist adds each missing book exactly once/); assert.doesNotMatch(c[0].prompt, /T-01 A1/) // backend criteria only
  assert.match(c[0].prompt, /POST \/api\/reading\/fill: normal/); assert.equal(fs.existsSync(c[0].cwd), false) // the checkout is gone once it's done
  const s = F.findingsSection('r1', 'run1')
  assert.match(s, /^## Findings\n- New P-1 \(on the screen, T-01 A1\)/); assert.match(s, /1 of 3 scenarios had no recording/); assert.match(s, /4 waiting for you/)
  assert.equal(await F.afterUiTest(repo(), 'run1', autoGen(repoDir)), 'done'); assert.equal(calls().length, 1) // done once: a restart doesn't pay twice
})
test('the user decides: wording, Fix, Ignore, a rule (held to the criteria\'s own checks); Send tells the TPM, and nothing becomes a ticket unsent', async () => {
  assert.throws(() => F.createFixTicket('r1', { finding: 'P-3', title: 'x', size: 'S', spec: 's', criteria: [] }), /isn't sent for a ticket \(it's new\)/)
  await assert.rejects(F.sendFindings('r1'), /Mark at least one/)
  F.decideFinding('r1', 'P-1', { decision: 'fix', wording: 'Add shows nothing, so you press it again.' })
  F.decideFinding('r1', 'P-2', { decision: 'fix' }); F.decideFinding('r1', 'P-2', { decision: null }) // taken back: the page gets null, not a missing field
  assert.equal(F.allFindings().find((x) => x.fid === 'P-2')!.decision, null)
  F.decideFinding('r1', 'P-2', { decision: 'ignore' })
  F.decideFinding('r1', 'P-3', { decision: 'fix' })
  assert.throws(() => F.decideFinding('r1', 'P-4', { decision: 'rule', rule: `The lists agree ${'and more '.repeat(50)}` }), /The rule is over 400 characters/)
  assert.throws(() => F.decideFinding('r1', 'P-3', { decision: 'rule', rule: 'When a fill runs, each item is added once.' }), /already breaks a criterion/)
  F.decideFinding('r1', 'P-4', { decision: 'rule', rule: 'After a fill, the plan tab and the reading tab show the same items.' })
  assert.deepEqual(await F.sendFindings('r1'), { sent: ['P-1', 'P-3', 'P-4'], closed: ['P-2'] })
  const m = q<{ body: string; to_id: string }>("SELECT body, to_id FROM messages WHERE to_id = 'tpm1'").at(-1)!
  assert.match(m.body, /create_fix_ticket/); assert.match(m.body, /P-1: Add shows nothing, so you press it again\./); assert.match(m.body, /P-4: .*new rule: After a fill/)
  assert.doesNotMatch(m.body, /P-2/)
  assert.throws(() => F.decideFinding('r1', 'P-1', { decision: 'ignore' }), /isn't waiting for you \(it's sent to the TPM\)/)
})
test('the TPM\'s fix tickets carry the finding; a rule becomes a criterion; a finding gets one ticket at a time', () => {
  assert.throws(() => F.createFixTicket('r1', { finding: 'P-2', title: 'x', size: 'S', spec: 's', criteria: [] }), /isn't sent .*closed/)
  assert.throws(() => F.createFixTicket('r1', { finding: 'P-9', title: 'x', size: 'S', spec: 's', criteria: [] }), /no finding P-9/)
  F.createFixTicket('r1', { finding: 'p-3', title: 'Fill adds each item once', size: 'S', spec: 'Stop the double fill.',
      criteria: [{ kind: 'backend', text: 'One click of Fill from wishlist makes one request' }] })
  const t = ticketInRepo('r1', 'T-03')!; assert.match(t.spec ?? '', /^Stop the double fill\.\n\n## Finding P-3 \(behind the screen\)/);
      assert.match(t.spec ?? '', /2\. click the "Fill from wishlist" button/)
  assert.equal(F.findingOfTicket(t.id), 'P-3')
  assert.throws(() => F.createFixTicket('r1', { finding: 'P-3', title: 'again', size: 'S', spec: 's', criteria: [] }), /it's fixing/)
  F.createFixTicket('r1', { finding: 'P-4', title: 'Tabs agree after a fill', size: 'S', spec: 'Keep them in step.',
      criteria: [{ kind: 'ui', text: 'The reading tab shows filled items without a reload' }] })
  assert.deepEqual(JSON.parse(ticketInRepo('r1', 'T-04')!.criteria).map((c: any) => c.text), ['The reading tab shows filled items without a reload',
    'After a fill, the plan tab and the reading tab show the same items.'])
  F.createFixTicket('r1', { finding: 'P-1', title: 'Add says it worked', size: 'S', spec: 'Show the item at once.', criteria: [{ kind: 'ui', text: 'After Add, the item shows in the list' }] })
  assert.deepEqual(F.findingsOf('r1').map((k) => k.state), ['fixing', 'closed', 'fixing', 'fixing'])
})
test('the next run replays what merged: a flag gone is ✓ fixed, a flag still there is ✗ still broken, steps that no longer fit go to the tester; ignored never returns', async () => {
  replayed = { why: 'x' }
  assert.deepEqual(await F.beforeUiTest(repo(), 'run2', autoGen(repoDir)), { retry: [] }); assert.equal(replays, 0) // nothing merged yet: nothing replayed
  run("UPDATE tickets SET status = 'merged', updated_at = ? WHERE key IN ('T-03', 'T-05')", Date.now())
  replayed = { ...rec('rep-1', dupRows), steps: fill.map(() => ({ ok: true })) } // still two POSTs
  const before = await F.beforeUiTest(repo(), 'run2', autoGen(repoDir)); assert.ok(before !== 'stopped'); assert.equal(replays, 1)
  // T-05 (P-1's ticket) is a UI finding with nothing code can check on the page: the tester retries it by its goal, with only its own words and steps
  assert.deepEqual(before.retry.map((r) => [r.goal.slice(0, 4), r.what, r.own]), [['P-1:', 'Add shows nothing, so you press it again.', true]])
  const p3 = F.getFinding('r1', 'P-3')!; assert.deepEqual([p3.state, p3.strikes, p3.checks.at(-1)!.result, p3.checks.at(-1)!.how], ['new', 1, 'broken', 'replay'])
  ui = { scenarios: [{ scenario: { id: 's-01', kind: 'retry', title: 'Retry', goal: before.retry[0]!.goal }, steps: add, findings: [], recording: null, outcome: 'ok' }],
    findings: [{ id: 'U1', scenario: 's-02', kind: 'unclear_label', what: 'The button says "Go" but it adds the item, again.', expected: 'Add.',
      steps: add.slice(0, 2).concat({ action: 'click', role: 'button', name: 'Go' }) }] }
  await F.afterUiTest(repo(), 'run2', autoGen(repoDir))
  assert.equal(F.getFinding('r1', 'P-1')!.state, 'fixed')
  assert.equal(F.findingsOf('r1').length, 4) // P-2 was ignored: the same "Go" finding in other words is never reported again
  const s = F.findingsSection('r1', 'run2'); assert.match(s, /✓ P-1 fixed/); assert.match(s, /✗ P-3 still broken after T-03/); assert.doesNotMatch(s, /New|P-2/)
})
test('two strikes: a finding still broken after its second ticket is flagged, and HQ makes no third ticket', async () => {
  F.decideFinding('r1', 'P-3', { decision: 'fix' }); await F.sendFindings('r1')
  F.createFixTicket('r1', { finding: 'P-3', title: 'Fill adds each item once, really', size: 'S', spec: 'Again.',
      criteria: [{ kind: 'backend', text: 'One click of Fill from wishlist makes one request' }] })
  const t = ticketInRepo('r1', 'T-06')!; assert.match(t.spec ?? '', /A fix ticket \(T-03\) was merged and the replay still showed it/)
  run("UPDATE tickets SET status = 'merged', updated_at = ? WHERE key = 'T-06'", Date.now() + 5)
  await F.beforeUiTest(repo(), 'run3', autoGen(repoDir))
  const p3 = F.getFinding('r1', 'P-3')!; assert.deepEqual([p3.state, p3.strikes, p3.tickets], ['flagged', 2, ['T-03', 'T-06']])
  assert.throws(() => F.decideFinding('r1', 'P-3', { decision: 'fix' }), /won't make another/)
  assert.throws(() => F.createFixTicket('r1', { finding: 'P-3', title: 'x', size: 'S', spec: 's', criteria: [] }), /HQ makes no more/)
  assert.match(F.findingsSection('r1', 'run3'), /⚑ P-3 still broken after 2 fix tickets \(T-03, T-06\)\. HQ won't make a third/)
  F.decideFinding('r1', 'P-3', { decision: 'ignore' }); await F.sendFindings('r1'); assert.equal(F.getFinding('r1', 'P-3')!.state, 'closed')
})
test('a fixed backend finding: the replay shows no flag on that endpoint any more', async () => {
  run("UPDATE tickets SET status = 'merged', updated_at = ? WHERE key = 'T-04'", Date.now() + 10)
  replayed = { ...rec('rep-2', [{ at: 1, source: 'api', text: 'POST /api/reading/fill → 200', flags: [] }], { scenarios: [{ scenario: 'replay', clean: true, line: 'tabs agree', findings: [] }] }),
    steps: fill.map(() => ({ ok: true })) }
  const n = calls().length
  await F.beforeUiTest(repo(), 'run4', autoGen(repoDir))
  // P-4 (a rule, no flag): code can't tell, so the checker judges the replay's recording against the rule, with read tools only
  const p4 = F.getFinding('r1', 'P-4')!; assert.deepEqual([p4.state, p4.checks.at(-1)!.how], ['fixed', 'checker'])
  const c = calls().slice(n); assert.equal(c.length, 1); assert.equal(c[0].tools, 'Read,Grep,Glob'); assert.match(c[0].prompt, /RULE: After a fill, the plan tab and the reading tab/)
})
test('a backend finding whose steps no longer fit: the tester redoes its own scenario, told nothing of the checker\'s, and the new recording decides', async () => {
  const flag = { kind: 'error' as const, method: 'POST', path: '/api/items', status: 500, why: 'POST /api/items → 500' }
  F.keep('r1', 'run6', [{ source: 'backend', by: 'checker', what: 'The server threw on the items handler because the qty parser chokes on "2x".', expected: 'A 4xx, nothing stored.',
    criterion: 'T-02 A2', steps: add, evidence: { scenario: 's-09', goal: 'add "Dune, 2x" and see what happens', rows: ['POST /api/items → 500'], flags: [flag] } }])
  const k = F.findingsOf('r1').at(-1)!; F.decideFinding('r1', k.id, { decision: 'fix' }); await F.sendFindings('r1')
  F.createFixTicket('r1', { finding: k.id, title: 'Bad quantities get an error', size: 'S', spec: 'x', criteria: [{ kind: 'backend', text: 'A quantity like 2x gets a 4xx' }] })
  run("UPDATE tickets SET status = 'merged', updated_at = ? WHERE key = ?", Date.now() + 20, F.getFinding('r1', k.id)!.tickets[0]!)
  replayed = { ...rec('rep-3', []), steps: [{ ok: true }, { ok: false, why: 'no textbox named "Item"' }, { ok: false, why: 'skipped' }] }
  const b = await F.beforeUiTest(repo(), 'run7', autoGen(repoDir)); assert.ok(b !== 'stopped')
  const r = b.retry.find((x) => x.goal.startsWith(`${k.id}:`))!
  assert.equal(r.goal, `${k.id}: add "Dune, 2x" and see what happens`); assert.doesNotMatch(JSON.stringify(r), /parser|threw|handler|4xx/) // the checker's words stay out
  assert.equal(r.own, false); assert.equal(r.expected, 'add "Dune, 2x" and see what happens') // not the tester's own finding: the scenario's goal is what the summary calls it
  recs.set('rec-9', rec('rec-9', [{ at: 1, source: 'api', text: 'POST /api/items → 400 (2ms)', flags: [] }]))
  ui = { scenarios: [{ scenario: { id: 's-01', kind: 'retry', title: 'Retry', goal: r.goal }, steps: add, findings: [], recording: 'rec-9', outcome: 'ok' }], findings: [] }
  await F.afterUiTest(repo(), 'run7', autoGen(repoDir))
  const after = F.getFinding('r1', k.id)!; assert.deepEqual([after.state, after.checks.at(-1)!.how], ['fixed', 'retry'])
})
test('a cancelled fix ticket sends its finding back to the user; a UI finding the checker wrote is judged from its replay\'s recording, never retried in its words', async () => {
  F.keep('r1', 'run8', [{ source: 'ui', by: 'checker', what: 'The page said "Added" though the handler stored an empty record.', expected: 'An error saying the name is missing.',
    steps: add, evidence: { scenario: 's-03', goal: 'add an item with no name', rows: ['the page shows "Added"'], flags: [] } }])
  const k = F.findingsOf('r1').at(-1)!; F.decideFinding('r1', k.id, { decision: 'fix' }); await F.sendFindings('r1')
  F.createFixTicket('r1', { finding: k.id, title: 'Say the name is missing', size: 'S', spec: 'x', criteria: [{ kind: 'ui', text: 'An empty name shows an error' }] })
  const key = F.getFinding('r1', k.id)!.tickets[0]!, { setTicket } = await import('./records.ts')
  setTicket(ticketInRepo('r1', key)!.id, { status: 'cancelled' })
  const back = F.getFinding('r1', k.id)!; assert.deepEqual([back.state, back.tickets, back.strikes], ['new', [], 0]); assert.match(back.back!, new RegExp(`${key} was cancelled`))
  F.decideFinding('r1', k.id, { decision: 'fix' }); await F.sendFindings('r1')
  F.createFixTicket('r1', { finding: k.id, title: 'Say the name is missing, again', size: 'S', spec: 'x', criteria: [{ kind: 'ui', text: 'An empty name shows an error' }] })
  run("UPDATE tickets SET status = 'merged', updated_at = ? WHERE key = ?", Date.now() + 30, F.getFinding('r1', k.id)!.tickets[0]!)
  replayed = { ...rec('rep-4', [{ at: 1, source: 'browser', text: 'the page shows "Name is missing"', flags: [] }],
    { scenarios: [{ scenario: 'replay', clean: true, line: 'the page said the name is missing', findings: [] }] }), steps: add.map(() => ({ ok: true })) }
  const b = await F.beforeUiTest(repo(), 'run9', autoGen(repoDir)); assert.ok(b !== 'stopped'); assert.equal(b.retry.length, 0)
  const after = F.getFinding('r1', k.id)!; assert.deepEqual([after.state, after.checks.at(-1)!.how], ['fixed', 'checker'])
})
test('testing off: nothing is replayed or checked; Clear takes a project\'s findings with it', async () => {
  setSetting('tester', 'off'); const n = calls().length, r = replays
  assert.deepEqual(await F.beforeUiTest(repo(), 'run5', autoGen(repoDir)), { retry: [] }); assert.equal(await F.afterUiTest(repo(), 'run5', autoGen(repoDir)), 'done')
  assert.equal(calls().length, n); assert.equal(replays, r); setSetting('tester', 'on')
  // the project's own switch (repos.ui_test, the UI tester's migration 31)
  run("UPDATE repos SET ui_test = 'off' WHERE id = 'r1'")
  assert.equal(F.testingOn('r1'), false); assert.equal(await F.afterUiTest(repo(), 'run6b', autoGen(repoDir)), 'done'); assert.equal(calls().length, n)
  run("UPDATE repos SET ui_test = NULL WHERE id = 'r1'"); assert.equal(F.testingOn('r1'), true)
  F.dropFindings('r1'); assert.deepEqual(F.findingsOf('r1'), []); assert.equal(F.stageDone('r1', 'run1'), false)
})

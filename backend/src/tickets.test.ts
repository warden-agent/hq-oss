// Ticket and feature rules against a real SQLite DB in a temp HQ_HOME (no agents launched): a feature's file, PROJECT.md and the
// TPM's briefing carry what a new TPM session needs (Bug 7, Bug 52), the old TPM's id reaches its successor, ticket keys count up
// per project, and Merge into main refuses what it can't merge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-tickets-'))
const { migrate, run, q } = await import('./db.ts')
migrate()
const { addFeature, createTicket, cancelFeature, cancelTicket, hqOpened, withTpmText } = await import('./tickets.ts')
const { restartTpm } = await import('./tpm.ts')
const { tpmPrompt } = await import('./handover.ts')
const { writeFeatureMd, tpmWorkspace } = await import('./projectmd.ts')
const { getFeature, getRepo, getTicket, tickets } = await import('./records.ts')
const { mergeTicket } = await import('./mergewatch.ts')
const { nextWorkerSlot, releaseSlot, slotBasesNow } = await import('./slots.ts')
const SLOT_BASES = slotBasesNow()
const { resolveRecipient } = await import('./delivery.ts')

const now = Date.now()
run(`INSERT INTO repos(id, name, path, kind, remote, created_at) VALUES ('r1', 'demo', '/tmp/demo', 'local', NULL, ?),
  ('r2', 'notes', '/tmp/notes', 'github', 'https://github.com/o/notes.git', ?)`, now, now)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, merge_order, handle, created_at, updated_at) VALUES ('f1', 'r1', 'item-list', 'item list', 'I keep losing track of my stock.', 'planning', '[\"APP-1\",\"APP-2\"]', 'F-1', ?, ?)", now, now)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, handle, created_at, updated_at) VALUES ('f2', 'r2', 'ui', 'ui', 'x', 'planning', 'F-1', ?, ?)", now, now)
run("UPDATE repos SET tpm_agent_id = 'tpm-old', next_ticket = 3, next_feature = 2 WHERE id = 'r1'")
const tk = (id: string, f: string, key: string, title: string, status: string, o: { deps?: string[]; branch?: string; pr_state?: string; spec?: string } = {}) =>
  run('INSERT INTO tickets(id, feature_id, key, slug, title, status, deps, branch, pr_state, spec, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id, f, key, key.toLowerCase(), title, status, JSON.stringify(o.deps ?? []), o.branch ?? null, o.pr_state ?? null, o.spec ?? null, now, now)
tk('t1', 'f1', 'APP-1', 'Items API', 'pr_ready', { branch: 'hq/item-list/APP-1-api', pr_state: 'local', spec: 'Store items in data/items.json.' })
tk('t2', 'f1', 'APP-2', 'Item list page', 'queued', { deps: ['APP-1'], spec: 'A page to add, change and remove items.' })
tk('t3', 'f2', 'UI-1', 'Tokens', 'pr_open', { branch: 'hq/ui/UI-1', pr_state: 'open' })
tk('t4', 'f2', 'UI-2', 'Colors', 'pr_ready', { branch: 'hq/ui/UI-2', pr_state: 'local' }) // finished while HQ couldn't push
run("INSERT INTO docs(scope, key, text, updated_at) VALUES ('feature:f1', 'Decisions', 'Store data in a JSON file, no database.', ?)", now)
const agent = (id: string, role: string, status: string, feature: string | null, ticket: string | null = null) =>
  run('INSERT INTO agents(id, role, repo_id, feature_id, ticket_id, model_alias, token_hash, status, started_at) VALUES (?,?,?,?,?,?,?,?,?)', id, role, 'r1', feature, ticket, 'opus', id, status, now)
agent('tpm-old', 'tpm', 'exited', null); agent('eng-2', 'engineer', 'working', 'f1', 't2')

test('a feature\'s file carries the request, tickets, decisions and every spec; PROJECT.md the board (Bug 52)', () => {
  const file = writeFeatureMd(getFeature('f1')!)
  assert.equal(file, path.join(tpmWorkspace('r1'), 'features', 'F-1.md'))
  const md = fs.readFileSync(file, 'utf8')
  assert.match(md, /## Request \(verbatim\)\n\nI keep losing track of my stock\./)
  assert.match(md, /\| APP-1 \| M \| pr_ready \| \[\] \|/)
  assert.match(md, /## Decisions\n\n### Decisions\nStore data in a JSON file, no database\./)
  assert.match(md, /## Ticket specs\n\n### APP-1: Items API\nStore items in data\/items\.json\.\n\n### APP-2: Item list page\nA page to add, change and remove items\./)
  const project = fs.readFileSync(path.join(tpmWorkspace('r1'), 'PROJECT.md'), 'utf8')
  assert.match(project, /## Built so far\n\nNothing merged yet\./)
  assert.match(project, /## On the board now\n\n### F-1 item list \(features\/F-1\.md\)\n\n> I keep losing track of my stock\.\n\n- APP-1 \(M\) Items API: pr_ready\n- APP-2 \(M\) Item list page: queued/)
})

test('the TPM\'s briefing says where each ticket stands, quotes recent talk and its note, and what to do first; a message makes it act on it', () => {
  const board = [{ f: getFeature('f1')!, tickets: tickets('f1') }]
  const p = tpmPrompt(getRepo('r1')!, { ws: '/ws', previous: 'tpm-old', note: '## Decisions so far\n- JSON file', board,
    messages: [{ from_id: 'user', body: 'Can you make it work on my phone too?' }, { from_id: 'tpm-old', body: 'Yes, APP-2 covers phones.' }] as never })
  assert.match(p, /^You are taking over as the TPM of project "demo" \(read-only copy at \/tmp\/demo; your workspace is \/ws\)\. The previous TPM session \(tpm-old\) has ended/)
  assert.match(p, /On the board now:\n- F-1 item list\n  - APP-1 \(M\) Items API: finished; waits for the user to merge it · branch hq\/item-list\/APP-1-api\n  - APP-2 \(M\) Item list page: waits for APP-1 to merge\n/)
  assert.match(p, /Last messages between the user and the TPM, oldest first:\n- User: Can you make it work on my phone too\?\n- TPM: Yes, APP-2 covers phones\.\n/)
  assert.match(p, /The previous TPM's handoff note .*\n## Decisions so far\n- JSON file/)
  assert.match(p, /First read PROJECT\.md and call list_tickets, then tell the user in two or three lines/)
  const first = tpmPrompt(getRepo('r1')!, { ws: '/ws', previous: null, board: [], messages: [], message: 'add a contact list' })
  assert.match(first, /^You are the TPM of project "demo"/); assert.match(first, /On the board now:\n- nothing/)
  assert.match(first, /The user's new message, verbatim:\n"""\nadd a contact list\n"""\n\nAct on it\. New work: start_feature, then create_ticket/)
  assert.match(tpmPrompt(getRepo('r1')!, { ws: '/ws', previous: null, note: 'n', board: [], messages: [], cleared: true }), /The user just cleared the board: every ticket that was on it is gone/)
})

test('Bug 163: the TPM\'s briefing says whether auto mode is on either way, and that history from the other mode no longer holds', () => {
  const talk = [{ from_id: 'tpm-old', body: 'HQ ran the tests before each merge.' }] as never
  const brief = (auto: number, o: { messages?: never; note?: string } = {}) =>
    tpmPrompt({ ...getRepo('r1')!, auto_mode: auto }, { ws: '/ws', previous: 'tpm-old', board: [], messages: o.messages ?? ([] as never), note: o.note })
  const off = brief(0, { messages: talk })
  assert.match(off, /\n\nAuto mode is off for this project: the user starts tickets, approves plans and merges from HQ, and HQ runs no tests before a merge\./)
  assert.match(off, /HQ runs no tests before a merge\. Don't tell the user HQ tested or merged anything by itself; each "merged" notice says what HQ ran\./)
  assert.match(off, /If earlier messages or the handoff note say HQ starts, tests or merges tickets by itself, that was while auto mode was on\./)
  assert.doesNotMatch(off, /Auto mode is on/)
  assert.match(brief(0, { note: 'HQ tests each ticket.' }), /that was while auto mode was on\./) // a note is history too
  assert.doesNotMatch(brief(0), /earlier messages/, 'nothing earlier: nothing to warn about')
  const on = brief(1, { messages: talk })
  assert.match(on, /\n\nAuto mode is on for this project: HQ starts ready tickets when your turn ends, approves plans, tests finished tickets on main,/)
  assert.match(on, /tests finished tickets on main, merges them and fixes conflicts\. Follow the Auto mode rule in your instructions\./)
  assert.match(on, /If earlier messages or the handoff note say the user starts or merges tickets, that was while auto mode was off\./)
  assert.doesNotMatch(on, /Auto mode is off|runs no tests/)
  assert.doesNotMatch(brief(1), /earlier messages/)
  assert.match(tpmPrompt({ ...getRepo('r1')!, auto_mode: 0 }, { ws: '/ws', previous: null, board: [], messages: [], message: 'hi' }), /Auto mode is off for this project/) // a first start too
})

test('Bug 193: on auto, the TPM\'s briefing says HQ starts, checks, tests and merges tickets; off, the user does, as before', () => {
  const base = { feature_id: 'f9', size: 'S', deps: '[]', go_ahead: 0, auto_parked_why: null, pr_state: null, pr_number: null, branch: null } as const
  const board = [
    { ...base, key: 'X-1', title: 'Ready', status: 'queued' }, { ...base, key: 'X-2', title: 'Plan', status: 'plan_review' },
    { ...base, key: 'X-3', title: 'Local', status: 'pr_ready', pr_state: 'local' }, { ...base, key: 'X-4', title: 'Pushed', status: 'pr_ready', pr_state: 'pushed' },
    { ...base, key: 'X-5', title: 'Open', status: 'pr_open', pr_state: 'open', pr_number: 7 },
    { ...base, key: 'X-6', title: 'Parked', status: 'pr_ready', pr_state: 'local', auto_parked_why: 'Its tests still fail on main after 2 fixes.' },
  ] as never[]
  const brief = (r: object, localOnly = false) => tpmPrompt({ ...getRepo('r1')!, ...r } as never, { ws: '/ws', previous: null, messages: [], localOnly,
    board: [{ f: { title: 'Nine', handle: 'F-9' } as never, tickets: board }] })
  const on = brief({ auto_mode: 1 })
  assert.match(on, /X-1 \(S\) Ready: ready; HQ starts it when your turn ends\n/)
  assert.match(on, /X-2 \(S\) Plan: HQ checks its plan, then approves it or sends it back\n/)
  assert.match(on, /X-3 \(S\) Local: finished; HQ tests it on main and merges it\n/)
  assert.match(on, /X-4 \(S\) Pushed: finished and pushed; HQ tests it on main, opens its PR and merges it\n/)
  assert.match(on, /X-5 \(S\) Open: finished; HQ tests PR #7 on main and merges it\n/)
  // a parked ticket is the user's again (its Merge button is back): the words say so, and why
  assert.match(on, /X-6 \(S\) Parked: finished; waits for the user to merge it \(auto mode parked it: Its tests still fail on main after 2 fixes\)\n/)
  assert.doesNotMatch(on.replace(/X-6 [^\n]*/, ''), /the user starts it|the user's review|waits for the user|the user's merge|PR still needs opening/)
  assert.doesNotMatch(on, /It is stopped right now/)
  const off = brief({ auto_mode: 0 }) // manual mode: word for word as before
  assert.match(off, /X-1 \(S\) Ready: ready to start \(the user starts it from HQ\)\n/)
  assert.match(off, /X-2 \(S\) Plan: its plan waits for the user's review\n/)
  assert.match(off, /X-3 \(S\) Local: finished; waits for the user to merge it\n/)
  assert.match(off, /X-4 \(S\) Pushed: finished and pushed; its PR still needs opening\n/)
  assert.match(off, /X-5 \(S\) Open: finished; PR #7 waits for the user's merge\n/)
  assert.match(off, /X-6 \(S\) Parked: finished; waits for the user to merge it\n/) // parked means nothing with auto off
  assert.doesNotMatch(off, /HQ starts it|HQ tests|HQ checks its plan|parked/)
  // auto stopped: nothing starts or merges by itself until Resume, but plans are still checked
  const stopped = brief({ auto_mode: 1, auto_stopped_why: "HQ couldn't test X-3: its branch is gone." })
  assert.match(stopped, /It is stopped right now \(HQ couldn't test X-3: its branch is gone\): nothing starts or merges by itself until the user presses Resume, and meanwhile the user starts/)
  assert.match(stopped, /X-1 \(S\) Ready: ready to start \(the user starts it from HQ\)\n/)
  assert.match(stopped, /X-2 \(S\) Plan: HQ checks its plan, then approves it or sends it back\n/)
  assert.match(stopped, /X-3 \(S\) Local: finished; waits for the user to merge it\n/)
  // a project HQ can't push to
  assert.match(brief({ auto_mode: 1, default_branch: 'main' }, true), /no PRs; HQ merges finished tickets into the local main\./)
  assert.match(brief({ auto_mode: 0, default_branch: 'main' }, true), /no PRs; the user merges finished tickets into the local main from HQ\./)
  // Bug 210: a project whose default branch is master says master everywhere, the board's lines and the mode line alike
  const master = brief({ auto_mode: 1, default_branch: 'master' })
  assert.match(master, /tests finished tickets on master, merges them and fixes conflicts\. Follow the Auto mode rule/)
  assert.match(master, /X-3 \(S\) Local: finished; HQ tests it on master and merges it\n/)
  assert.match(master, /X-4 \(S\) Pushed: finished and pushed; HQ tests it on master, opens its PR and merges it\n/)
  assert.match(master, /X-5 \(S\) Open: finished; HQ tests PR #7 on master and merges it\n/)
  assert.doesNotMatch(master.replace(/X-6 [^\n]*/, ''), /\bmain\b/) // X-6's parked reason is HQ's own text from the test data
})

test("Bug 243: a finished ticket that conflicts with main says so on the TPM's board, with its files and who presses Fix conflicts", () => {
  const base = { feature_id: 'f9', size: 'S', deps: '[]', go_ahead: 0, auto_parked_why: null, pr_number: null, branch: null, conflict_with: null } as const
  const clash = { conflict_files: '["src/app.js","README.md"]', conflict_with: '["T-01"]' }
  const board = [
    { ...base, key: 'T-02', title: 'Local', status: 'pr_ready', pr_state: 'local', ...clash },
    { ...base, key: 'T-03', title: 'Pushed', status: 'pr_ready', pr_state: 'pushed', conflict_files: '[]' }, // GitHub says so, no files known yet
    { ...base, key: 'T-04', title: 'Open', status: 'pr_open', pr_state: 'open', pr_number: 7, ...clash },
    { ...base, key: 'T-05', title: 'Clean', status: 'pr_ready', pr_state: 'local', conflict_files: null },
    { ...base, key: 'T-06', title: 'Parked', status: 'pr_ready', pr_state: 'local', ...clash, auto_parked_why: "Its conflicts with main weren't fixed in 2 tries." },
  ] as never[]
  const brief = (r: object) => tpmPrompt({ ...getRepo('r1')!, ...r } as never, { ws: '/ws', previous: null, messages: [], board: [{ f: { title: 'Nine', handle: 'F-9' } as never, tickets: board }] })
  const off = brief({ auto_mode: 0 })
  assert.match(off, /T-02 \(S\) Local: finished, but it conflicts with main in src\/app\.js, README\.md \(T-01 merged first\); the user presses Fix conflicts in HQ, and its engineer merges main in\n/)
  assert.match(off, /T-03 \(S\) Pushed: finished and pushed, but it conflicts with main; the user presses Fix conflicts in HQ, and its engineer merges main in\n/)
  assert.match(off, /T-04 \(S\) Open: finished, but PR #7 conflicts with main in src\/app\.js, README\.md \(T-01 merged first\); the user presses Fix conflicts/)
  assert.match(off, /T-05 \(S\) Clean: finished; waits for the user to merge it\n/) // what it must not catch: a clean one reads as before
  assert.doesNotMatch(off.replace(/T-05 [^\n]*/, ''), /waits for the user to merge it|waits for the user's merge|HQ has its engineer/)
  const on = brief({ auto_mode: 1 })
  assert.match(on, /T-02 \(S\) Local: finished, but it conflicts with main in src\/app\.js, README\.md \(T-01 merged first\); HQ has its engineer merge main in and fix them\n/)
  assert.match(on, /T-04 \(S\) Open: finished, but PR #7 conflicts with main in [^\n]*; HQ has its engineer merge main in and fix them\n/)
  assert.match(on, /T-05 \(S\) Clean: finished; HQ tests it on main and merges it\n/)
  // parked, or auto stopped: the user's Fix conflicts again, as the box's button says
  assert.match(on, /T-06 \(S\) Parked: finished, but it conflicts with main [^\n]*; the user presses Fix conflicts in HQ, and its engineer merges main in \(auto mode parked it: Its conflicts/)
  const stopped = brief({ auto_mode: 1, auto_stopped_why: 'HQ couldn\'t test T-05.' })
  assert.match(stopped, /T-02 \(S\) Local: finished, but it conflicts with main [^\n]*; the user presses Fix conflicts in HQ/)
  // Bug 210: the project's own default branch
  const master = brief({ auto_mode: 0, default_branch: 'master' })
  assert.match(master, /T-02 \(S\) Local: finished, but it conflicts with master in src\/app\.js, README\.md \(T-01 merged first\); the user presses Fix conflicts in HQ,/)
  assert.match(master, /T-02 [^\n]*and its engineer merges master in\n/); assert.doesNotMatch(master, /\bmain\b/)
})

test('an engineer that still uses the old TPM\'s id reaches the project\'s current TPM', () => {
  const eng = q<any>("SELECT * FROM agents WHERE id = 'eng-2'")[0]
  assert.equal(resolveRecipient(eng, 'tpm-old'), 'tpm-old') // not replaced yet: same as "tpm"
  agent('tpm-new', 'tpm', 'working', null); run("UPDATE repos SET tpm_agent_id = 'tpm-new' WHERE id = 'r1'")
  assert.equal(resolveRecipient(eng, 'tpm-old'), 'tpm-new'); assert.equal(resolveRecipient(eng, 'tpm'), 'tpm-new')
  assert.equal(resolveRecipient(eng, 'nobody'), null)
})

test('restartTpm refuses a project whose TPM still runs, and unknown repos', async () => {
  await assert.rejects(restartTpm('r1'), /^Error: demo's TPM is already running \(tpm-new\)\.$/)
  await assert.rejects(restartTpm('nope'), /unknown repo/)
})

test('features get handles and ticket keys count up per project, past any key already there (Bug 52)', () => {
  const f = addFeature('r1', 'Contact list', 'a contact list please')
  assert.equal(f.handle, 'F-2'); assert.equal(getRepo('r1')!.next_feature, 3)
  run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES ('t-taken', 'f1', 'T-04', 't', 'taken', 'queued', ?, ?)", now, now)
  const keys = ['a', 'b'].map((x) => createTicket(f.id, { title: x, size: 'S', spec: x }).key)
  assert.deepEqual(keys, ['T-03', 'T-05']) // T-04 is taken in another feature of the project: skipped
  assert.throws(() => createTicket(f.id, { key: 'APP-1', title: 'x', size: 'S', spec: 'x' }), /ticket APP-1 exists/) // unique in the project, not only the feature
  assert.equal(createTicket('f2', { title: 'other repo', size: 'S', spec: 'x' }).key, 'T-01') // each project counts on its own
})

test('Bug 108: a ticket HQ opened keeps HQ\'s spec; the TPM\'s text goes under it, and a later one replaces only the TPM\'s', () => {
  const hq = '## What\nmain\'s own tests fail.\n\n## Rules\n- Don\'t delete or weaken a test.'
  const kept = (id: string) => q<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key = 'hq_spec'", `ticket:${id}`).map((d) => d.text)
  const r = createTicket('f1', { title: 'Fix main\'s tests', size: 'S', spec: hq, repairs_main: 'abc123' })
  assert.equal(hqOpened(r), true); assert.deepEqual(kept(r.id), [hq])
  const one = withTpmText(r, '  Only the offline tests.\n')
  assert.equal(one, `${hq}\n\n## From the TPM\nThe TPM added this. HQ's steps and rules above still hold.\n\nOnly the offline tests.`)
  run('UPDATE tickets SET spec = ? WHERE id = ?', one, r.id)
  const two = withTpmText(getTicket(r.id)!, 'Leave the date tests alone.') // built on HQ's own, not on the spec as it stands
  assert.ok(two.startsWith(`${hq}\n\n## From the TPM\n`)); assert.ok(two.endsWith('\n\nLeave the date tests alone.')); assert.ok(!two.includes('offline'))
  assert.equal(two.split('## From the TPM').length, 2); assert.deepEqual(kept(r.id), [hq])
  // a repair opened before HQ kept its spec aside: what it says now counts as HQ's, from then on
  run(`INSERT INTO tickets(id, feature_id, key, slug, title, status, spec, repairs_main, created_at, updated_at)
    VALUES ('t-old', 'f1', 'APP-7', 'old', 'Fix main', 'queued', 'Old steps.', 'abc', ?, ?)`, now, now)
  assert.ok(withTpmText(getTicket('t-old')!, 'A.').startsWith('Old steps.\n\n## From the TPM\n')); assert.deepEqual(kept('t-old'), ['Old steps.'])
  // the TPM's own tickets aren't HQ's: nothing is kept aside for them
  const mine = createTicket('f1', { title: 'Shelf', size: 'S', spec: 'A shelf.' }); assert.equal(hqOpened(mine), false); assert.deepEqual(kept(mine.id), [])
})

test('Merge refuses tickets that aren\'t finished; GitHub repos merge on GitHub (Bug 45)', async () => {
  await assert.rejects(mergeTicket('t3'), /notes does not exist/) // no longer refused: HQ syncs with GitHub first (the fake path fails there)
  await assert.rejects(mergeTicket('t4'), (e: Error) => !/is on GitHub/.test(e.message)) // finished locally: merged here (git fails on the fake path)
  await assert.rejects(mergeTicket('t2'), /^Error: APP-2 isn't finished yet \(queued\)\.$/)
  await assert.rejects(mergeTicket('nope'), /unknown ticket/)
})

test('Worker slots: ports never overlap, and a slot whose agent is gone is free again', async () => {
  const free = async () => false, base = async (id: string) => Number((await nextWorkerSlot(id, free)).env.HQ_PORT_BASE)
  agent('eng-a', 'engineer', 'working', 'f1'); agent('eng-b', 'engineer', 'working', 'f1')
  const a = await nextWorkerSlot('eng-a', free); assert.equal(a.idx, 1); assert.equal(a.env.PORT, a.env.HQ_PORT_BASE)
  assert.equal(a.env.HQ_PORT_BASE, String(SLOT_BASES[0])); assert.equal(a.env.DB_NAME, `hq_w1_${SLOT_BASES[0]}`)
  assert.equal((await nextWorkerSlot('pending-x', free)).idx, 2) // a launch under way holds its slot
  const b = await nextWorkerSlot('eng-b', free); assert.equal(b.idx, 3); assert.equal(b.env.HQ_PORT_BASE, String(SLOT_BASES[2]))
  run("UPDATE agents SET status = 'exited' WHERE id = 'eng-a'") // gone without its slot being released
  agent('eng-c', 'engineer', 'working', 'f1'); const c = await nextWorkerSlot('eng-c', free); assert.equal(c.idx, 1); assert.equal(c.env.HQ_PORT_BASE, String(SLOT_BASES[0]))
  releaseSlot('pending-x'); agent('eng-d', 'engineer', 'working', 'f1'); assert.equal(await base('eng-d'), SLOT_BASES[1])
  // Bug 259: a block something on the machine already listens on (another HQ's engineer, any program) is skipped, whatever its slot number
  agent('eng-e', 'engineer', 'working', 'f1'); const busy = async (p: number) => p === SLOT_BASES[3]! + 7
  const e = await nextWorkerSlot('eng-e', busy); assert.equal(e.idx, 4); assert.equal(e.env.HQ_PORT_BASE, String(SLOT_BASES[4]))
  assert.equal(e.env.HQ_WORKER, '4'); assert.equal(e.env.DB_NAME, `hq_w4_${SLOT_BASES[4]}`)
  // two launches at once never get the same block, though both found it free
  agent('eng-f', 'engineer', 'working', 'f1'); agent('eng-g', 'engineer', 'working', 'f1')
  const [f, g] = await Promise.all([nextWorkerSlot('eng-f', free), nextWorkerSlot('eng-g', free)])
  assert.notEqual(f.idx, g.idx); assert.notEqual(f.env.HQ_PORT_BASE, g.env.HQ_PORT_BASE)
  // every block in use: a plain refusal, nothing written
  const before = q('SELECT * FROM worker_slots').length
  await assert.rejects(nextWorkerSlot('eng-h', async () => true), /No free ports for another engineer: HQ's engineer ports \d+–\d+ are all in use \(by its engineers or other programs\)\./)
  assert.equal(q('SELECT * FROM worker_slots').length, before)
})

test('Cancel: a merged ticket refuses; a cancelled one stays cancelled', async () => {
  tk('t9', 'f1', 'APP-9', 'Done already', 'merged')
  await assert.rejects(cancelTicket('t9'), /APP-9 is already merged/)
  tk('t10', 'f1', 'APP-10', 'Not needed', 'queued')
  assert.deepEqual(await cancelTicket('t10', { tell: false }), { key: 'APP-10', stopped: null })
  assert.equal(tickets('f1').find((t) => t.id === 't10')!.status, 'cancelled')
  assert.deepEqual(await cancelTicket('t10', { tell: false }), { key: 'APP-10', stopped: null })
})

test('Bug 250: a feature\'s file says where it stands in the board\'s words, not its stored "planning", and is rewritten when cancelled', async () => {
  const status = (f: { handle: string | null }) => /^status: (.*)$/m.exec(fs.readFileSync(path.join(tpmWorkspace('r1'), 'features', `${f.handle}.md`), 'utf8'))?.[1]
  const f = addFeature('r1', 'Bug 250 list', 'a list'); assert.equal(status(f), 'no tickets yet')
  const a = createTicket(f.id, { title: 'one', size: 'S', spec: 'x' }); createTicket(f.id, { title: 'two', size: 'S', spec: 'x' })
  assert.equal(status(f), '0/2 merged')
  run("UPDATE tickets SET status = 'merged' WHERE id = ?", a.id); writeFeatureMd(getFeature(f.id)!)
  assert.equal(status(f), '1/2 merged'); assert.equal(getFeature(f.id)!.status, 'planning', 'the stored word is unchanged: only the file\'s words moved')
  await cancelFeature(f.id)
  assert.equal(status(f), 'cancelled · 1 merged before that', 'rewritten after the feature itself was marked cancelled, not "done" for its merged part')
})

test('Bug 126: what the TPM hears HQ ran on a ticket before it merged', async () => {
  const { testedWords } = await import('./mergewatch.ts')
  assert.equal(testedWords({ ran: 'none', by: 'user', at: 1 }, 'main'), 'The user merged it with Merge, which runs no tests: HQ did not test it as it merged.')
  assert.equal(testedWords({ ran: 'none', by: 'outside', at: 1 }, 'main'), 'It was merged outside HQ, so HQ did not test it as it merged.')
  const pass = { ran: 'pass' as const, test: 'uv run pytest -q', counts: { passed: 410, failed: 0, skipped: 6 }, ms: 81_200, on: 'main', at: 1 }
  assert.equal(testedWords(pass, 'main'), "HQ's tests passed on main first (`uv run pytest -q`: 410 passed, 6 skipped, 1 min 21 s).")
  assert.equal(testedWords({ ...pass, counts: null, ms: 900 }, 'trunk'), "HQ's tests passed on trunk first (`uv run pytest -q`, 1 s).")
  assert.match(testedWords({ ...pass, test: `npm test -- ${'x'.repeat(300)}` }, 'main'), /^HQ's tests passed on main first \(`npm test -- x{105}\.\.\.`: 410/, 'a long command is cut')
})

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
const { addFeature, createTicket, cancelTicket } = await import('./tickets.ts')
const { restartTpm } = await import('./tpm.ts')
const { tpmPrompt } = await import('./handover.ts')
const { writeFeatureMd, tpmWorkspace } = await import('./projectmd.ts')
const { getFeature, getRepo, tickets } = await import('./records.ts')
const { mergeTicket } = await import('./mergewatch.ts')
const { nextWorkerSlot, releaseSlot, slotEnv } = await import('./slots.ts')
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

test('Merge refuses tickets that aren\'t finished; GitHub repos merge on GitHub (Bug 45)', async () => {
  await assert.rejects(mergeTicket('t3'), /notes does not exist/) // no longer refused: HQ syncs with GitHub first (the fake path fails there)
  await assert.rejects(mergeTicket('t4'), (e: Error) => !/is on GitHub/.test(e.message)) // finished locally: merged here (git fails on the fake path)
  await assert.rejects(mergeTicket('t2'), /^Error: APP-2 isn't finished yet \(queued\)\.$/)
  await assert.rejects(mergeTicket('nope'), /unknown ticket/)
})

test('Worker slots: ports never overlap, and a slot whose agent is gone is free again', () => {
  const ports = (i: number) => { const b = Number(slotEnv(i).HQ_PORT_BASE); return [b, b + 9] }
  for (let i = 1; i <= 20; i++) { assert.equal(slotEnv(i).PORT, slotEnv(i).HQ_PORT_BASE); assert.ok(ports(i)[1]! < ports(i + 1)[0]!); assert.ok(ports(i)[0]! > 3099) } // the preview uses 3090-3099
  agent('eng-a', 'engineer', 'working', 'f1'); agent('eng-b', 'engineer', 'working', 'f1')
  assert.equal(nextWorkerSlot('eng-a').idx, 1); assert.equal(nextWorkerSlot('pending-x').idx, 2) // a launch under way holds its slot
  assert.equal(nextWorkerSlot('eng-b').idx, 3)
  run("UPDATE agents SET status = 'exited' WHERE id = 'eng-a'") // gone without its slot being released
  agent('eng-c', 'engineer', 'working', 'f1'); assert.equal(nextWorkerSlot('eng-c').idx, 1)
  releaseSlot('pending-x'); assert.equal(nextWorkerSlot('eng-d').idx, 2)
})

test('Cancel: a merged ticket refuses; a cancelled one stays cancelled', async () => {
  tk('t9', 'f1', 'APP-9', 'Done already', 'merged')
  await assert.rejects(cancelTicket('t9'), /APP-9 is already merged/)
  tk('t10', 'f1', 'APP-10', 'Not needed', 'queued')
  assert.deepEqual(await cancelTicket('t10', { tell: false }), { key: 'APP-10', stopped: null })
  assert.equal(tickets('f1').find((t) => t.id === 't10')!.status, 'cancelled')
  assert.deepEqual(await cancelTicket('t10', { tell: false }), { key: 'APP-10', stopped: null })
})

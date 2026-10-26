// Ticket and feature rules against a real SQLite DB in a temp HQ_HOME (no agents launched): FEATURE.md and the TPM handover
// carry what a new TPM needs (Bug 7), the old TPM's id reaches its successor, and Merge into main refuses what it can't merge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-tickets-'))
const { migrate, run, q } = await import('./db.ts')
migrate()
const { writeFeatureMd, restartTpm, cancelTicket } = await import('./tickets.ts')
const { handoverPrompt } = await import('./handover.ts')
const { getFeature, getRepo, tickets } = await import('./records.ts')
const { mergeTicket } = await import('./mergewatch.ts')
const { nextWorkerSlot, releaseSlot, slotEnv } = await import('./slots.ts')
const { resolveRecipient } = await import('./delivery.ts')

const now = Date.now()
run("INSERT INTO repos(id, name, path, kind, created_at) VALUES ('r1', 'pantry', '/tmp/pantry', 'local', ?), ('r2', 'tangents', '/tmp/tangents', 'github', ?)", now, now)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, tpm_agent_id, merge_order, created_at, updated_at) VALUES ('f1', 'r1', 'kitchen-list', 'kitchen list', 'I keep forgetting what is in my kitchen.', 'planning', 'tpm-old', '[\"PAN-1\",\"PAN-2\"]', ?, ?)", now, now)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('f2', 'r2', 'ui', 'ui', 'x', 'planning', ?, ?)", now, now)
const tk = (id: string, f: string, key: string, title: string, status: string, o: { deps?: string[]; branch?: string; pr_state?: string; spec?: string } = {}) =>
  run('INSERT INTO tickets(id, feature_id, key, slug, title, status, deps, branch, pr_state, spec, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id, f, key, key.toLowerCase(), title, status, JSON.stringify(o.deps ?? []), o.branch ?? null, o.pr_state ?? null, o.spec ?? null, now, now)
tk('t1', 'f1', 'PAN-1', 'Kitchen items API', 'pr_ready', { branch: 'hq/kitchen-list/PAN-1-api', pr_state: 'local', spec: 'Store items in data/items.json.' })
tk('t2', 'f1', 'PAN-2', 'Kitchen list page', 'queued', { deps: ['PAN-1'], spec: 'A page to add, change and remove items.' })
tk('t3', 'f2', 'UI-1', 'Tokens', 'pr_open', { branch: 'hq/ui/UI-1', pr_state: 'open' })
run("INSERT INTO docs(scope, key, text, updated_at) VALUES ('feature:f1', 'Decisions', 'Store data in a JSON file, no database.', ?)", now)
const agent = (id: string, role: string, status: string, feature: string, ticket: string | null = null) =>
  run('INSERT INTO agents(id, role, feature_id, ticket_id, model_alias, token_hash, status, started_at) VALUES (?,?,?,?,?,?,?,?)', id, role, feature, ticket, 'opus', id, status, now)
agent('tpm-old', 'tpm', 'exited', 'f1'); agent('eng-2', 'engineer', 'working', 'f1', 't2')

test('FEATURE.md carries the request, tickets, decisions and every spec', () => {
  const md = fs.readFileSync(path.join(writeFeatureMd(getFeature('f1')!), 'FEATURE.md'), 'utf8')
  assert.match(md, /## Request \(verbatim\)\n\nI keep forgetting what is in my kitchen\./)
  assert.match(md, /\| PAN-1 \| M \| pr_ready \| \[\] \|/)
  assert.match(md, /## Decisions\n\n### Decisions\nStore data in a JSON file, no database\./)
  assert.match(md, /## Ticket specs\n\n### PAN-1: Kitchen items API\nStore items in data\/items\.json\.\n\n### PAN-2: Kitchen list page\nA page to add, change and remove items\./)
})

test('the handover prompt says where each ticket stands, quotes the request and recent talk, and what to do first', () => {
  const p = handoverPrompt(getFeature('f1')!, { repo: getRepo('r1')!, ws: '/ws', previous: 'tpm-old', tickets: tickets('f1'),
    messages: [{ from_id: 'user', body: 'Can you make it work on my phone too?' }, { from_id: 'tpm-old', body: 'Yes, PAN-2 covers phones.' }] as never })
  assert.match(p, /^You are taking over as TPM for the feature "kitchen list" in repo "pantry" \(read-only copy at \/tmp\/pantry; your workspace is \/ws with FEATURE\.md\)\. The previous TPM session \(tpm-old\) has ended/)
  assert.match(p, /"""\nI keep forgetting what is in my kitchen\.\n"""/)
  assert.match(p, /- PAN-1 \(M\) Kitchen items API: finished; waits for the user to merge it · branch hq\/kitchen-list\/PAN-1-api\n- PAN-2 \(M\) Kitchen list page: waits for PAN-1 to merge\n/)
  assert.match(p, /Last messages between the user and the TPM, oldest first:\n- User: Can you make it work on my phone too\?\n- TPM: Yes, PAN-2 covers phones\.\n/)
  assert.match(p, /Do not create or re-split tickets that already exist\. First read FEATURE\.md and call list_tickets, then tell the user in two or three lines/)
})

test('an engineer that still uses the old TPM\'s id reaches the feature\'s current TPM', () => {
  const eng = q<any>("SELECT * FROM agents WHERE id = 'eng-2'")[0]
  assert.equal(resolveRecipient(eng, 'tpm-old'), 'tpm-old') // not replaced yet: same as "tpm"
  agent('tpm-new', 'tpm', 'working', 'f1'); run("UPDATE features SET tpm_agent_id = 'tpm-new' WHERE id = 'f1'")
  assert.equal(resolveRecipient(eng, 'tpm-old'), 'tpm-new'); assert.equal(resolveRecipient(eng, 'tpm'), 'tpm-new')
  assert.equal(resolveRecipient(eng, 'nobody'), null)
})

test('restartTpm refuses a feature whose TPM still runs, and unknown features', async () => {
  await assert.rejects(restartTpm('f1'), /^Error: kitchen list already has a TPM running \(tpm-new\)$/)
  await assert.rejects(restartTpm('nope'), /unknown feature/)
})

test('Merge into main refuses GitHub repos and tickets that aren\'t finished', async () => {
  await assert.rejects(mergeTicket('t3'), /^Error: tangents is on GitHub: merge UI-1's PR there\.$/)
  await assert.rejects(mergeTicket('t2'), /^Error: PAN-2 isn't finished yet \(queued\)\.$/)
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
  tk('t9', 'f1', 'PAN-9', 'Done already', 'merged')
  await assert.rejects(cancelTicket('t9'), /PAN-9 is already merged/)
  tk('t10', 'f1', 'PAN-10', 'Not needed', 'queued')
  assert.deepEqual(await cancelTicket('t10', { tell: false }), { key: 'PAN-10', stopped: null })
  assert.equal(tickets('f1').find((t) => t.id === 't10')!.status, 'cancelled')
  assert.deepEqual(await cancelTicket('t10', { tell: false }), { key: 'PAN-10', stopped: null })
})

// Clear project against a real SQLite DB in a temp HQ_HOME and a real git repo: one repo's board goes and the other's stays,
// unsaved code becomes a WIP commit on its branch before the worktree goes, notes reach the archive, nothing new starts while
// a clear waits for notes, and an agent's note finishing a clear neither parks nor restarts it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-clear-'))
const { migrate, run, q, one } = await import('./db.ts')
migrate()
const { clearRepo, maybeFinishClear } = await import('./clear.ts')
const { completeFreshStart } = await import('./freshstart.ts')
const { createFeature, createTicket, launchEngineer } = await import('./tickets.ts')
const { restartTpm } = await import('./tpm.ts')
const { keptBuilt, tpmWorkspace } = await import('./projectmd.ts')
const { getRepo } = await import('./records.ts')
const { starting } = await import('./scheduler.ts')
const { PATHS } = await import('./config.ts')

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-clear-repo-'))
sh(repoDir, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repoDir, 'app.js'), 'one\n'); sh(repoDir, 'add', '.'); sh(repoDir, 'commit', '-qm', 'base')
const wt = path.join(repoDir, '.claude', 'worktrees', 'T1')
sh(repoDir, 'worktree', 'add', '-q', '-b', 'hq/list/T1-api', wt, 'main'); fs.writeFileSync(path.join(wt, 'app.js'), 'one\ntwo (half done)\n')

const now = Date.now()
run(`INSERT INTO repos(id, name, path, kind, created_at) VALUES ('r1', 'demo', ?, 'local', ?), ('r2', 'other', '/tmp/other', 'local', ?),
  ('r3', 'third', '/tmp/third', 'local', ?)`, repoDir, now, now, now)
const feature = (id: string, repo: string) => run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES (?,?,?,?,?,'planning',?,?)",
  id, repo, `list-${id}`, `List ${id}`, `I want a list (${id}).`, now, now)
const ticket = (id: string, f: string, key: string, status: string, o: { worktree?: string; branch?: string; go?: number } = {}) =>
  run('INSERT INTO tickets(id, feature_id, key, slug, title, status, branch, worktree_path, go_ahead, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, f, key, key.toLowerCase(), `${key} title`, status, o.branch ?? null, o.worktree ?? null, o.go ?? 0, now, now)
const agent = (id: string, role: string, status: string, f: string, t: string | null = null) =>
  run(`INSERT INTO agents(id, role, repo_id, feature_id, ticket_id, model_alias, token_hash, status, tmux_session, started_at)
    VALUES (?,?,(SELECT repo_id FROM features WHERE id = ?),?,?,'opus',?,?,'hq-clear-test-none',?)`, id, role, f, f, t, id, status, now)
const count = (table: string, where: string, ...p: string[]) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...p)!.n

for (const [f, r] of [['f1', 'r1'], ['f2', 'r2']] as const) {
  feature(f, r); const t = `${f}-t`, a = `${f}-eng`, tpm = `${f}-tpm`
  ticket(t, f, 'T1', 'implementing', f === 'f1' ? { worktree: wt, branch: 'hq/list/T1-api', go: 1 } : {})
  agent(tpm, 'tpm', 'exited', f); agent(a, 'engineer', 'exited', f, t)
  run("INSERT INTO sessions(id, agent_id, started_at) VALUES (?,?,?)", `s-${a}`, a, now)
  run("INSERT INTO messages(id, feature_id, channel, from_id, to_id, reason, body, created_at) VALUES (?,?,'dm','user',?,'fyi','hi',?)", `m-${f}`, f, tpm, now)
  run("INSERT INTO events(agent_id, source, kind, payload, created_at) VALUES (?, 'hook', 'hook.Stop', '{}', ?)", a, now)
  run("INSERT INTO plan_revisions(id, ticket_id, agent_id, round, plan_text, plan_hash, submitted_at) VALUES (?,?,?,1,'THE PLAN','h',?)", `p-${f}`, t, a, now)
  run("INSERT INTO review_requests(id, ticket_id, plan_revision_id, round, opened_at) VALUES (?,?,?,1,?)", `rr-${f}`, t, `p-${f}`, now)
  run("INSERT INTO docs(scope, key, text, updated_at) VALUES (?, 'note', '## Where I stopped\n- mid-edit of app.js', ?)", `resume:ticket:${t}`, now)
  run("INSERT INTO docs(scope, key, text, updated_at) VALUES (?, 'Decisions', 'JSON file', ?)", `feature:${f}`, now)
  run("INSERT INTO needs_attention(id, agent_id, ticket_id, kind, detail, created_at) VALUES (?,?,?,'stuck','x',?)", `na-${f}`, a, t, now)
  run("INSERT INTO previews(id, command, status, port, ticket_id, updated_at) VALUES (?, 'npm run dev', 'stopped', 3091, ?, ?)", r, t, now)
}
run("INSERT INTO needs_attention(id, kind, detail, created_at) VALUES ('na-sync', 'repo_sync:r1', 'fetch failed', ?)", now)
ticket('f1-m', 'f1', 'T0', 'merged') // built: "Built so far" keeps it after the clear (Bug 52)
run("INSERT INTO docs(scope, key, text, updated_at) VALUES ('resume:repo:r1', 'note', '## What the user wants\n- a item list', ?)", now) // the project TPM's note

test("clearing a repo deletes its board, archives the notes, saves unsaved code on its branch, and leaves other repos alone", async () => {
  const r = await clearRepo('r1')
  assert.deepEqual(r, { noting: [], stopped: [], done: true }) // nobody ran: done at once
  for (const [table, where] of [['features', "id = 'f1'"], ['tickets', "id = 'f1-t'"], ['agents', "feature_id = 'f1'"], ['sessions', "agent_id = 'f1-eng'"],
    ['messages', "feature_id = 'f1'"], ['events', "agent_id = 'f1-eng'"], ['plan_revisions', "ticket_id = 'f1-t'"], ['review_requests', "ticket_id = 'f1-t'"],
    ['docs', "scope LIKE '%f1%'"], ['needs_attention', "id = 'na-f1'"]] as const) assert.equal(count(table, where), 0, table)
  for (const [table, where] of [['features', "id = 'f2'"], ['tickets', "id = 'f2-t'"], ['agents', "feature_id = 'f2'"], ['messages', "feature_id = 'f2'"],
    ['events', "agent_id = 'f2-eng'"], ['docs', "scope LIKE '%f2%'"], ['needs_attention', "id = 'na-f2'"]] as const) assert.ok(count(table, where) > 0, `other repo's ${table}`)
  assert.equal(getRepo('r1')!.clearing_at, null)
  assert.equal(count('needs_attention', "id = 'na-sync' AND resolved_at IS NULL"), 1) // the repo's own notices stay
  assert.match(one<{ detail: string }>("SELECT detail FROM needs_attention WHERE kind = 'repo_cleared:r1'")!.detail, /Cleared demo: 1 feature and 2 tickets\./)
  // The project's TPM keeps its memory (Bug 52): its note, and what the cleared features built
  assert.equal(count('docs', "scope = 'resume:repo:r1'"), 1)
  assert.equal(keptBuilt('r1'), '- List f1: T0 T0 title')
  assert.match(fs.readFileSync(path.join(tpmWorkspace('r1'), 'PROJECT.md'), 'utf8'), /## Built so far\n\n- List f1: T0 T0 title\n\n## On the board now\n\nNothing/)
  assert.deepEqual({ ...one<object>('SELECT command, port, ticket_id, status FROM previews WHERE id = ?', 'r1') }, { command: 'npm run dev', port: 3091, ticket_id: null, status: 'stopped' })
  // The code: committed on the branch, the worktree gone, the branch kept
  assert.ok(!fs.existsSync(wt))
  assert.equal(sh(repoDir, 'log', '-1', '--format=%s', 'hq/list/T1-api'), 'WIP (HQ clear): T1 T1 title')
  assert.match(sh(repoDir, 'show', 'hq/list/T1-api:app.js'), /two \(half done\)/)
  // The archive: SUMMARY.md, FEATURE.md, the note and the plan
  const [dir] = fs.readdirSync(path.join(PATHS.archive, 'demo')).map((d) => path.join(PATHS.archive, 'demo', d))
  const sum = fs.readFileSync(path.join(dir!, 'SUMMARY.md'), 'utf8')
  assert.match(sum, /## List f1 \(planning\): list-f1-f1\//); assert.match(sum, /> I want a list \(f1\)\./)
  assert.match(sum, /\| T1 T1 title \| implementing \| hq\/list\/T1-api \| [0-9a-f]+ \(WIP commit\) \|  \| yes \|/)
  const fdir = path.join(dir!, 'list-f1-f1')
  assert.match(fs.readFileSync(path.join(fdir, 'FEATURE.md'), 'utf8'), /JSON file/)
  assert.match(fs.readFileSync(path.join(dir!, 'tpm', 'HANDOFF.md'), 'utf8'), /a item list/) // a copy: the TPM keeps it
  assert.match(fs.readFileSync(path.join(fdir, 'tickets', 'T1', 'HANDOFF.md'), 'utf8'), /mid-edit of app\.js/)
  assert.equal(fs.readFileSync(path.join(fdir, 'tickets', 'T1', 'PLAN.md'), 'utf8'), 'THE PLAN\n')
  assert.ok(!fs.existsSync(path.join(PATHS.workspaces, 'f1')))
})

test('a clear waits for notes being written; meanwhile nothing new starts there; the last note finishes it without a restart', async () => {
  feature('f3', 'r3'); ticket('f3-t', 'f3', 'T1', 'implementing'); ticket('f3-q', 'f3', 'T2', 'queued', { go: 1 })
  agent('f3-eng', 'engineer', 'working', 'f3', 'f3-t')
  run("UPDATE agents SET fresh_start_at = ?, fresh_start_then = 'continue' WHERE id = 'f3-eng'", now) // already writing a note (a fresh start)
  const r = await clearRepo('r3')
  assert.deepEqual(r, { noting: ['f3-eng'], stopped: [], done: false })
  assert.equal(one<{ fresh_start_then: string }>("SELECT fresh_start_then FROM agents WHERE id = 'f3-eng'")!.fresh_start_then, 'clear') // no new session after it
  assert.equal(one<{ go_ahead: number }>("SELECT go_ahead FROM tickets WHERE id = 'f3-q'")!.go_ahead, 0)
  await assert.rejects(clearRepo('r3'), /already being cleared/)
  await assert.rejects(launchEngineer('f3-q'), /third is being cleared/)
  await assert.rejects(createFeature('r3', 'more', 'more'), /third is being cleared/)
  await assert.rejects(restartTpm('r3'), /third is being cleared/)
  assert.throws(() => createTicket('f3', { title: 'x', size: 'S', spec: '' }), /third is being cleared/)
  assert.equal(await maybeFinishClear('r3'), false) // the note isn't in yet
  assert.equal(count('features', "id = 'f3'"), 1)
  // The note comes in: the agent stops, and with nobody left the clear finishes (no park, no restart)
  run("UPDATE agents SET status = 'exited' WHERE id = 'f3-eng'")
  await completeFreshStart('f3-eng', 'note')
  for (let i = 0; i < 50 && count('features', "id = 'f3'"); i++) await new Promise((res) => setTimeout(res, 20))
  assert.equal(count('features', "id = 'f3'"), 0); assert.equal(count('agents', "feature_id = 'f3'"), 0)
  assert.equal(getRepo('r3')!.clearing_at, null)
})

test('a clear is refused while one of the repo\'s tickets is starting an engineer', async () => {
  feature('f4', 'r2'); ticket('f4-t', 'f4', 'T9', 'queued')
  starting.add('f4-t')
  try { await assert.rejects(clearRepo('r2'), /T9 is starting right now/) } finally { starting.delete('f4-t') }
  assert.equal(getRepo('r2')!.clearing_at, null)
  assert.equal(q('SELECT id FROM features WHERE repo_id = ?', 'r2').length, 2)
})

test('an engineer waiting on a dialog stops at once, and HQ writes its note from its records', async () => {
  run("UPDATE tickets SET status = 'implementing' WHERE id = 'f4-t'"); agent('f4-eng', 'engineer', 'blocked', 'f4', 'f4-t')
  const r = await clearRepo('r2')
  assert.deepEqual(r, { noting: [], stopped: ['f4-eng: f4-eng is waiting on a dialog in its terminal. Answer it first.'], done: true })
  assert.equal(count('agents', "feature_id IN ('f2', 'f4')"), 0)
  const [dir] = fs.readdirSync(path.join(PATHS.archive, 'other')).map((d) => path.join(PATHS.archive, 'other', d))
  assert.match(fs.readFileSync(path.join(dir!, 'list-f4-f4', 'tickets', 'T9', 'HANDOFF.md'), 'utf8'), /^\(Written by HQ: the engineer didn't leave a note: f4-eng is waiting on a dialog/)
  assert.match(fs.readFileSync(path.join(dir!, 'SUMMARY.md'), 'utf8'), /\| T9 T9 title \| implementing \|  \| never started \|  \| HQ's \(the engineer couldn't\) \|/)
})

test("a clear that can't finish stays locked and says why in a notice; once it can, it finishes and the notice goes", async () => {
  run("INSERT INTO repos(id, name, path, kind, created_at) VALUES ('r5', 'stuck', '/tmp/stuck', 'local', ?)", now)
  feature('f5', 'r5'); ticket('f5-t', 'f5', 'T1', 'queued')
  fs.mkdirSync(PATHS.archive, { recursive: true }); fs.writeFileSync(path.join(PATHS.archive, 'stuck'), 'in the way') // the archive folder can't be made
  const r = await clearRepo('r5')
  assert.equal(r.done, false)
  assert.ok(getRepo('r5')!.clearing_at); assert.equal(count('features', "id = 'f5'"), 1)
  assert.match(one<{ detail: string }>("SELECT detail FROM needs_attention WHERE kind = 'repo_clear_failed:r5' AND resolved_at IS NULL")!.detail,
    /^Clearing stuck hasn't finished: .+ HQ keeps trying every 10 seconds\.$/)
  fs.rmSync(path.join(PATHS.archive, 'stuck'))
  assert.equal(await maybeFinishClear('r5'), true)
  assert.equal(getRepo('r5')!.clearing_at, null); assert.equal(count('features', "id = 'f5'"), 0)
  assert.equal(count('needs_attention', "kind = 'repo_clear_failed:r5' AND resolved_at IS NULL"), 0)
})

test('Bug 63: a test command waiting for the user\'s OK goes with the board, as the run it came from does', async () => {
  const { attention, openAttention } = await import('./attention.ts')
  run("INSERT INTO repos(id, name, path, kind, created_at, test_cmd_proposed) VALUES ('r9', 'ninth', '/tmp/ninth', 'local', ?, '{\"now\":\"x\"}')", now)
  attention('test_cmd_proposed:r9', 'ninth: a repair wants to change the test command.')
  await clearRepo('r9')
  assert.equal(openAttention().some((a) => a.kind === 'test_cmd_proposed:r9'), false); assert.equal(getRepo('r9')?.test_cmd_proposed, null)
})

// Remove from HQ (Bug 66) against a real SQLite DB in a temp HQ_HOME and a real git repo: HQ forgets the project, another project is untouched, and the folder is exactly as it
// was: no WIP commit, no worktree removed, no branch changed. Clear does all of those, which is why it can't be reused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-remove-'))
const { migrate, run, q, one } = await import('./db.ts')
migrate()
const { removeRepo } = await import('./remove.ts')
const { sweepFreshStarts } = await import('./freshstart.ts')
const { firstFreeTicket, addRepo } = await import('./repos.ts')
const { getRepo, removing } = await import('./records.ts')
const { save, row } = await import('./preview.ts')
const { writeProjectMd, tpmWorkspace } = await import('./projectmd.ts')
const { starting } = await import('./scheduler.ts')
const { PATHS } = await import('./config.ts')

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const now = Date.now()
function project(id: string, name: string, path0?: string): string {
  const dir = path0 ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-remove-repo-')))
  if (!path0) { sh(dir, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'app.js'), 'one\n'); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'base') }
  run("INSERT INTO repos(id, name, path, kind, created_at) VALUES (?, ?, ?, 'local', ?)", id, name, dir, now); return dir
}
function board(repo: string, f: string, t: string, a: string, o: { worktree?: string; branch?: string } = {}): void {
  run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES (?,?,?,?,?,'planning',?,?)",
    f, repo, `list-${f}`, `List ${f}`, `I want a list (${f}).`, now, now)
  run("INSERT INTO tickets(id, feature_id, key, slug, title, status, branch, worktree_path, go_ahead, created_at, updated_at) VALUES (?,?,'T1','t1','T1 title','implementing',?,?,1,?,?)",
    t, f, o.branch ?? null, o.worktree ?? null, now, now)
  run(`INSERT INTO agents(id, role, repo_id, feature_id, ticket_id, model_alias, token_hash, status, tmux_session, started_at)
    VALUES (?, 'engineer', ?, ?, ?, 'opus', ?, 'exited', 'hq-remove-test-none', ?)`,
    a, repo, f, t, a, now)
  run("INSERT INTO messages(id, repo_id, channel, from_id, to_id, reason, body, created_at) VALUES (?, ?, 'dm', 'user', ?, 'fyi', 'hello', ?)", `m-${a}`, repo, a, now)
  run("INSERT INTO messages(id, repo_id, channel, from_id, to_id, reason, body, created_at) VALUES (?, ?, 'dm', 'hq', 'user', 'fyi', 'about the project', ?)", `m2-${a}`, repo, now)
  run("INSERT INTO needs_attention(id, agent_id, ticket_id, kind, detail, created_at) VALUES (?, NULL, NULL, ?, 'a stop', ?)", `n-${repo}`, `auto_stopped:${repo}`, now)
  run("INSERT INTO docs(scope, key, text, updated_at) VALUES (?, 'built', 'Built: a list', ?)", `repo:${repo}`, now)
  run("INSERT INTO docs(scope, key, text, updated_at) VALUES (?, 'note', 'where I got to', ?)", `resume:repo:${repo}`, now)
  run("INSERT INTO previews(id, status, updated_at) VALUES (?, 'stopped', ?)", repo, now)
  run("INSERT INTO auto_runs(id, repo_id, status, started_at) VALUES (?, ?, 'finished', ?)", `run-${repo}`, repo, now)
  run("INSERT INTO agents(id, role, repo_id, model_alias, token_hash, status, tmux_session, started_at) VALUES (?, 'launcher', ?, 'sonnet', ?, 'exited', 'hq-remove-test-none', ?)",
    `launch-${a}`, repo, `launch-${a}`, now)
}
const count = (table: string, where: string, ...args: string[]) => one<{ c: number }>(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`, ...args)!.c
const folder = (d: string) => ({ status: sh(d, 'status', '--porcelain'), log: sh(d, 'log', '--all', '--format=%H %s'), branches: sh(d, 'branch', '-a'),
  worktrees: sh(d, 'worktree', 'list'), files: fs.readdirSync(d).sort() })
const archived = (name: string) => { const d = path.join(PATHS.archive, name); const stamp = fs.readdirSync(d).sort().at(-1)!; return path.join(d, stamp) }

test('Bug 66: Remove forgets the project, leaves its folder exactly as it was, and leaves another project alone', async () => {
  const dir = project('r1', 'demo'), other = project('r2', 'other')
  const wt = path.join(dir, '.claude', 'worktrees', 'T1'); sh(dir, 'worktree', 'add', '-q', '-b', 'hq/list/T1-api', wt, 'main')
  fs.writeFileSync(path.join(wt, 'app.js'), 'one\ntwo (half done)\n')
  board('r1', 'f1', 't1', 'a1', { worktree: wt, branch: 'hq/list/T1-api' }); board('r2', 'f2', 't2', 'a2')
  writeProjectMd('r1'); fs.mkdirSync(path.join(PATHS.agents, 'a1'), { recursive: true }); fs.mkdirSync(path.join(PATHS.projects, 'r1'), { recursive: true })
  const before = folder(dir), half = fs.readFileSync(path.join(wt, 'app.js'), 'utf8'), wtStatus = sh(wt, 'status', '--porcelain')
  const r = await removeRepo('r1')
  assert.equal(getRepo('r1'), undefined)
  for (const [table, where, arg] of [['features', 'repo_id = ?', 'r1'], ['tickets', 'id = ?', 't1'], ['agents', 'repo_id = ?', 'r1'], ['messages', 'repo_id = ?', 'r1'],
    ['auto_runs', 'repo_id = ?', 'r1'],
    ['previews', 'id = ?', 'r1'], ['needs_attention', 'kind LIKE ?', '%:r1'], ['docs', 'scope LIKE ?', '%repo:r1']] as const) assert.equal(count(table, where, arg), 0, `${table} ${arg}`)
  assert.deepEqual(folder(dir), before); assert.equal(fs.readFileSync(path.join(wt, 'app.js'), 'utf8'), half); assert.equal(sh(wt, 'status', '--porcelain'), wtStatus)
  assert.equal(fs.existsSync(path.dirname(tpmWorkspace('r1'))), false); assert.equal(fs.existsSync(path.join(PATHS.agents, 'a1')), false);
  assert.equal(fs.existsSync(path.join(PATHS.projects, 'r1')), false)
  const summary = fs.readFileSync(path.join(r.archive, 'SUMMARY.md'), 'utf8')
  assert.match(summary, /Nothing in .* was touched/); assert.doesNotMatch(summary, /WIP/); assert.ok(summary.includes(`in its worktree (${wt})`)); assert.ok(summary.includes('## Settings'))
  assert.equal(fs.readFileSync(path.join(r.archive, 'tpm', 'HANDOFF.md'), 'utf8').trim(), 'where I got to'); assert.ok(fs.existsSync(path.join(r.archive, 'PROJECT.md')))
  assert.ok(getRepo('r2')); assert.equal(count('features', 'repo_id = ?', 'r2'), 1); assert.equal(count('agents', 'repo_id = ?', 'r2'), 2); assert.equal(count('messages', 'repo_id = ?', 'r2'), 2)
  assert.equal(count('needs_attention', 'kind = ?', 'auto_stopped:r2'), 1); assert.equal(count('docs', 'scope = ?', 'repo:r2'), 1); assert.equal(count('auto_runs', 'repo_id = ?', 'r2'), 1);
  assert.ok(row('r2'))
  assert.ok(fs.existsSync(other)); assert.equal(count('tickets', 'go_ahead = 1 AND id = ?', 't2'), 1)
  const notice = q<{ detail: string }>("SELECT detail FROM needs_attention WHERE kind = 'project_removed' AND resolved_at IS NULL")
  assert.equal(notice.length, 1); assert.match(notice[0]!.detail, /Removed demo from HQ\. Its folder wasn't touched/)
})

test('the fresh-start sweep, which finishes any clear it finds, leaves a removal alone', async () => {
  const dir = project('r3', 'third'); board('r3', 'f3', 't3', 'a3'); const before = folder(dir)
  run('UPDATE repos SET clearing_at = NULL WHERE id = ?', 'r3'); removing.add('r3')
  sweepFreshStarts(); await new Promise((r) => setTimeout(r, 50)); removing.delete('r3')
  assert.equal(getRepo('r3')?.clearing_at, null); assert.deepEqual(folder(dir), before)
})

test('refused: a project being cleared, one already on its way out, and one with something starting', async () => {
  project('r4', 'fourth'); run('UPDATE repos SET clearing_at = ? WHERE id = ?', now, 'r4')
  await assert.rejects(removeRepo('r4'), /being cleared/); run('UPDATE repos SET clearing_at = NULL WHERE id = ?', 'r4')
  removing.add('r4'); await assert.rejects(removeRepo('r4'), /already being removed/); removing.delete('r4')
  board('r4', 'f4', 't4', 'a4'); starting.add('t4'); await assert.rejects(removeRepo('r4'), /starting right now/); starting.delete('t4')
  assert.ok(getRepo('r4')); await removeRepo('r4'); assert.equal(getRepo('r4'), undefined)
  await assert.rejects(removeRepo('nope'), /unknown repo/)
})

test('an archive that can\'t be written deletes nothing, and removing again works', async () => {
  project('r5', 'fifth'); board('r5', 'f5', 't5', 'a5')
  const blocker = path.join(PATHS.archive, 'fifth'); fs.mkdirSync(PATHS.archive, { recursive: true }); fs.writeFileSync(blocker, 'in the way')
  await assert.rejects(removeRepo('r5')); assert.ok(getRepo('r5')); assert.equal(count('features', 'repo_id = ?', 'r5'), 1); assert.equal(removing.has('r5'), false)
  fs.rmSync(blocker); await removeRepo('r5'); assert.equal(getRepo('r5'), undefined); assert.ok(fs.existsSync(path.join(archived('fifth'), 'SUMMARY.md')))
})

test('a late writer can\'t bring a removed project back', async () => {
  project('r6', 'sixth'); board('r6', 'f6', 't6', 'a6'); await removeRepo('r6')
  save('r6', { status: 'stopped' }); assert.equal(row('r6'), undefined)
  writeProjectMd('r6'); assert.equal(fs.existsSync(path.dirname(tpmWorkspace('r6'))), false)
})

test('a project whose folder has gone can still be removed', async () => {
  const dir = project('r7', 'seventh'); board('r7', 'f7', 't7', 'a7'); fs.rmSync(dir, { recursive: true, force: true })
  await removeRepo('r7'); assert.equal(getRepo('r7'), undefined)
})

test('the notice lands on the project the user ends up on', async () => {
  project('r8', 'eighth'); project('r9', 'ninth')
  await removeRepo('r8', 'r9'); assert.equal(count('needs_attention', 'kind = ? AND resolved_at IS NULL', 'project_removed:r9'), 1)
})

test('firstFreeTicket: past every number the folder has used, whatever the key looks like', () => {
  assert.equal(firstFreeTicket([], []), 1)
  assert.equal(firstFreeTicket(['refs/heads/hq/list/T-03-add-it', 'refs/heads/hq/list/T1-api'], []), 4)
  assert.equal(firstFreeTicket(['refs/heads/hq/list/T-03-step-1'], []), 4) // the 1 in the name isn't the number
  assert.equal(firstFreeTicket(['refs/remotes/origin/hq/list/SHOP-12-thing'], ['T-02']), 13)
  assert.equal(firstFreeTicket(['refs/heads/hq/undo-run-ab12'], ['hq-test-T-02', 'launch-ab12', 'T-07']), 8) // HQ's own scratch doesn't count
})

test('adding a removed folder again makes a new project, and its first ticket can\'t land on the old work', async () => {
  const dir = project('r10', 'tenth'); sh(dir, 'branch', 'hq/list/T-05-old'); const wt = path.join(dir, '.claude', 'worktrees', 'T-05'); sh(dir, 'worktree', 'add', '-q', wt, 'hq/list/T-05-old')
  await removeRepo('r10')
  const back = await addRepo(dir); assert.notEqual(back.id, 'r10'); assert.equal(back.name, path.basename(dir)); assert.equal(back.next_ticket, 6)
})

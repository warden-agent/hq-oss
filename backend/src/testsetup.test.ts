// HQ's check of a test setup and an engineer's change to one, against a real SQLite DB in a temp HQ_HOME, a real git repo and HQ's real sandbox. The
// browser's stand-in (e2e/fake-scenario.mjs) runs the real recorder: seed, start, proxy, reset.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-testsetup-'))
process.env.HQ_SCENARIO_RUNNER = path.join(import.meta.dirname, '..', 'e2e', 'fake-scenario.mjs')
process.env.HQ_LOOK_RUNNER = process.env.HQ_SCENARIO_RUNNER // no browser download either
const { migrate, run, q } = await import('./db.ts')
migrate()
const { checkSetupRun, proposeSetupChange, onMergedSetup, dropSetupChange } = await import('./testsetup.ts')
const { readSetup, writeSetup } = await import('./testsetupstore.ts')
const { getAgent } = await import('./agents.ts')
const { runScenario } = await import('./scenario.ts')

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim()
/** Like many small apps: reads its data once, at start. DEV=1 serves a page that loads its source, as a dev server does. */
const SERVER = `const http=require('http'),fs=require('fs');const items=JSON.parse(fs.readFileSync('data/items.json','utf8'));
http.createServer((q,r)=>{ if(q.url==='/'){r.writeHead(200,{'content-type':'text/html'});return r.end(process.env.DEV?'<script src="/src/App.tsx"></script>':'<script src="/app.js"></script>')}
 if(q.method==='POST'){items.push({id:String(items.length+1),name:'x'});fs.writeFileSync('data/items.json',JSON.stringify(items));r.writeHead(201);return r.end()}
 r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify(items))}).listen(process.env.PORT,'127.0.0.1')`
const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-testsetup-repo-')))
sh(repoDir, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repoDir, 'server.js'), SERVER); fs.writeFileSync(path.join(repoDir, '.gitignore'), 'data/\n')
sh(repoDir, 'add', '.'); sh(repoDir, 'commit', '-qm', 'base')
fs.mkdirSync(path.join(repoDir, 'data')); fs.writeFileSync(path.join(repoDir, 'data', 'items.json'), JSON.stringify([{ id: 'mine', name: 'the user\'s own' }]))
const R = 'repo-ts', now = Date.now()
run("INSERT INTO repos(id, name, path, kind, default_branch, created_at) VALUES (?, 'app', ?, 'local', 'main', ?)", R, repoDir, now)
run("INSERT INTO previews(id, status, command, updated_at) VALUES (?, 'stopped', 'node server.js', ?)", R, now)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('f1', ?, 'f', 'F', 'r', 'planning', ?, ?)", R, now, now)
for (const t of ['t1', 't2', 't3']) {
  run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES (?, 'f1', ?, ?, 'T', 'implementing', ?, ?)", t, t.toUpperCase(), t, now, now)
  run(`INSERT INTO agents(id, role, repo_id, feature_id, ticket_id, model_alias, token_hash, status, tmux_session, started_at)
    VALUES (?, 'engineer', ?, 'f1', ?, 'opus', ?, 'exited', 'none', ?)`, `eng-${t}`, R, t, `h-${t}`, now)
}
const seed = `mkdir -p data && printf '[{"id":"s1","name":"rice"}]' > data/items.json`
const good = { start: [{ part: 'app', run: 'node server.js' }], snapshot: ['data'], seed, endpoints: [{ method: 'GET' as const, path: '/api/items', kind: 'instant' as const }], notes: '' }

test('HQ\'s check passes a setup whose reset brings the seed back, on a production start', async () => {
  const c = await checkSetupRun(R, good)
  assert.equal(c.problem, null, c.problem ?? ''); assert.match(c.scenario!.summary, /2 steps OK/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repoDir, 'data', 'items.json'), 'utf8')), [{ id: 'mine', name: 'the user\'s own' }], 'the user\'s own data is untouched')
  assert.ok(fs.existsSync(path.join(c.scenario!.dir, 'timeline.md')) && c.scenario!.dir.startsWith(process.env.HQ_HOME!), 'kept in HQ\'s own folder')
})
test('HQ\'s check says what\'s wrong: no seed, a reset that doesn\'t reset, a dev server', async () => {
  assert.match((await checkSetupRun(R, { ...good, seed: 'true' })).problem ?? '', /seed command wrote none of data/)
  const stamps = { ...good, start: [{ part: 'app', run: 'echo $$-$RANDOM > data/started && node server.js' }] } // the app writes into its state as it starts
  assert.match((await checkSetupRun(R, stamps)).problem ?? '', /after a reset the state paths weren't what the seed wrote/)
  assert.match((await checkSetupRun(R, { ...good, start: [{ part: 'app', run: 'DEV=1 node server.js' }] })).problem ?? '', /loaded \/src\/App\.tsx: that's a dev server/)
})
test('a scenario with no test setup, or none to run, says why and runs nothing', async () => {
  const r = await runScenario(R, [{ action: 'navigate', url: '/' }])
  assert.ok(r !== 'stopped' && 'why' in r && !('id' in r)); assert.match((r as { why: string }).why, /no test setup yet/)
})

const waitFor = async (cond: () => boolean, ms = 60_000) => {
  for (const t0 = Date.now(); !cond(); await new Promise((r) => setTimeout(r, 100))) if (Date.now() - t0 > ms) throw new Error('timed out')
}
test('an engineer\'s change waits for its ticket\'s merge, is checked then, and a failed one is undone', async () => {
  writeSetup(R, { ...readSetup(R), setup: good, saved_at: now, by: 'Claude (test setup)', seen: true })
  const eps = [{ method: 'POST', path: '/api/items', kind: 'instant' }, { method: 'GET', path: '/api/items', kind: 'instant' }]
  assert.match(proposeSetupChange(getAgent('eng-t1')!, { endpoints: eps }).text, /applies it when T1 merges/)
  assert.match(proposeSetupChange(getAgent('eng-t2')!, { snapshot: ['.git'] }).text, /^Not saved: snapshot: \.git isn't the app's data/) // refused at once
  assert.match(proposeSetupChange(getAgent('eng-t2')!, { seed: 'true' }).text, /applies it when T2 merges/) // only the run finds this one
  assert.equal(readSetup(R).setup!.endpoints.length, 1, 'nothing changes before the merge')
  // two merges close together: checked one at a time, in order, each on top of what the one before left; only a passing one applies
  onMergedSetup({ agentId: null, source: 'system', kind: 'ticket.merged', payload: { ticket: 't1' }, at: now })
  onMergedSetup({ agentId: null, source: 'system', kind: 'ticket.merged', payload: { ticket: 't2' }, at: now })
  assert.equal(readSetup(R).setup!.endpoints.length, 1, 'nothing applies before its check'); assert.deepEqual(readSetup(R).merged.map((m) => m.key), ['T1', 'T2'])
  await waitFor(() => readSetup(R).merged.length === 0)
  const after = readSetup(R)
  assert.equal(after.setup!.endpoints.length, 2, 'T1 passed and applied'); assert.equal(after.by, 'T1'); assert.equal(after.checked!.ok, true)
  assert.equal(after.setup!.seed, seed, 'T2 failed: the setup it had is kept'); assert.equal(after.seen, false, 'shown to the user once')
  const notes = q<{ detail: string }>('SELECT detail FROM needs_attention WHERE kind = ?', `repo_testsetup:${R}`).map((x) => x.detail)
  assert.ok(notes.some((x) => /T1 changed how HQ tests the app; HQ checked it/.test(x)) && notes.some((x) => /T2 changed .* check of it failed .* kept the setup it had/.test(x)), notes.join(' | '))
  assert.deepEqual(Object.keys(after.pending), [])
  // a cancelled ticket takes its change with it
  proposeSetupChange(getAgent('eng-t3')!, { endpoints: [] }); assert.deepEqual(Object.keys(readSetup(R).pending), ['t3'])
  dropSetupChange(R, 't3'); assert.deepEqual(Object.keys(readSetup(R).pending), [])
})

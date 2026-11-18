// Bug 162: with auto mode off, open_pr needs the project's test command run on the ticket after its last edit, and a before_pr handoff after
// that run (suiteran.ts). Against a real SQLite DB in a temp HQ_HOME, with events as hooks.ts and mcp.ts write them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-suiteran-'))
const { migrate, run } = await import('./db.ts')
migrate()
const { emit } = await import('./events.ts')
const { getAgent } = await import('./agents.ts')
const { getTicket } = await import('./records.ts')
const { changerAfter, keepBefore, keepState, runsSuite, suiteProblem, suiteRan, worktreeState } = await import('./suiteran.ts')

const WT = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-suiteran-wt-')), now = Date.now()
const pkg = (scripts: Record<string, string>) => fs.writeFileSync(path.join(WT, 'package.json'), JSON.stringify({ name: 'shop', private: true, scripts }))
pkg({ test: 'node --test' })
run("INSERT INTO repos(id, name, path, kind, created_at) VALUES ('r1', 'shop', '/tmp/shop-162', 'local', ?)", now)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('f1','r1','shop','Shop','A list.','planning',?,?)", now, now)
run(`INSERT INTO tickets(id, feature_id, key, slug, title, status, branch, worktree_path, go_ahead, created_at, updated_at)
  VALUES ('t1','f1','SHOP-1','shop-1','Totals','implementing','hq/shop/SHOP-1',?,1,?,?)`, WT, now, now)
for (const id of ['eng-1', 'eng-2']) {
  run(`INSERT INTO agents(id, role, repo_id, feature_id, ticket_id, model_alias, token_hash, status, tmux_session, started_at)
    VALUES (?,'engineer','r1','f1','t1','haiku',?,'working','hq-suiteran-none',?)`, id, id, now)
}
const eng = (id = 'eng-1') => getAgent(id)!
const t = () => getTicket('t1')!
/** What hooks.ts writes when a Bash call is over. */
const bash = (command: string, error?: string, who = 'eng-1', use = '') => {
  const payload = { tool: 'Bash', input: JSON.stringify({ command }).slice(0, 200), use, suite: suiteRan(eng(who), command, error) }
  const ev = emit({ agentId: who, source: 'hook', kind: `hook.${error === undefined ? 'PostToolUse' : 'PostToolUseFailure'}:Bash`, payload })
  if (payload.suite) keepState(eng(who), ev.id!, command, use) // as hooks.ts does (Bugs 194, 213)
}
/** Bug 213: what hooks.ts does at a Bash call's PreToolUse: the event, then (for some lines) the worktree's state before the hook answers. */
const pre = async (command: string, who: string, use: string) => {
  const ev = emit({ agentId: who, source: 'hook', kind: 'hook.PreToolUse:Bash', payload: { tool: 'Bash', input: JSON.stringify({ command }).slice(0, 300), use } })
  const p = keepBefore(eng(who), command, ev.id!, false); await p; return p !== null
}
const edit = (file: string, tool = 'Edit') => emit({ agentId: 'eng-1', source: 'hook', kind: `hook.PostToolUse:${tool}`,
  payload: { tool, input: JSON.stringify({ file_path: file, old_string: 'a', new_string: 'b' }).slice(0, 200) } })
const handoff = (kind = 'before_pr', who = 'eng-1') => emit({ agentId: who, source: 'mcp', kind: 'mcp.update_handoff', payload: { args: { kind, len: 40 } } })
const reset = () => run("DELETE FROM events"); const setRepo = (sql: string, ...p: (string | null)[]) => run(`UPDATE repos SET ${sql} WHERE id = 'r1'`, ...p)

test('which lines run the test command: what engineers type, and what only looks like it', () => {
  for (const line of ['npm test', 'npm test 2>&1 | tail -30', `cd ${WT} && npm test`, 'npm test -- --test-force-exit', 'CI=1 npm test', 'npm test > /tmp/out.txt'])
    assert.equal(runsSuite(line, 'npm test', WT), true, line)
  for (const line of ['node --test test/list.test.js', 'npm run lint', 'git commit -m "npm test passes"', 'echo npm', 'npm tests'])
    assert.equal(runsSuite(line, 'npm test', WT), false, line)
  assert.equal(runsSuite('node --test --test-force-exit', 'node --test', WT), true, 'a saved command, with an option added')
})

test('Bug 162 itself: only its own test file ran, so open_pr is refused and names the command', async () => {
  reset(); bash('node --test test/list.test.js'); handoff()
  assert.match((await suiteProblem(t())) ?? '', /HQ hasn't seen this project's test command run on SHOP-1\. .*not only your own test files: npm test\./)
  bash('npm test 2>&1 | tail -20', 'Exit code 1'); handoff() // it ran and failed (a known failure on main): that's for the handoff to say
  assert.equal((await suiteProblem(t())), null)
})

test('an edit in the worktree after the run, or a handoff before it, is refused; edits elsewhere and other agents on the ticket count right', async () => {
  reset(); bash('npm test'); handoff(); edit(path.join(WT, 'src/list.js'))
  assert.match((await suiteProblem(t())) ?? '', /You changed files after the last run/)
  edit('/Users/someone/.claude/plans/plan.md', 'Write'); bash('npm test'); edit(path.join(WT, '.hq-plans/plan.md'), 'Write')
  assert.match((await suiteProblem(t())) ?? '', /handoff came before your last run/)
  handoff('milestone'); assert.match((await suiteProblem(t())) ?? '', /handoff came before/, 'only a before_pr handoff says what the run reported')
  handoff(); assert.equal((await suiteProblem(t())), null, 'a plan file is no change to the code')
  reset(); bash('npm test', undefined, 'eng-1'); handoff('before_pr', 'eng-2'); assert.equal((await suiteProblem(t())), null, 'a takeover keeps the run its predecessor made')
})

test('what it must not catch: auto mode on, no test command HQ can find, one Claude Code refuses, and a refused try', async () => {
  reset(); handoff()
  setRepo('auto_mode = 1'); assert.equal((await suiteProblem(t())), null, 'on auto HQ runs the command itself before the merge'); setRepo('auto_mode = 0')
  setRepo('auto_mode = 1, auto_stopped_why = ?', 'a refused merge') // as Bug 246: stopped, the user merges (no tests)
  assert.match((await suiteProblem(t())) ?? '', /HQ hasn't seen this project's test command run/, 'auto stopped: the check holds')
  setRepo('auto_stopped_why = NULL'); run("UPDATE tickets SET auto_parked_why = 'parked' WHERE id = 't1'")
  assert.match((await suiteProblem(t())) ?? '', /HQ hasn't seen this project's test command run/, 'a ticket auto parked: the check holds')
  run("UPDATE tickets SET auto_parked_why = NULL WHERE id = 't1'"); setRepo('auto_mode = 0')
  pkg({ start: 'node server.js' }); assert.equal((await suiteProblem(t())), null, 'no tests HQ can find')
  setRepo('test_cmd = ?', 'node --test test/'); assert.match((await suiteProblem(t())) ?? '', /node --test test\//, 'the saved command wins')
  setRepo('test_cmd_refused = ?', JSON.stringify({ cmd: 'node --test test/', why: 'isolated', by: 'SHOP-0' })); assert.equal((await suiteProblem(t())), null)
  setRepo('test_cmd_refused = NULL')
  bash('node --test test/', 'This session is isolated in the worktree at …'); handoff(); assert.equal((await suiteProblem(t())), null, 'it tried: Claude Code refused it')
  setRepo('test_cmd = NULL'); pkg({ test: 'node --test' })
  assert.match((await suiteProblem(t())) ?? '', /npm test/, "a run of another command doesn't count once the command is another")
})

// Bug 194: a ticket whose worktree is a real git worktree, so open_pr can compare what its files hold now with what they held after the run.
const MAIN = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-suiteran-git-')), GWT = path.join(MAIN, '.claude', 'worktrees', 'SHOP-2')
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@hq', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
/** What `sed -i 's/from/to/' f` does, the same on a Mac and on Linux (their seds differ in -i). */
const sedI = (f: string, from: string, to: string) => fs.writeFileSync(path.join(GWT, f), fs.readFileSync(path.join(GWT, f), 'utf8').replace(from, to))
const put = (f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(GWT, f)), { recursive: true }); fs.writeFileSync(path.join(GWT, f), s) }
g(MAIN, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(MAIN, '.gitignore'), 'node_modules/\n*.log\n')
fs.writeFileSync(path.join(MAIN, 'package.json'), JSON.stringify({ name: 'shop', private: true, scripts: { test: 'node --test' } }))
fs.writeFileSync(path.join(MAIN, 'list.js'), 'exports.total = () => 0\n'); g(MAIN, 'add', '.'); g(MAIN, 'commit', '-qm', 'start')
fs.appendFileSync(path.join(MAIN, '.git', 'info', 'exclude'), '.hq-plans/\n.claude/worktrees/\n') // as worktrees.ts does
g(MAIN, 'worktree', 'add', '-q', '-b', 'hq/shop/SHOP-2', GWT)
run(`INSERT INTO tickets(id, feature_id, key, slug, title, status, branch, worktree_path, go_ahead, created_at, updated_at)
  VALUES ('t2','f1','SHOP-2','shop-2','Totals','implementing','hq/shop/SHOP-2',?,1,?,?)`, GWT, now, now)
run(`INSERT INTO agents(id, role, repo_id, feature_id, ticket_id, model_alias, token_hash, status, tmux_session, started_at)
  VALUES ('eng-3','engineer','r1','f1','t2','haiku','eng-3','working','hq-suiteran-none',?)`, now)
const t2 = () => getTicket('t2')!
const ranThenHandoff = () => { bash('npm test 2>&1 | tail -5', undefined, 'eng-3'); handoff('before_pr', 'eng-3') }
/** The run is over and open_pr would go through: its state has been taken (the engineer's next command comes after that). */
const ranOk = async () => { ranThenHandoff(); assert.equal(await suiteProblem(t2()), null) }
const CHANGED = /You changed files after the last run/

test('Bug 194: a change made through Bash after the run asks for another run, whatever made it', async () => {
  reset(); setRepo('test_cmd = NULL'); put('list.js', 'exports.total = (xs) => xs.length\n'); ranThenHandoff()
  assert.equal(await suiteProblem(t2()), null, 'asked at once: the run\'s state is still being taken')
  sedI('list.js', 'length', 'length + 0'); bash(`sed -i 's/length/length + 0/' list.js`, undefined, 'eng-3')
  assert.match(await suiteProblem(t2()) ?? '', CHANGED, 'sed -i')
  await ranOk()
  put('notes/new.md', 'a new file\n'); assert.match(await suiteProblem(t2()) ?? '', CHANGED, 'a new file nobody added')
  await ranOk(); fs.rmSync(path.join(GWT, 'notes/new.md')); assert.match(await suiteProblem(t2()) ?? '', CHANGED, 'a file removed')
  await ranOk(); fs.writeFileSync(path.join(MAIN, 'format.js'), 'exports.f = 1\n'); g(MAIN, 'add', '.'); g(MAIN, 'commit', '-qm', 'main moved on')
  g(GWT, 'add', '.'); g(GWT, 'commit', '-qm', 'totals'); await ranOk(); g(GWT, 'merge', '-q', 'main', '-m', 'merge main')
  assert.match(await suiteProblem(t2()) ?? '', CHANGED, 'a clean git merge main')
})

test('Bug 194, what it must not catch: reading files, commits that change no file, ignored files, HQ\'s plan files', async () => {
  reset(); put('list.js', 'exports.total = (xs) => xs.length * 1\n'); await ranOk()
  bash('cat list.js && git status && git diff', undefined, 'eng-3'); assert.equal(await suiteProblem(t2()), null, 'only reading')
  g(GWT, 'add', '.'); g(GWT, 'commit', '-qm', 'the change the run saw'); assert.equal(await suiteProblem(t2()), null, 'committing what the run saw')
  g(GWT, 'commit', '-q', '--allow-empty', '-m', 'empty'); assert.equal(await suiteProblem(t2()), null, 'an empty commit')
  put('node_modules/x/index.js', 'x'); put('debug.log', 'x'); put('.hq-plans/plan.md', '# plan'); assert.equal(await suiteProblem(t2()), null, 'ignored files and the plan folder')
  put('list.js', 'changed\n'); put('list.js', 'exports.total = (xs) => xs.length * 1\n'); assert.equal(await suiteProblem(t2()), null, 'changed and put back')
  assert.equal(await worktreeState(WT), null, 'not a git worktree: no state, open_pr goes by Edit/Write as before')
})

test('Bug 194: a repo with test files but no test script is checked against the saved command, and only then', async () => {
  reset(); fs.writeFileSync(path.join(GWT, 'package.json'), JSON.stringify({ name: 'shop', private: true })); put('test/list.test.js', "require('node:test')\n")
  handoff('before_pr', 'eng-3'); assert.equal(await suiteProblem(t2()), null, 'no command HQ knows: HQ doesn\'t guess one')
  setRepo('test_cmd = ?', 'node --test'); assert.match(await suiteProblem(t2()) ?? '', /test command run on SHOP-2\. .*: node --test\./)
  bash('node --test test/', undefined, 'eng-3'); handoff('before_pr', 'eng-3'); assert.equal(await suiteProblem(t2()), null)
  sedI('test/list.test.js', 'test', 'test '); assert.match(await suiteProblem(t2()) ?? '', CHANGED)
  setRepo('test_cmd = NULL')
})

test('Bug 213: which commands after the test command in its own line may change files', () => {
  for (const line of ['npm test', 'npm test 2>&1 | tail -5', `cd ${WT} && npm test`, 'npm test; echo "exit $?"', 'npm test | tee test.log',
    'npm test && git add -A && git commit -qm "totals > 0" && git push', 'npm test && git status && git diff --stat', "sed -i 's/a/b/' list.js && npm test",
    "npm test && sed -i 's/a/b/' list.js && npm test 2>&1 | tail -3", 'npm run lint', 'git commit -m "npm test && sed -i"'])
    assert.equal(changerAfter(line, 'npm test'), null, line)
  const cases: [string, string][] = [["npm test && sed -i '' 's/length/length ^ 0/' list.js && git commit -qam e", "sed -i '' 's/length/length ^ 0/' list.js"],
    ['npm test && git merge -q main', 'git merge -q main'], ['npm test && echo x > list.js', 'echo x > list.js'], ['npm test; npm run build', 'npm run build'],
    ['npm test 2>&1 | tail -3 && node fix.js', 'node fix.js'], ['npm test && echo $(rm list.js)', 'echo $(rm list.js)'], ['npm test && git checkout -- list.js', 'git checkout -- list.js']]
  for (const [line, c] of cases) assert.equal(changerAfter(line, 'npm test'), c, line)
  assert.equal(changerAfter('node --test --test-force-exit && rm -rf dist', 'node --test'), 'rm -rf dist', 'a saved command, with an option added')
  assert.equal(changerAfter('npm run build && npm test && git commit -qam x', 'npm run build && npm test'), null, 'a test command of two parts')
})

test('Bug 213: `npm test && sed -i … && git commit` in one line asks for a run on a line of its own; what it must not catch', async () => {
  const LATE = /Your last run of this project's test command had `sed -i 's\/length\/length \^ 0\/' list.js` after it in the same Bash line, and the files changed/
  reset(); setRepo('test_cmd = NULL'); put('list.js', 'exports.total = (xs) => xs.length\n'); put('package.json', JSON.stringify({ name: 'shop', private: true, scripts: { test: 'node --test' } }))
  g(GWT, 'add', '.'); g(GWT, 'commit', '-qm', 'base 213')
  const one = "npm test && sed -i 's/length/length ^ 0/' list.js && git commit -qam e"
  assert.equal(await pre(one, 'eng-3', 'u1'), true, 'its state is taken before the line starts')
  sedI('list.js', 'length', 'length ^ 0'); g(GWT, 'commit', '-qam', 'e'); bash(one, undefined, 'eng-3', 'u1'); handoff('before_pr', 'eng-3')
  const r = await suiteProblem(t2()) ?? ''; assert.match(r, LATE); assert.match(r, /npm test, on a Bash line of its own/)
  await ranOk() // the run on a line of its own

  assert.equal(await pre('npm test 2>&1 | tail -5', 'eng-3', 'u2'), false, 'an ordinary run: nothing taken before, the hook answers at once')
  for (const [line, use] of [['npm test && git add -A && git commit -qm x', 'u3'], ['npm test; echo "exit $?" | tee run.log', 'u4']]) {
    await pre(line, 'eng-3', use); if (use === 'u4') put('run.log', 'exit 0'); bash(line, undefined, 'eng-3', use); handoff('before_pr', 'eng-3'); assert.equal(await suiteProblem(t2()), null, line)
  }
  fs.rmSync(path.join(GWT, 'run.log'))
  const build = 'npm test && npm run build'
  assert.equal(await pre(build, 'eng-3', 'u5'), true); put('build.log', 'built') // an ignored file: no change the tests could miss
  bash(build, undefined, 'eng-3', 'u5'); handoff('before_pr', 'eng-3'); assert.equal(await suiteProblem(t2()), null, 'a command after the run that changed nothing')
  put('snap.txt', 'v1'); g(GWT, 'add', '.'); g(GWT, 'commit', '-qm', 'snapshot'); put('snap.txt', 'v2') // the tests rewrite a tracked file as they run
  bash('npm test', undefined, 'eng-3', 'u6'); handoff('before_pr', 'eng-3'); assert.equal(await suiteProblem(t2()), null, 'tests that write files, nothing after them')
  await pre(build, 'eng-3', 'u7'); put('snap.txt', 'v3'); bash(build, undefined, 'eng-3', 'u7'); handoff('before_pr', 'eng-3')
  assert.match(await suiteProblem(t2()) ?? '', /had `npm run build` after it/, 'tests that write files AND a command after them: HQ cannot tell which, so it asks')
  g(GWT, 'checkout', '-q', '--', 'snap.txt')

  sedI('list.js', '^ 0', '^ 1'); bash("npm test && sed -i 's/0/1/' list.js", undefined, 'eng-3', 'u8'); handoff('before_pr', 'eng-3') // no PreToolUse came (HQ was away)
  assert.match(await suiteProblem(t2()) ?? '', /HQ couldn't see what the files held before that line/)
  bash('npm test && git commit -qam y', undefined, 'eng-3', 'u9'); handoff('before_pr', 'eng-3'); assert.equal(await suiteProblem(t2()), null, 'no PreToolUse, only a commit after')
  bash("npm test && sed -i 's/1/2/' list.js", undefined, 'eng-3', 'u10'); bash('npm test', undefined, 'eng-3', 'u11'); handoff('before_pr', 'eng-3')
  assert.equal(await suiteProblem(t2()), null, 'only the last run counts')
})

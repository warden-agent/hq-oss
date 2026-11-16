// Bug 107: telling "Claude Code refused the project's test command" from everything that looks like it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commands, isRefusal, ranTestCmd, refusedTestCmd, testCmdParts } from './refused.ts'

const WT = '/Users/me/my app/.claude/worktrees/T-01'
// The hook's `error` for `node --test $(git ls-files test)` on Claude Code 2.1.322, and for `node --test $(ls test/*.test.js)` on 2.1.300
const GIT = `This session is isolated in the worktree ${WT}, but this command names git in a form too complex to verify that it stays inside the worktree. `
  + "Refusing to run it — a worktree-isolated session's git operations must target its own worktree. Split it into plain, separate commands and run them from " + WT + '.'
const COMPUTED = `This session is isolated in the worktree ${WT}, but this command runs node with a value computed at runtime (command output)`

test('a refusal is Claude Code\'s own words about the worktree, on both versions HQ has run', () => {
  assert.equal(isRefusal(GIT), true); assert.equal(isRefusal(COMPUTED), true)
})
test('a command that ran and failed, was interrupted, or was turned down by HQ is not a refusal', () => {
  for (const e of ['Exit code 1\n✖ adds (1.2ms)', 'Exit code 127\n(eval):1: command not found: python', '', 'Command timed out after 2m 0s',
    "HQ: 'npm test' is not allowed during planning; run it after plan approval.", '[Request interrupted by user for tool use]',
    'Exit code 1\nThis session is isolated in the worktree']) assert.equal(isRefusal(e), false, e)
})

test('a line is split into its simple commands, never inside quotes, $( ) or backticks', () => {
  assert.deepEqual(commands(`cd "/a b/c" && (npm run build 2>&1 | tail -5; echo "x && y") || node --test $(git ls-files 'test/*.js' | sort) &\necho \`a; b\` &>/dev/null`),
    ['cd "/a b/c"', 'npm run build 2>&1', 'tail -5', 'echo "x && y"', "node --test $(git ls-files 'test/*.js' | sort)", 'echo `a; b` &>/dev/null'])
  assert.deepEqual(commands("echo 'it''s; fine' ; echo \\; x"), ["echo 'it''s; fine'", 'echo \\; x']); assert.deepEqual(commands('  '), [])
})

// The first real engineer of this fix (2026-11-15, Claude Code 2.1.322): the saved command, and what it typed
const JOT = "node --test $(git ls-files 'test/*.test.js')"
test('the saved command with the options HQ tells engineers to add is still the test command', () => {
  for (const c of [JOT, `  ${JOT}\n`, `node --test --test-force-exit --test-timeout=120000 $(git ls-files 'test/*.test.js')`, `CI=1 timeout 300 ${JOT} 2>&1 | tail -40`,
    `cd "${WT}" && ${JOT}`, `cd '${WT}' && ${JOT} 2>&1 | head -n 100`, `${JOT}; echo exit=$?`, `npm run build && ${JOT}`]) {
    assert.equal(refusedTestCmd(c, JOT, WT), true, c); assert.equal(ranTestCmd(c, JOT, WT), true, c)
  }
  assert.equal(refusedTestCmd('cd /x/app/.claude/worktrees/T-01/ && npm   test', 'npm test', '/x/app/.claude/worktrees/T-01'), true, 'a bare path with its last slash; spacing aside')
})

// A two-part command (a build, then the tests) and the ways engineers typed it in a real session (none typed it to the letter)
const SECOND = "APP_SKIP_SLOW_CHECKS=1 TEST_SERVER=1 node --import=tsx --import=./test/setup.ts --test --test-force-exit --test-timeout=120000 "
  + "--test-skip-pattern='sends a reminder before the plan ends' $(grep -rL --include='*.ts' --include='*.js' needs-docker test/server-test test/client-test)"
const TWO_PART = `npm run build && ${SECOND}`
test('the ways real engineers ran a two-part command all count: output cut down, a time limit in front, the second half alone, brackets', () => {
  for (const c of [`npm run build 2>&1 | tail -5 && ${SECOND}`, `npm run build >/dev/null 2>&1; echo build=$?; ${SECOND}`, `npm run build >/dev/null 2>&1 && ${SECOND}`, SECOND,
    `npm run build 2>&1 | tail -5 && ${SECOND.replace(' node ', ' timeout 540 node ')}`, `cd "${WT}" && (npm run build && ${SECOND.replace(' node ', ' timeout 540 node ')})`]) {
    assert.equal(refusedTestCmd(c, TWO_PART, WT), true, c); assert.equal(ranTestCmd(c, TWO_PART, WT), true, c)
  }
  assert.deepEqual(testCmdParts(TWO_PART, TWO_PART, WT), { whole: true, hard: 1, hardInCmd: 1 }); assert.deepEqual(testCmdParts(SECOND, TWO_PART, WT), { whole: false, hard: 1, hardInCmd: 1 })
})
test('the plain half of a command says nothing either way: Claude Code never refuses it, and it running doesn\'t show the other half can', () => {
  assert.deepEqual(testCmdParts('npm run build 2>&1 | tail -5', TWO_PART, WT), { whole: false, hard: 0, hardInCmd: 1 })
  assert.equal(refusedTestCmd('npm run build', TWO_PART, WT), false); assert.equal(ranTestCmd('npm run build', TWO_PART, WT), false)
})
test('anything else in the line could be what was refused, and a narrowed run is another command: neither counts', () => {
  for (const c of [
    `cat >> test/a.test.js <<'EOF'\ntest('x', () => {})\nEOF\n${JOT}`, // a here-document is refused by itself
    `git stash && ${JOT}`, `${JOT} && git stash pop`, `${JOT} > "$TMPDIR/out.log" 2>&1`, `${JOT} | tee /tmp/out.log`, `python3 scripts/prep.py && ${JOT}`,
    `cd /somewhere/else && ${JOT}`, `cd "${WT}/sub" && ${JOT}`, `echo $HOME && ${JOT}`, `F=$(mktemp) && ${JOT}`,
    `${JOT} test/extra.test.js`, // one more file: another command
    "node --test $(git ls-files 'test/a.test.js')", 'node --test test/a.test.js test/b.test.js', "node $(git ls-files 'test/*.test.js')", 'npm test', '',
  ]) { assert.equal(refusedTestCmd(c, JOT, WT), false, c); assert.equal(ranTestCmd(c, JOT, WT), false, c) }
  for (const c of [SECOND.replace(/\$\(grep.*$/, '$(ls test/server-test/test-*report*.ts)'), // some of the files
    `cat "$TMPDIR/files.txt" | ${SECOND.replace(' node ', ' xargs node ').replace(/ \$\(grep.*$/, '')}`]) assert.equal(refusedTestCmd(c, TWO_PART, WT), false, c)
  assert.equal(refusedTestCmd(`cd "${WT}" && npm test`, 'npm test', null), false, 'no worktree known: a cd could go anywhere')
  assert.equal(refusedTestCmd('npm test', '  ', WT), false, 'no saved command'); assert.equal(refusedTestCmd('npm test:unit', 'npm test', WT), false, 'a longer script name')
})

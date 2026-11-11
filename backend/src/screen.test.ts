// paneLooksIdle against screens captured from real Claude Code sessions: 2.1.300 in HQ (spike, 2026-10-28; Bug 25) and 2.1.322 (2026-11-10; Bug 97).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paneLooksIdle } from './screen.ts'

const RULE = '─'.repeat(120)
const box = (prompt: string, footer: string, above = '') => `${above}\n${RULE} TPM demo ─\n${prompt}\n${RULE}\n${footer}\n`
const IDLE_TPM = box('❯ run the tests', '  ⏸ manual mode on · ? for shortcuts · ← for agents', '✻ Sautéed for 19s · done 3:14 PM\n\n')
const IDLE_ENG = box('❯ ', '  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents', '✻ Baked for 52s · done 3:17 PM')
const THINKING = box('❯ ', '  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt · ← for agents', '✶ Boondoggling… (12s · ↓ 1.2k tokens · thinking)')
const RUNNING = box('❯ ', '  ⏸ plan mode on (shift+tab to cycle) · esc to interrupt · ← for agents', '⏺ Running 1 shell command…\n  ⎿  $ npm test')
const PLAN_MENU = [RULE, '   Claude has written up a plan and is ready to execute. Would you like to proceed?', '', '   ❯ 1. Yes, auto-accept edits',
  '     2. Yes, manually approve edits', '     3. Tell Claude what to change', '', '   ctrl+g to edit in VS Code · .hq-plans/x.md', ''].join('\n')
const PERMISSION = `${RULE}\n Bash command\n   rm -rf build\n Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n`

test('paneLooksIdle: the prompt with a quiet footer is idle, whatever greyed suggestion sits after ❯', () => {
  assert.equal(paneLooksIdle(IDLE_TPM), true)
  assert.equal(paneLooksIdle(IDLE_ENG), true)
})
test('paneLooksIdle: thinking, running a command, a plan menu or a permission prompt is not idle', () => {
  for (const s of [THINKING, RUNNING, PLAN_MENU, PERMISSION]) assert.equal(paneLooksIdle(s), false, s)
})
test('paneLooksIdle: a blank or half-drawn screen is not idle', () => {
  assert.equal(paneLooksIdle(''), false)
  assert.equal(paneLooksIdle('❯ \n  ? for shortcuts\n'), false) // no input box rule above the prompt
})

// ---- Claude Code 2.1.322 (Bug 97): no "← for agents" any more, and the footer's other hints come and go ----
const DONE = '✻ Sautéed for 10s · done 5:37 PM'
const IDLE_322 = [
  box('❯ ', '  ⏵⏵ accept edits on (shift+tab to cycle)', DONE),
  box('❯ ', '  ⏸ plan mode on (shift+tab to cycle)', DONE),
  box('❯ start both tickets now', '  ⏸ manual mode on · ? for shortcuts', '✻ Churned for 26s · done 5:41 PM'), // a TPM
  // a command still runs in the background (a dev server, or a test run that hit its time limit)
  box('❯ check progress of the tock task', '  ⏵⏵ accept edits on · 1 shell · ↓ to manage', '✻ Cooked for 2s · done 5:36 PM · 1 shell still running'),
  box('❯ ', '  ⏸ plan mode on · 1 shell · ↓ to manage', `${DONE} · 1 shell still running`),
  box('❯ ', '  ⏸ manual mode on · 1 shell · ↓ to manage', `${DONE} · 1 shell still running`),
  // once a helper has run
  box('❯ ', '  ⏸ manual mode on · /tasks to see subagents', '⏺ Agent "Create five.txt file" finished · 10s\n✻ Worked for 12s · done 5:42 PM'),
  box('❯ ', '  ⏵⏵ accept edits on (shift+tab to cycle) · /tasks to see subagents', '✻ Churned for 43s · done 5:48 PM'),
  // a helper still runs: the turn has ended, and its row sits under the footer
  box('❯ ', '  ⏵⏵ accept edits on (shift+tab to cycle) · ↓ to manage\n  ⏺ main\n  ◯ general-purpose  Run sleep helper command        23s · ↓ 14.1k tokens',
    '✻ Waiting for 1 background agent to finish'),
  // a draft somebody typed and didn't send
  box('❯ a draft typed by a person', '  ⏸ manual mode on', '✻ Baked for 9s · done 5:45 PM'),
]
const BUSY_322 = [
  box('❯ ', '  ⏵⏵ accept edits on · 1 shell · esc to interrupt · ↓ to manage', '✳ Considering… (6s · ↓ 205 tokens)\n  ⎿  Tip: Use /theme to change the color theme'),
  box('❯ ', '  ⏸ manual mode on · esc to interrupt', '✶ Thinking… (3s)'),
]
const PLAN_MENU_322 = [RULE, '   Claude has written up a plan and is ready to execute. Would you like to proceed?', '', '   ❯ 1. Yes, auto-accept edits',
  '     2. Yes, manually approve edits', '     3. Tell Claude what to change', '        shift+tab to approve with this feedback', '',
  '   ctrl+g to edit in VS Code · .hq-plans/abundant-cuddling-shamir.md', RULE, ''].join('\n')

test('paneLooksIdle: 2.1.322 waits at its prompt with or without the hints 2.1.300 always showed', () => {
  for (const s of IDLE_322) assert.equal(paneLooksIdle(s), true, s)
})
test('paneLooksIdle: 2.1.322 at work, or showing its plan menu, is not idle', () => {
  for (const s of [...BUSY_322, PLAN_MENU_322]) assert.equal(paneLooksIdle(s), false, s)
})
test("paneLooksIdle: the words of a footer anywhere else don't make a screen idle", () => {
  assert.equal(paneLooksIdle(`⏺ The footer says "plan mode on" while I plan.\n${RULE}\n❯ \n${RULE}\n`), false) // above the box, and no footer under it
  assert.equal(paneLooksIdle(`${RULE}\n❯ ls\nREADME.md  manual mode on.txt\n❯ \n`), false) // a shell's prompt (Claude Code has ended): no box around it
})

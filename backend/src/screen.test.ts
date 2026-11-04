// paneLooksIdle against screens captured from real Claude Code 2.1.300 sessions in HQ (spike, 2026-10-28; Bug 25).
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

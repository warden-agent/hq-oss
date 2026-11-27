// paneLooksIdle and paneHasDraft against screens captured from real Claude Code sessions: 2.1.300 in HQ (spike, 2026-10-28; Bug 25) and 2.1.322 (2026-11-10; Bug 97; 2026-11-17, Bug 149).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { draftText, ownHalfLine, paneAtWork, paneHasDraft, paneLooksIdle, plainScreen } from './screen.ts'

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
  // right after Escape stopped a turn (Bug 110; 2026-11-15): HQ types the agent's messages into this prompt
  box('❯ ', '  ⏸ manual mode on · ? for shortcuts', '  Searched for 1 pattern, read 9 files\n  ⎿  Interrupted · What should Claude do instead?'),
  box('❯ now write the 700-word explanation', '  ⏸ manual mode on · ? for shortcuts', '⏺ hq: HQ: delivering B-1a2dde22 (waits for idle)\n  ⎿  Interrupted · What should Claude do instead?'),
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

// ---- Bug 149: a half-written line in the prompt box. Captured with `tmux capture-pane -e` from a real 2.1.322 session on Haiku (2026-11-17; long runs
// of spaces and the rules shortened). The box's text is drawn in the terminal's own colour when a person typed it, dim when Claude Code suggests it ----
const R = RULE
const EMPTY_PLACEHOLDER = [
  `                    \x1b[38;5;246m◐ medium · /effort\x1b[39m`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m❯ \x1b[2mTry "how does <filepath> work?"\x1b[0m`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m  \x1b[38;5;147m⏵⏵ accept edits on\x1b[38;5;246m (shift+tab to cycle) · ← for agents\x1b[39m`,
].join("\n")
const DRAFT = [
  `\x1b[38;5;244m${R}`,
  `\x1b[39m❯ a half-written draft I left here`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m  \x1b[38;5;147m⏵⏵ accept edits on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m`,
].join("\n")
const MULTILINE = [
  `                    \x1b[38;5;246mctrl+g to edit in VS Code\x1b[39m`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m❯ a half-written draft I left here`,
  `  and a second line of it`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m  \x1b[38;5;147m⏵⏵ accept edits on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m`,
].join("\n")
const SECOND_LINE_ONLY = [
  `                    \x1b[38;5;246mctrl+g to edit in VS Code\x1b[39m`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m❯ `,
  `  only on line two`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m  \x1b[38;5;147m⏵⏵ accept edits on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m`,
].join("\n")
const SPACES_ONLY = [
  `\x1b[38;5;244m${R}`,
  `\x1b[39m❯ `,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m  \x1b[38;5;147m⏵⏵ accept edits on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m`,
].join("\n")
const SUGGESTION = [
  `\x1b[38;5;244m${R}`,
  `\x1b[39m❯ \x1b[2mcommit this\x1b[0m`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m  \x1b[38;5;147m⏵⏵ accept edits on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m`,
].join("\n")
const PREFIX_TYPED = [
  `\x1b[38;5;244m${R}`,
  `\x1b[39m❯ comm`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m  \x1b[38;5;147m⏵⏵ accept edits on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m`,
].join("\n")
const BUSY_DRAFT = [
  `\x1b[38;5;246m  ⎿  Tip: Paste images into Claude Code using control+v (not cmd+v!)\x1b[39m`,
  `\x1b[38;5;244m${R}`,
  `\x1b[38;5;246m❯ \x1b[39mdraft typed while it works`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m  \x1b[38;5;147m⏵⏵ accept edits on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m`,
].join("\n")
const BUSY_EMPTY = [
  `  ⎿  Tip: Double-tap esc to rewind the code and/or conversation to a previous point in time\x1b[39m`,
  `\x1b[38;5;244m${R}`,
  `\x1b[38;5;246m❯ \x1b[39m`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m  \x1b[38;5;147m⏵⏵ accept edits on\x1b[38;5;246m (shift+tab to cycle) · esc to interrupt\x1b[39m`,
].join("\n")
const BUSY_QUEUED_HINT = [
  `\x1b[38;5;246m  ⎿  Tip: Double-tap esc to rewind the code and/or conversation to a previous point in time\x1b[39m`,
  `\x1b[38;5;244m${R}`,
  `\x1b[38;5;246m❯ \x1b[2m\x1b[39mPress up to edit queued messages\x1b[0m`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m  \x1b[38;5;147m⏵⏵ accept edits on\x1b[38;5;246m (shift+tab to cycle) · esc to interrupt\x1b[39m`,
].join("\n")
const AFTER_ESCAPE_DRAFT = [
  `\x1b[38;5;244m${R}`,
  `\x1b[39m❯ draft typed while it works`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m  \x1b[38;5;147m⏵⏵ accept edits on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m`,
].join("\n")
const PASTED = [
  `\x1b[38;5;244m${R}`,
  `\x1b[39m❯ ords pasted words`,
  `\x1b[38;5;244m${R}`,
  `\x1b[39m  \x1b[38;5;246mpaste again to expand\x1b[39m`,
].join("\n")
const REWIND = [
  `\x1b[38;5;246m✻\x1b[39m \x1b[38;5;246mWorked for 0s · done 7:54 PM\x1b[39m`,
  `\x1b[38;5;153m${"▔".repeat(60)}`,
  `\x1b[39m   \x1b[1m\x1b[38;5;153mRewind\x1b[0m`,
  `   Restore the code and/or conversation to the point before…`,
  `     \x1b[38;5;246m↑ 2 more\x1b[39m`,
  `     Run the shell command: sleep 20 ; then say finished.`,
  `     \x1b[38;5;246mNo code changes\x1b[39m`,
  `     Run the shell command: sleep 20 ; then say finished.`,
  `     \x1b[38;5;246mNo code changes\x1b[39m`,
  `     queued message reply with the word queued`,
  `     \x1b[38;5;246mNo code changes\x1b[39m`,
  `   \x1b[38;5;153m❯\x1b[39m \x1b[3m\x1b[38;5;153m(current)\x1b[0m`,
  `   \x1b[3m\x1b[38;5;246mEnter to continue · Esc to cancel\x1b[0m`,
].join("\n")
test('paneHasDraft: a typed line in the box, on one line or several, at the prompt or while a turn runs, is a draft', () => {
  for (const [name, s] of Object.entries({ DRAFT, MULTILINE, SECOND_LINE_ONLY, PREFIX_TYPED, BUSY_DRAFT, AFTER_ESCAPE_DRAFT, PASTED })) assert.equal(paneHasDraft(s), true, name)
})
test("paneHasDraft: what it must not catch: an empty box, its dim placeholder, Claude Code's grey suggestion, the queued-messages hint, a menu", () => {
  for (const [name, s] of Object.entries({ EMPTY_PLACEHOLDER, SPACES_ONLY, SUGGESTION, BUSY_EMPTY, BUSY_QUEUED_HINT, REWIND })) assert.equal(paneHasDraft(s), false, name)
  for (const s of [PERMISSION, PLAN_MENU_322, '', '❯ ']) assert.equal(paneHasDraft(s), false, s)
})
test("paneHasDraft: a screen with no styles at all can't tell a draft from a suggestion, so it never holds", () => {
  for (const s of [DRAFT, MULTILINE, SUGGESTION]) assert.equal(paneHasDraft(plainScreen(s)), false)
  const grey = DRAFT.replace(/\x1b\[39m❯(\s)a half/, '\x1b[39m❯$1\x1b[38;2;153;153;153ma half'); assert.notEqual(grey, DRAFT)
  assert.equal(paneHasDraft(grey), false) // a grey in 24-bit colour is no draft either
})
test('paneHasDraft: a style tmux set on an earlier line still counts (it writes only the changes)', () => {
  const carried = [`\x1b[38;5;244m${R}`, '\x1b[39m❯ \x1b[2mcommit this', `\x1b[22m\x1b[38;5;244m${R}`, '\x1b[39m  ⏸ manual mode on'].join('\n')
  assert.equal(paneHasDraft(carried), false)
  assert.equal(paneHasDraft(carried.replace('commit this', 'commit this\x1b[22m and more')), true) // typed after the suggestion was taken
  assert.equal(paneHasDraft(`\x1b[2m\x1b[38;5;244m${R}\n\x1b[39m❯ dim from the rule above\n\x1b[38;5;244m${R}\n`), false)
})
test('plainScreen: the -e capture without its styles reads as the plain one, so paneLooksIdle sees the same screen', () => {
  assert.equal(plainScreen(SUGGESTION).split('\n').find((l) => l.startsWith('❯')), '❯\u00a0commit this') // 2.1.322 puts a no-break space after ❯
  assert.equal(paneLooksIdle(plainScreen(DRAFT)), true); assert.equal(paneLooksIdle(plainScreen(BUSY_EMPTY)), false)
})

// ---- Bug 189: a draft typed in the box while a turn runs. 2.1.322 drops "esc to interrupt" from the footer then. Whole screens captured with
// `tmux capture-pane -e` from a real 2.1.322 session on Haiku (2026-11-18; trailing spaces cut, the folder renamed), in testdata/bug189 ----
const screen189 = (name: string): string => readFileSync(new URL(`./testdata/bug189/${name}.ansi`, import.meta.url), 'utf8')
const WORKING_189 = ['busy-draft', 'busy-draft-long-cmd', 'busy-draft-streaming', 'busy-manual-draft', 'busy-empty'] // a Bash `sleep` runs, or text streams in
const IDLE_189 = ['idle-draft', 'idle-empty', 'idle-manual-draft', 'idle-bgshell-draft', 'escaped-draft', 'helper-running-draft'] // the turn has ended
test('Bug 189: the real screens are what their names say (a draft or not, and no "esc to interrupt" with a draft)', () => {
  for (const n of [...WORKING_189, ...IDLE_189]) {
    const s = screen189(n); assert.equal(paneHasDraft(s), n.includes('draft'), n)
    if (n.includes('draft')) assert.doesNotMatch(s, /esc to interrupt/, n)
  }
})
test('Bug 189: paneLooksIdle: a turn running under a half-typed draft is not idle (the grey ❯ of a capture with styles)', () => {
  for (const n of WORKING_189) assert.equal(paneLooksIdle(screen189(n)), false, n)
  for (const [name, s] of Object.entries({ BUSY_DRAFT, BUSY_EMPTY, BUSY_QUEUED_HINT })) assert.equal(paneLooksIdle(s), false, name) // Bug 149's captures
  for (const [name, s] of Object.entries({ EMPTY_PLACEHOLDER, DRAFT, SUGGESTION, AFTER_ESCAPE_DRAFT, SPACES_ONLY })) assert.equal(paneLooksIdle(s), true, name)
})
test('Bug 189: paneLooksIdle: what it must not catch: an ended turn, with or without a draft, a background shell, a helper still running, after Escape', () => {
  for (const n of IDLE_189) {
    assert.equal(paneLooksIdle(screen189(n)), true, n)
    assert.equal(paneLooksIdle(plainScreen(screen189(n))), true, `${n} (plain)`)
  }
})
test('Bug 189: paneLooksIdle on a plain capture: the working line above the box says a turn runs; streamed text has none', () => {
  for (const n of ['busy-draft', 'busy-draft-long-cmd', 'busy-manual-draft']) assert.equal(paneLooksIdle(plainScreen(screen189(n))), false, n)
  assert.equal(paneLooksIdle(plainScreen(screen189('busy-draft-streaming'))), true) // only the styles tell; the screen changes all the time then
  // the line under a finished turn is no working line
  for (const done of ['✻ Baked for 22s · done 2:21 AM', '✻ Waiting for 1 background agent to finish', '⏺ Checking the logs…']) {
    assert.equal(paneLooksIdle(box('❯ ', '  ⏸ manual mode on', done)), true, done)
  }
  assert.equal(paneLooksIdle(box('❯ ', '  ⏸ manual mode on', '✽ Doodling… (3s · ↓ 16 tokens)\n  ⎿  Tip: Create skills')), false) // a tip line under it
})

// ---- Bug 195: a paused role's agents get Escape, but only into a screen where a turn is at work (pause.ts stopForPause) ----
test('Bug 195: paneAtWork: a turn at work, with "esc to interrupt" in the footer or (a draft in the box) without it', () => {
  for (const [name, s] of Object.entries({ THINKING, RUNNING, BUSY_DRAFT, BUSY_EMPTY, BUSY_QUEUED_HINT })) assert.equal(paneAtWork(s), true, name)
  for (const s of BUSY_322) assert.equal(paneAtWork(s), true, s)
  for (const n of WORKING_189) assert.equal(paneAtWork(screen189(n)), true, n)
})
test('Bug 195: paneAtWork: what it must not catch: an ended turn (a draft, a helper or a background shell still there), a menu, a dialog, no prompt box', () => {
  for (const n of IDLE_189) assert.equal(paneAtWork(screen189(n)), false, n) // Escape there stops nothing, and twice it clears somebody's draft
  for (const s of [IDLE_TPM, IDLE_ENG, ...IDLE_322]) assert.equal(paneAtWork(s), false, s)
  for (const [name, s] of Object.entries({ EMPTY_PLACEHOLDER, DRAFT, SUGGESTION, AFTER_ESCAPE_DRAFT, REWIND })) assert.equal(paneAtWork(s), false, name)
  for (const [name, s] of Object.entries({ PLAN_MENU, PERMISSION, PLAN_MENU_322 })) assert.equal(paneAtWork(s), false, name) // Escape would answer it
  // Claude Code still starting, a shell, nothing: no box to tell by, so nothing HQ knows how to stop
  for (const s of ['', 'zsh: command not found: claude\n$ ', '❯ \n  ? for shortcuts\n']) assert.equal(paneAtWork(s), false, JSON.stringify(s))
})

// ---- Bug 331: a restart in the middle of HQ typing a line leaves its first pieces (250 characters each) in the box. Captured from real
// Claude Code 2.1.322 on Haiku (2026-11-21), HQ's own typing (send-keys -l in pieces): `half` 2 of 8 pieces after Escape stopped a turn (110
// columns), `half-200` the same at 200, `whole` all pieces with no Enter, `mine` 1 piece and then words typed after it, `scrolled` 15 of 20
// pieces, more than the box shows (only the end, with the ❯ on its first line). The rest typed after `half` went in as exactly the whole line.
const cap331 = (name: string): string => readFileSync(new URL(`./testdata/bug331/${name}`, import.meta.url), 'utf8')
const flat = (s: string): string => s.replace(/\s+/g, '')
test('Bug 331: draftText is what was typed in the box, lines as wrapped (the space at each break gone)', () => {
  const long = cap331('long.txt'), d = draftText(cap331('half.ansi'))
  assert.equal(d.split('\n').length, 5); assert.ok(d.startsWith('[urgent] from HQ: Stop'))
  assert.equal(flat(d), flat(long.slice(0, 500))); assert.equal(flat(draftText(cap331('half-200.ansi'))), flat(long.slice(0, 500)))
  for (const s of [EMPTY_PLACEHOLDER, SUGGESTION, '']) assert.equal(draftText(s), '')
})
test("Bug 331: ownHalfLine: the box holds HQ's own first pieces of the line and nothing else: the rest, or '' when only Enter is missing", () => {
  const long = cap331('long.txt')
  assert.equal(ownHalfLine(cap331('half.ansi'), long), long.slice(500)); assert.equal(ownHalfLine(cap331('half-200.ansi'), long), long.slice(500))
  assert.equal(ownHalfLine(cap331('whole.ansi'), cap331('short.txt')), '')
  assert.equal(paneLooksIdle(cap331('half.ansi')), true) // at its waiting prompt: HQ may type there
})
test("Bug 331: ownHalfLine: what it must not catch, so a person's typing is never sent or added to", () => {
  const long = cap331('long.txt')
  assert.equal(ownHalfLine(cap331('mine.ansi'), long), null, "somebody's words after HQ's first piece")
  assert.equal(ownHalfLine(cap331('scrolled.ansi'), cap331('longer.txt')), null, 'only the end of the box shows')
  assert.equal(ownHalfLine(cap331('half.ansi'), long.replace('Pin it', 'Pin It')), null, 'another line')
  assert.equal(ownHalfLine(cap331('half.ansi'), cap331('short.txt')), null, 'more in the box than the whole line')
  const typed = (t: string): string => [`\x1b[38;5;244m${R}`, `\x1b[39m❯ ${t}`, `\x1b[38;5;244m${R}`, '\x1b[39m  \x1b[38;5;147m⏵⏵ accept edits on\x1b[39m'].join('\n')
  assert.equal(ownHalfLine(typed(long.slice(0, 250)), long), long.slice(250)); assert.equal(ownHalfLine(typed(long.slice(0, 200)), long), null, 'not a whole piece')
  assert.equal(ownHalfLine(typed(`my own ${long.slice(0, 250)}`), long), null, 'words before it')
  const grey = typed(`\x1b[2m${long.slice(0, 250)}\x1b[0m`); assert.equal(ownHalfLine(grey, long), null, "Claude Code's grey suggestion is nobody's typing")
  for (const s of [EMPTY_PLACEHOLDER, SUGGESTION, plainScreen(cap331('half.ansi'))]) assert.equal(ownHalfLine(s, long), null)
})

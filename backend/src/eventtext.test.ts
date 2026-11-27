// Bug 121: the Events tab's lines. Against a real SQLite DB in a temp HQ_HOME: an agent's history comes back newest first, in plain words,
// with HQ's chatter (mod polls, the other half of a tool call, a page opening its terminal) left out before the limit, not after.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-eventtext-'))
const { migrate, run } = await import('./db.ts')
migrate()
const { emit } = await import('./events.ts')
const { agentEvents, eventLine, field, lineOwner } = await import('./eventtext.ts')

const agent = (id: string, role: string, name: string) =>
  run('INSERT INTO agents(id, role, model_alias, token_hash, started_at, display_name) VALUES (?,?,?,?,?,?)', id, role, 'opus', 'x', 1, name)
agent('tpm-1', 'tpm', 'TPM'); agent('eng-1', 'engineer', 'eng PAY-1'); agent('eng-2', 'engineer', 'eng PAY-2')
const hook = (agentId: string, kind: string, payload: Record<string, unknown>) => emit({ agentId, source: 'hook', kind, payload })

test('a cut-off tool input still gives its command or file', () => {
  const cmd = JSON.stringify({ command: 'python3 -m unittest tests/test_x.py -v && echo "done"', description: 'x'.repeat(400) }).slice(0, 120) + '…'
  assert.equal(field(cmd, 'command'), 'python3 -m unittest tests/test_x.py -v && echo "done"')
  const cut = JSON.stringify({ command: 'echo ' + 'a'.repeat(400) }).slice(0, 300) + '…' // cut inside the command itself
  assert.match(field(cut, 'command'), /^echo a+…$/) // still says it's cut
  assert.equal(field('{"file_path":"/w/src/a\\', 'file_path'), '/w/src/a…') // cut in the middle of an escape
  assert.equal(field('{"file_path":"C:\\\\w\\\\a.py"}', 'file_path'), 'C:\\w\\a.py') // whole escapes are read
  assert.equal(field('not json', 'command'), '')
  assert.equal(eventLine('hook.PreToolUse:Read', { input: '{"file_path":"/Users/x/repo/src/parser.py"}' }), 'Read src/parser.py')
  assert.equal(eventLine('hook.PreToolUse:Bash', { input: cmd, sub: true }), 'Helper · Command: python3 -m unittest tests/test_x.py -v && echo "done"')
})

test('Bug 185: a second read of a ticket\'s changes says it is a read of new commits', () => {
  assert.equal(eventLine('auto.read', { key: 'PAY-1', state: 'ok', findings: [] }), "A fresh reader of PAY-1's changes found nothing wrong")
  assert.equal(eventLine('auto.read', { key: 'PAY-1', state: 'sent_back', findings: [{}], again: true }), "A fresh reader of PAY-1's changes (read again: it has new commits) found a problem")
})

test('Bug 206: a ticket that came back says what sent it back: the tests, HQ\'s look at the app, or the reader', () => {
  const back = (p: Record<string, unknown>) => eventLine('ticket.fix_tests', { key: 'PAY-1', ...p })
  assert.equal(back({ why: 'tests', hung: false }), 'PAY-1 came back: its tests fail')
  assert.equal(back({ why: 'tests_hung', hung: true }), 'PAY-1 came back: its tests never finish')
  // Bug 373: nothing failed there, and HQ only knows it didn't see them: with how many once HQ kept that (rows from before have no count, and `why: 'tests'`)
  assert.equal(back({ why: 'tests', unproven: true }), "PAY-1 came back: its tests passed, but some tests named for its criteria weren't seen running")
  assert.equal(back({ why: 'tests_unseen', unproven: true, missing: 8 }), "PAY-1 came back: its tests passed, but 8 tests named for its criteria weren't seen running")
  assert.equal(back({ why: 'look', hung: false }), "PAY-1 came back: HQ's look at the app found something wrong")
  assert.equal(back({ why: 'review', hung: false, again: true }), 'PAY-1 came back: a fresh reader of its changes found something to fix')
  // rows from before Bug 206 have no `why`: a hung run said so; any other may have been the reader or the look, so the line doesn't say "tests fail"
  assert.equal(back({ hung: true }), 'PAY-1 came back: its tests never finish')
  assert.equal(back({ hung: false }), "PAY-1 came back: HQ's check before merging found something to fix")
  // what it must not change: conflicts still read as conflicts
  assert.equal(eventLine('ticket.fix_conflicts', { key: 'PAY-1', clean: false }), 'PAY-1 came back: merge conflicts')
})

test('Bug 208: a read nobody could have doesn\'t say the ticket merged: it is written before HQ knows, and a commit during the read sends it back', () => {
  assert.equal(eventLine('auto.read', { key: 'PAY-1', state: 'unchecked', findings: [] }), "Nobody could read PAY-1's changes: the reader couldn't be asked")
})

test('what the tab leaves out: the other half of a tool call, HQ\'s plumbing, a page opening the terminal', () => {
  for (const k of ['hook.PostToolUse:Bash', 'mod.turn.step', 'mod.poll_error', 'mcp.update_handoff', 'tmux.attached', 'tmux.detached', 'batch.handed', 'hook.ConfigChange'])
    assert.equal(eventLine(k, {}), null, k)
  // and what it must not leave out: a failed tool call is not the other half of one, and an unknown kind shows by name
  assert.equal(eventLine('hook.PostToolUseFailure:Bash', { error: 'Exit code 1\nFAILED (failures=2)' }), 'Bash failed: Exit code 1 FAILED (failures=2)')
  assert.equal(eventLine('hook.PreToolUse:mcp__hq__update_handoff', {}), 'Asked HQ: update handoff')
  assert.equal(eventLine('some.new_kind', {}), 'some.new_kind')
  assert.equal(eventLine('hook.PermissionRequest:Bash', {}), null) // HQ answers it: the tool call itself is the line
  assert.equal(eventLine('hook.PreToolUse:Bash', { input: '{"command":"cd \\"/w/my repo/.claude/worktrees/A-1\\" && npm test"}' }), 'Command: npm test')
  assert.equal(eventLine('hook.UserPromptSubmit', { prompt: 'HQ message batch B-1a:\n[fyi] from HQ [msg msg-9f]: HQ: A-1 merged.' }), 'Messages: [fyi] from HQ: HQ: A-1 merged.')
  assert.equal(eventLine('gate.verdict', { verdict: 'approve', by: 'auto' }), 'Plan approved by HQ')
  assert.equal(eventLine('attention.context_high', { detail: 'eng A-1 is at 114k of context' }), 'Alert: eng A-1 is at 114k of context')
  assert.equal(eventLine('agent.recovered', {}), 'Its terminal is back')
  assert.equal(eventLine('ticket.launched', { ticket: 'tkt-x', key: 'A-1', fix: true, adopted: true }), 'Back on A-1 (HQ restarted as it started; it took this session over)') // Bug 398
})

test('an agent\'s history: newest first, its own lines only, named as on the board, chatter dropped before the limit', () => {
  run('PRAGMA foreign_keys = OFF') // a ticket with no feature or repo: only its key is read
  run('INSERT INTO tickets(id, feature_id, key, slug, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'tkt-1', 'f-1', 'PAY-1', 'pay-1', 'Payments', 1, 1)
  emit({ agentId: 'eng-1', source: 'system', kind: 'ticket.launched', payload: { ticket: 'tkt-1', fix: false } })
  hook('eng-1', 'hook.UserPromptSubmit', { prompt: 'Work on PAY-1' })
  hook('eng-1', 'hook.PreToolUse:Bash', { input: '{"command":"python3 -m unittest"}' })
  hook('eng-2', 'hook.PreToolUse:Bash', { input: '{"command":"npm test"}' }) // someone else's
  for (let i = 0; i < 50; i++) { hook('eng-1', 'mod.turn.step', {}); hook('eng-1', 'hook.PostToolUse:Bash', {}) } // a busy agent's noise
  hook('eng-1', 'tmux.attached', { external: false }) // the user opening its Agent tab
  emit({ agentId: 'eng-1', source: 'system', kind: 'message.sent', payload: { to: 'tpm-1' } })
  const got = agentEvents('eng-1', 4)
  assert.deepEqual(got.map((e) => e.text), ['Sent a message to TPM', 'Command: python3 -m unittest', 'Got a prompt: Work on PAY-1', 'Started on PAY-1'])
  assert.ok(got.every((e) => e.agentId === 'eng-1' && e.id > 0))
  assert.ok(got[0]!.id > got[1]!.id, 'newest first, by row id')
  assert.deepEqual(agentEvents('nobody'), [])
})

test('emit gives each event its row id (the tab joins history and live lines by it)', () => {
  const a = emit({ agentId: 'eng-1', source: 'system', kind: 'agent.interrupted', payload: {} }), b = emit({ agentId: 'eng-1', source: 'system', kind: 'agent.lost', payload: {} })
  assert.ok(typeof a.id === 'number' && b.id === a.id + 1)
  assert.equal(agentEvents('eng-1', 1)[0]!.id, b.id)
})

test('HQ\'s own events about a ticket (no agent) go to the ticket\'s engineer: its test run, a refused merge; another ticket\'s don\'t', () => {
  run('UPDATE agents SET ticket_id = ? WHERE id = ?', 'tkt-1', 'eng-1'); run('UPDATE tickets SET assignee_agent_id = ? WHERE id = ?', 'eng-1', 'tkt-1')
  emit({ agentId: null, source: 'system', kind: 'auto.tested', payload: { ticket: 'tkt-1', key: 'PAY-1', result: 'fail', test: 'npm test' } })
  emit({ agentId: null, source: 'ui', kind: 'ticket.merge_refused', payload: { ticket: 'tkt-1', key: 'PAY-1', why: 'conflicts with main in a.py' } })
  emit({ agentId: null, source: 'system', kind: 'auto.tested', payload: { ticket: 'tkt-2', key: 'PAY-2', result: 'pass' } })
  emit({ agentId: null, source: 'system', kind: 'worktree.removed', payload: { ticket: 'PAY-1', path: '/x' } }) // a key, not a ticket id: not matched
  assert.deepEqual(agentEvents('eng-1', 2).map((e) => e.text), ["HQ didn't merge PAY-1: conflicts with main in a.py", 'HQ tested PAY-1 before merging: the tests fail'])
  assert.ok(agentEvents('eng-1', 2).every((e) => e.agentId === 'eng-1'))
  assert.ok(!agentEvents('eng-2').some((e) => e.text.includes('PAY-1 before merging')) && !agentEvents('tpm-1').some((e) => e.text.includes('PAY')))
  assert.equal(lineOwner(null, { ticket: 'tkt-1' }), 'eng-1') // the live feed sends it to the same tab
  assert.equal(lineOwner(null, { ticket: 'PAY-1' }), null); assert.equal(lineOwner('tpm-1', { ticket: 'tkt-1' }), 'tpm-1')
  emit({ agentId: null, source: 'system', kind: 'auto.moved', payload: { ticket: 'tkt-1', key: 'PAY-1', finished: 'a', now: 'b', told: 'eng-1' } }) // Bug 143
  assert.equal(agentEvents('eng-1', 1)[0]!.text, "HQ didn't merge PAY-1: its branch got commits after open_pr, so it goes back to its engineer to call open_pr again")
  // Bug 184: the branch moved while HQ merged it
  emit({ agentId: null, source: 'system', kind: 'auto.moved', payload: { ticket: 'tkt-1', key: 'PAY-1', finished: 'a', now: 'b', told: 'eng-1', merged: true, named: false } })
  assert.equal(agentEvents('eng-1', 1)[0]!.text, "HQ merged the commit PAY-1's open_pr handed over, but its branch got commits meanwhile that aren't in main, so it goes back to "
    + 'its engineer to call open_pr again')
  emit({ agentId: null, source: 'system', kind: 'auto.moved', payload: { ticket: 'tkt-1', key: 'PAY-1', finished: 'a', now: 'b', told: null, merged: true, named: true } })
  assert.equal(agentEvents('eng-1', 1)[0]!.text, "HQ merged the commit PAY-1's open_pr handed over; the ones its branch got meanwhile are tested and merged next")
  emit({ agentId: null, source: 'system', kind: 'auto.left_behind', payload: { ticket: 'tkt-1', key: 'PAY-1', merged: 'a', now: 'b', commits: 2 } })
  assert.equal(agentEvents('eng-1', 1)[0]!.text, "PAY-1 merged, but its branch got 2 commits meanwhile that aren't in main; its TPM was told")
  // Bug 212: the same during the user's Merge into main: a local repo keeps the ticket ready for the rest, a GitHub one names what was left
  emit({ agentId: null, source: 'system', kind: 'ticket.merged_late', payload: { ticket: 'tkt-1', key: 'PAY-1', head: 'a', now: 'b', commits: 1, merged: false } })
  assert.equal(agentEvents('eng-1', 1)[0]!.text, 'HQ merged PAY-1 as it was when Merge into main was pressed, but its branch got a commit meanwhile: it stays ready to merge the rest')
  emit({ agentId: null, source: 'system', kind: 'ticket.merged_late', payload: { ticket: 'tkt-1', key: 'PAY-1', head: 'a', now: 'b', commits: 3, merged: true } })
  assert.equal(agentEvents('eng-1', 1)[0]!.text, "PAY-1 merged, but its branch got 3 commits meanwhile that aren't in main; its TPM was told")
})

/** Bug 201: every emit({ … kind … }) in the backend's code, read from the source: the kind's text (a quoted kind, each kind of a `a ? 'x' : 'y'`, or a
 *  template's fixed start), whether its agent is written as a literal null, and its payload's `ticket`, if any. */
function loggedKinds(): { kinds: string[]; prefixes: string[]; agentNull: boolean; ticket: string | null; at: string }[] {
  const dir = path.join(import.meta.dirname), out: ReturnType<typeof loggedKinds> = []
  for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
    const s = fs.readFileSync(path.join(dir, f), 'utf8'), re = /(?<![\w.])emit\(\{/g
    for (let m = re.exec(s); m; m = re.exec(s)) {
      let i = m.index + 5; for (let d = 0; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')' && --d < 0) break }
      const call = s.slice(m.index, i + 1).replace(/\s+/g, ' '), kind = /\bkind: (.*?), (?:payload|source)\b/.exec(call)?.[1] ?? ''
      out.push({ kinds: [...kind.replace(/`[^`]*`/g, '').matchAll(/'([^']+)'/g)].map((x) => x[1]!), prefixes: [...kind.matchAll(/`([^`$]*)\$\{/g)].map((x) => x[1]!),
        agentNull: /\bagentId: null\b/.test(call), ticket: /\bticket(?:: ([^,}]+))?\s*[,}]/.exec(call.slice(call.indexOf('payload')))?.[1] ?? (/\bticket\s*[,}]/.test(call) ? 'ticket' : null),
        at: `${f}:${s.slice(0, m.index).split('\n').length}` })
    }
  }
  return out
}
/** Kinds HQ logs with no agent whose payload names a ticket by its key (or a variable holding the key), not by its id: lineOwner can't place them, so
 *  they never reach an Events tab. */
const KEY_NOT_ID = new Set(['preview.error'])

test('Bug 201: every kind HQ logs that can reach an Events tab has plain words (or is left out on purpose)', async () => {
  const calls = loggedKinds()
  assert.ok(calls.length > 100 && calls.some((c) => c.kinds.includes('bg.stopped')), `the scan found ${calls.length} emit calls: it no longer reads the code`)
  const raw: string[] = []
  for (const c of calls) {
    // It shows on a tab when it has an agent, or when its payload names a ticket by id (lineOwner, agentEvents). A key (`t.key`) doesn't count.
    const reaches = !c.agentNull || (c.ticket !== null && !/key/i.test(c.ticket) && !c.kinds.every((k) => KEY_NOT_ID.has(k)))
    if (!reaches) continue
    for (const k of c.kinds) if (eventLine(k, {}) === k) raw.push(`${k} (${c.at})`)
    for (const pre of c.prefixes) {
      if (pre === 'hook.' || pre === 'attention.') continue // below, and an alert always has its detail
      if (eventLine(`${pre}x`, {}) !== null) raw.push(`${pre}… (${c.at}): not left out`)
    }
  }
  // Every hook event HQ asks Claude Code for, for any role: with a tool when the event has one
  const { buildSettings } = await import('./roles.ts')
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-eventtext-agent-'))
  const events = new Set((['tpm', 'architect', 'engineer', 'launcher', 'tester'] as const).flatMap((r) => Object.keys(buildSettings(r, 't', { agentDir }).hooks as object)))
  assert.ok(events.has('SubagentStop') && events.has('PreToolUse'), [...events].join(' '))
  for (const ev of events) for (const k of /Tool|Permission/.test(ev) ? [`hook.${ev}:Bash`, `hook.${ev}:SomeTool`] : [`hook.${ev}`]) if (eventLine(k, {}) === k) raw.push(k)
  assert.deepEqual(raw, [], 'these kinds would show in the Events tab as their raw name: give them words in eventtext.ts, or leave them out (HIDDEN)')
})

test('"Have HQ test this": its start, its end each way, and a send to the engineer, in words', () => {
  assert.equal(eventLine('check.started', { key: 'T-01' }), 'You had HQ test T-01')
  assert.equal(eventLine('check.ended', { key: 'T-01', state: 'pass' }), "HQ's test of T-01: everything passed")
  assert.equal(eventLine('check.ended', { key: 'T-01', state: 'fail' }), "HQ's test of T-01 found a problem (View results on its box)")
  assert.equal(eventLine('check.ended', { key: 'T-01', state: 'stopped', why: 'you stopped it' }), "HQ's test of T-01 stopped: you stopped it")
  assert.equal(eventLine('check.ended', { key: 'T-01', state: 'error', why: 'the app wouldn\'t start' }), "HQ couldn't finish testing T-01: the app wouldn't start")
  assert.equal(eventLine('check.sent', { key: 'T-01' }), "You sent what HQ's test of T-01 found to its engineer")
})

test('Bug 374: a test that ran the app on another port says which, and who had the project\'s own', () => {
  assert.equal(eventLine('testrun.port_moved', { repo: 'shop', part: 'api', from: 8000, to: 50123, by: "HQ's preview of shop", files: ['web/vite.config.ts'] }),
    "HQ ran its own copy of shop for a test with its api part on port 50123 instead of 8000 (in use by HQ's preview of shop)")
})

test('Bug 201: what the stop of a frozen run and the other newly worded kinds say', () => {
  assert.equal(eventLine('bg.stopped', { by: 'user', tasks: ['b1'], minutes: 12, commands: ['npm run test-backend'] }),
    'You stopped its frozen background run: npm run test-backend (no CPU, no output for 12 min)')
  assert.equal(eventLine('bg.stopped', { by: 'auto', tasks: ['b1', 'b2'], minutes: 3, commands: ['npm test', 'npm run e2e'] }),
    'Auto mode stopped 2 frozen background runs: npm test, npm run e2e (no CPU, no output for 3 min)')
  assert.equal(eventLine('bg.stopped', { by: 'user', tasks: ['b1'], minutes: 5 }), 'You stopped its frozen background run (no CPU, no output for 5 min)') // logged before
  assert.equal(eventLine('bg.stop_failed', { error: 'Error: Nothing frozen to stop' }), "HQ couldn't stop its frozen background run: Error: Nothing frozen to stop")
  assert.equal(eventLine('auto.looked', { ticket: 'tkt-x', key: 'PAY-9', ran: 'fail', why: 'the page shows an error' }),
    'HQ opened the app with PAY-9 merged in and found a problem: the page shows an error')
  assert.equal(eventLine('auto.looked', { key: 'PAY-9', ran: 'pass' }), 'HQ opened the app with PAY-9 merged in: it looks fine')
  assert.equal(eventLine('hook.SubagentStart', { sub: true }), null) // "Started a helper: …" is its line
  assert.equal(eventLine('hook.SubagentStop', { sub: true }), 'A helper finished') // what the new left-out kind must not catch
  assert.equal(eventLine('bg.ended', { task: 'b1', why: 'gone' }), 'Background run ended (its process is gone)')
  assert.equal(eventLine('bg.ended', { task: 'b1', why: 'something new' }), 'Background run ended (something new)')
  assert.equal(eventLine('message.held', { id: 'm', why: 'draft' }), 'HQ held a message back: there was half-typed text in its prompt box')
  assert.equal(eventLine('message.held', { id: 'm', why: 'screen' }), "HQ held a message back: its terminal didn't show its waiting prompt") // Bug 296
  assert.equal(eventLine('message.held', { id: 'm', why: 'something new' }), 'HQ held a message back')
  assert.equal(eventLine('message.cut_short', { id: 'm', reason: 'fresh_start' }), 'HQ restarted while it was typing a message into its terminal: it types it again')
  assert.equal(eventLine('message.typed', { id: 'm', reason: 'fresh_start', again: true }), 'HQ typed a message into its terminal after its restart')
  assert.equal(eventLine('message.typed', { id: 'm', reason: 'urgent' }), 'HQ typed a message into its terminal')
  assert.equal(eventLine('message.typed', { id: 'm', reason: 'urgent', again: true, finished: true }), // Bug 331
    'HQ typed the rest of a message into its terminal after its restart (its first part was already in)')
})

test('Bug 370: a message that went in with a working agent\'s step says so, with its words', () => {
  assert.equal(eventLine('message.at_step', { ids: ['m'], text: "HQ: the TPM updated T-01's spec. Call get_ticket to read it." }),
    "Got a message while it worked, with its last step: HQ: the TPM updated T-01's spec. Call get_ticket to read it.")
  assert.equal(eventLine('message.at_step', { ids: ['m', 'n'], text: 'HQ: one. HQ: two.' }), 'Got 2 messages while it worked, with its last step: HQ: one. HQ: two.')
})

test('Bug 210: the lines name the project\'s own default branch (master here), and main for a ticket that is gone', () => {
  run("INSERT INTO repos(id, name, path, kind, default_branch, created_at) VALUES ('r-m', 'old', '/tmp/old', 'local', 'master', 1)")
  run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('f-m', 'r-m', 'f', 'f', 'x', 'planning', 1, 1)")
  run('INSERT INTO tickets(id, feature_id, key, slug, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'tkt-m', 'f-m', 'OLD-1', 'old-1', 'Old', 1, 1)
  const p = { ticket: 'tkt-m', key: 'OLD-1' }
  assert.equal(eventLine('ticket.merged', p), 'OLD-1 is in master')
  assert.equal(eventLine('auto.tested', { ...p, result: 'conflicts' }), 'HQ tested OLD-1 before merging: it conflicts with master')
  assert.equal(eventLine('auto.tested', { ...p, result: 'pass' }), 'HQ tested OLD-1 before merging: the tests pass')
  assert.equal(eventLine('auto.repair_opened', p), 'HQ opened OLD-1 to fix master')
  assert.match(eventLine('auto.moved', { ...p, merged: true, named: false })!, /commits meanwhile that aren't in master, so it goes back/)
  assert.equal(eventLine('auto.left_behind', { ...p, commits: 1 }), "OLD-1 merged, but its branch got a commit meanwhile that isn't in master; its TPM was told")
  assert.equal(eventLine('ticket.merged', { ticket: 'gone', key: 'X-9' }), 'X-9 is in main')
})

test('Bug 226: HQ stopping a Launch helper\'s test server on a port it wasn\'t given', () => {
  assert.equal(eventLine('launch.test_port', { repo: 'porty', ports: [3180], given: [4087, 4088, 4089] }),
    'HQ stopped its test server on port 3180: not one HQ gave it for tests (4087, 4088, 4089), so it could clash with another app. Its save was refused')
})

test('Bug 248: a refused open_pr shows on its engineer\'s Events in plain words, with HQ\'s reason; the mcp call itself stays left out', () => {
  const why = "HQ hasn't seen this project's test command run on PAY-1. Run the project's test command, the whole suite and not only your own test files: npm test."
  emit({ agentId: 'eng-1', source: 'mcp', kind: 'mcp.open_pr', payload: { args: { title: 'Totals' } } })
  emit({ agentId: 'eng-1', source: 'mcp', kind: 'ticket.pr_refused', payload: { ticket: 'tkt-1', key: 'PAY-1', why } })
  const lines = agentEvents('eng-1', 2).map((e) => e.text)
  assert.equal(lines[0], `HQ didn't take PAY-1 as finished (open pr): ${why}`)
  assert.ok(!lines.some((l) => l.startsWith('mcp.')), lines.join(' | '))
  assert.equal(eventLine('mcp.open_pr', { args: {} }), null) // what it must not change: HQ's other mcp calls stay out
  assert.equal(agentEvents('eng-2', 300).some((e) => /as finished/.test(e.text)), false) // only its own engineer's tab
})

test('Bug 289: a background run that ended names its command, a turn with no Stop hook gets a "Turn ended" line, and a wait for a turn says behind whom', () => {
  assert.equal(eventLine('bg.ended', { task: 'b1', why: 'gone', command: 'npm test -- --runInBand' }), 'Background run ended: npm test -- --runInBand (its process is gone)')
  assert.equal(eventLine('bg.ended', { task: 'b1', why: 'done', command: `node --test ${'x'.repeat(200)}` }), `Background run ended: node --test ${'x'.repeat(88)}… (it finished)`)
  assert.equal(eventLine('bg.ended', { task: 'b1', why: 'gone' }), 'Background run ended (its process is gone)') // logged before: no command, no "undefined"
  assert.equal(eventLine('bg.ended', { task: 'b1' }), 'Background run ended')
  // Escape or No on a dialog: no Stop hook comes, so HQ's own line says the turn ended, and what the agent still waits on
  assert.equal(eventLine('agent.turn_over', { why: 'no_stop', still: null }), 'Turn ended: Escape or No on a question on its screen')
  assert.equal(eventLine('agent.turn_over', { why: 'dialog', still: 'Subagent: Map the code' }),
    'Turn ended: Escape or No on a question on its screen · its helper still runs: Map the code')
  assert.equal(eventLine('agent.turn_over', { why: 'no_stop', still: 'Waiting on: npm test (+1 more)' }),
    'Turn ended: Escape or No on a question on its screen · still waiting on npm test (+1 more)')
  assert.equal(eventLine('agent.turn_over', {}), 'Turn ended: Escape or No on a question on its screen')
  assert.equal(eventLine('agent.interrupted', { why: 'turn' }), 'Interrupted (Escape)') // what it must not change: an interrupt keeps its own line
  // a wait for a turn: behind whoever holds the turns as it began to wait (heavy.ts), one, two or more
  assert.equal(eventLine('turns.waiting', { who: 'eng PAY-2', what: 'tests', behind: ["HQ's test of PAY-1"] }), "Waiting its turn for tests behind HQ's test of PAY-1")
  assert.equal(eventLine('turns.waiting', { what: 'build', behind: ['eng PAY-1', "HQ's test of PAY-3"] }), "Waiting its turn for build behind eng PAY-1 and HQ's test of PAY-3")
  assert.equal(eventLine('turns.waiting', { what: 'tests', behind: ['eng PAY-1', 'eng PAY-3', 'eng PAY-4'] }), 'Waiting its turn for tests behind eng PAY-1 and 2 more')
  assert.equal(eventLine('turns.waiting', { what: 'tests', behind: [] }), 'Waiting its turn for tests') // the holder had just gone: nobody to name
  assert.equal(eventLine('turns.waiting', { what: 'tests' }), 'Waiting its turn for tests') // no `behind` at all: the old words
  assert.equal(eventLine('turns.waiting', { what: 'tests', behind: 'garbled' }), 'Waiting its turn for tests')
})

test('Bug 297: a Stop HQ learnt of late (its hook went to an HQ that was down) says so', () => {
  assert.equal(eventLine('hook.Stop', { last: 'Here is the list:\n1. Apple', away: true }), 'Turn ended while HQ was down: Here is the list: 1. Apple')
  assert.equal(eventLine('hook.Stop', { away: true }), 'Turn ended while HQ was down')
  assert.equal(eventLine('hook.StopFailure', { error: 'an API error', away: true }), 'Turn failed while HQ was down: an API error') // Bug 367
  assert.equal(eventLine('hook.StopFailure', { error: 'overloaded_error' }), 'Turn failed: overloaded_error')
  assert.equal(eventLine('hook.Stop', { last: 'Done.' }), 'Turn ended: Done.') // what it must not change: a Stop that came in time
})

test('Bug 309: HQ\'s own wait for its turn reaches its ticket\'s engineer\'s Events tab, by the run\'s name; one with no ticket reaches no tab', async () => {
  const { release, take, withTurn } = await import('./heavy.ts')
  agent('eng-309', 'engineer', 'eng PAY-9'); agent('eng-309b', 'engineer', 'eng PAY-8')
  run('INSERT INTO tickets(id, feature_id, key, slug, title, created_at, updated_at, assignee_agent_id) VALUES (?,?,?,?,?,?,?,?)', 'tkt-309', 'f-1', 'PAY-9', 'pay-9',
    'Refunds', 1, 1, 'eng-309'); run('UPDATE agents SET ticket_id = ? WHERE id = ?', 'tkt-309', 'eng-309')
  const live: { owner: string | null; text: string | null }[] = [], { bus } = await import('./events.ts') // what the page's live feed sends, as ui.ts does
  const feed = (e: { agentId: string | null; kind: string; payload: Record<string, unknown> }) => live.push({ owner: lineOwner(e.agentId, e.payload), text: eventLine(e.kind, e.payload) })
  bus.on('event:turns.waiting', feed); bus.on('event:turns.started', feed)
  take({ id: 'b309:u1', who: 'eng PAY-8', what: 'tests', agentId: 'eng-309b', lane: 'main', limitMs: Infinity }) // the other engineer's npm test holds the turn
  let ran = false
  const hq = withTurn("HQ's test of PAY-9", 'tests', async () => { ran = true }, undefined, { ticket: 'tkt-309' })
  await new Promise((r) => setImmediate(r)); assert.equal(ran, false)
  assert.deepEqual(live, [{ owner: 'eng-309', text: "HQ's test of PAY-9 waits its turn behind eng PAY-8" }])
  release('b309:u1'); await hq; assert.equal(ran, true)
  assert.deepEqual(live.at(-1), { owner: 'eng-309', text: "HQ's test of PAY-9 started" })
  assert.deepEqual(agentEvents('eng-309', 2).map((e) => e.text), ["HQ's test of PAY-9 started", "HQ's test of PAY-9 waits its turn behind eng PAY-8"])
  assert.ok(!agentEvents('eng-309b').some((e) => e.text.includes('PAY-9'))) // not the tab of the engineer it waited behind
  // main's own test: no ticket, so no tab (as before)
  take({ id: 'b309:u2', who: 'eng PAY-8', what: 'tests', agentId: 'eng-309b', lane: 'main', limitMs: Infinity })
  const main = withTurn("HQ's test of main", 'tests', async () => {}); await new Promise((r) => setImmediate(r)); release('b309:u2'); await main
  assert.deepEqual(live.slice(-2).map((l) => l.owner), [null, null])
  bus.off('event:turns.waiting', feed); bus.off('event:turns.started', feed)
  // the words: HQ's run by its name, an engineer's own as before
  assert.equal(eventLine('turns.waiting', { who: "HQ's test of PAY-1", what: 'tests', behind: ['eng PAY-2', 'eng PAY-3', 'eng PAY-4'], ticket: 'tkt-1', hq: true }),
    "HQ's test of PAY-1 waits its turn behind eng PAY-2 and 2 more")
  assert.equal(eventLine('turns.waiting', { who: "HQ's look at PAY-1", what: 'tests', behind: [], hq: true }), "HQ's look at PAY-1 waits its turn")
  assert.equal(eventLine('turns.started', { who: "HQ's test of PAY-1", what: 'tests', waitedS: 42, late: false, hq: true }), "HQ's test of PAY-1 started after waiting 42 s")
  assert.equal(eventLine('turns.started', { who: 'eng PAY-2', what: 'tests', use: 'u', waitedS: 42 }), 'Its turn: tests started after 42 s')
})

test('Bug 346: a turn HQ learnt of late (it started while HQ was down) says so', () => {
  assert.equal(eventLine('agent.turn_started_away', { was: 'idle' }), 'Its turn started while HQ was down: shown as working')
})

test('Bug 373: the Events tab says what the engineer changed when a sent-back ticket is finished again, and tells unseen names from a failed test', () => {
  assert.equal(eventLine('ticket.pr_ready', { key: 'PAY-1', fixed: true, files: ['package.json'], more: 0 }), 'PAY-1 is finished again: its engineer changed 1 file: package.json')
  assert.equal(eventLine('ticket.pr_ready', { key: 'PAY-1', fixed: true, files: [], more: 0 }), 'PAY-1 is finished again: its engineer changed no files')
  assert.equal(eventLine('ticket.pr_ready', { key: 'PAY-1', fixed: false }), 'PAY-1 is ready to merge') // a first finish, and a fix of its conflicts, as before
  assert.equal(eventLine('check.ended', { key: 'PAY-1', state: 'fail', unseen: 8 }),
    "HQ's test of PAY-1: the tests passed, but 8 tests named for its criteria weren't seen running (View results on its box)")
  assert.equal(eventLine('check.ended', { key: 'PAY-1', state: 'fail' }), "HQ's test of PAY-1 found a problem (View results on its box)")
})

test('Bug 417: a helper the user stopped says so in plain words, each kind of helper; one that ended by itself, or finished, still says that', () => {
  assert.equal(eventLine('agent.stopped', { reason: 'user' }), 'You stopped it')
  assert.equal(eventLine('agent.stopped', { reason: 'launch helper done' }), 'Stopped: launch helper done')
  assert.equal(eventLine('launch.helper_done', { repo: 'a', state: null, note: null, why: 'user_stopped' }), 'Done with the launch steps: you stopped Claude before it finished')
  assert.equal(eventLine('launch.helper_done', { repo: 'a', state: null, note: null }), 'Done with the launch steps')
  assert.equal(eventLine('testsetup.helper_done', { repo: 'a', state: 'stopped', note: null, by: 'user' }), 'Done with the test setup: you stopped Claude before it finished')
  assert.equal(eventLine('testsetup.helper_done', { repo: 'a', state: 'failed', note: 'Claude stopped before it finished.' }),
    'Done with the test setup, with no setup that works: Claude stopped before it finished.')
  assert.equal(eventLine('teststeps.helper_done', { repo: 'a', state: 'failed', note: 'You stopped Claude before it finished.', by: 'user' }),
    'Done with the test steps: you stopped Claude before it finished')
  assert.equal(eventLine('teststeps.helper_done', { repo: 'a', state: 'saved', note: null }), 'Done with the test steps')
})

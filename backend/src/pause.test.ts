// Bug 195: a paused role held back only the messages for its agents: an engineer already at work went on working, and spending, on a model nobody chose.
// Now the pause stops them (pause.ts): Escape into each terminal that shows a turn at work, and Resume tells those to carry on. A stand-in tmux on PATH
// writes down every call and shows each session's screen from a file, so no real tmux is ever called (as cutshort.test.ts does it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-pause-'))
process.env.HQ_HOME = path.join(root, 'hq'); process.env.TMUX_TMPDIR = root; delete process.env.TMUX
process.env.HQ_PAUSE_SETTLE_MS = '0' // how long HQ leaves the terminal alone after its Escape: nothing here needs it
process.env.HQ_TYPED_LOOK_MS = '20' // how long after typing a line HQ looks whether it was sent
const bin = path.join(root, 'bin'), log = path.join(root, 'tmux.log'), screens = path.join(root, 'screens'); fs.mkdirSync(bin); fs.mkdirSync(screens)
// capture-pane prints screens/<session>.txt; an Escape to a session with screens/<session>.escape shows that one from then on (its turn stops).
// What is typed (send-keys -l) shows in the prompt box, as Claude Code draws a line somebody typed, until Enter sends it; an Enter to a session with
// screens/<session>.swallow is taken for a line break instead, once (the line stays in the box), as the real one did on a busy machine.
fs.writeFileSync(path.join(bin, 'tmux'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), a = process.argv.slice(2), s = a[a.indexOf('-t') + 1], dir = ${JSON.stringify(screens)}
const f = (ext) => path.join(dir, s + ext), has = (ext) => fs.existsSync(f(ext)), rule = '─'.repeat(60)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n')
if (a.includes('capture-pane') && has('.typed')) process.stdout.write('\\x1b[38;5;244m' + rule + '\\n\\x1b[39m❯ ' + fs.readFileSync(f('.typed'), 'utf8') + '\\n\\x1b[38;5;244m' + rule + '\\n\\x1b[39m  ⏵⏵ accept edits on\\n')
else if (a.includes('capture-pane')) { try { process.stdout.write(fs.readFileSync(f('.txt'), 'utf8')) } catch {} }
if (a.includes('Escape')) { try { fs.renameSync(f('.escape'), f('.txt')) } catch {} }
if (a.includes('-l')) fs.appendFileSync(f('.typed'), a.at(-1))
if (a.at(-1) === 'Enter') { if (has('.swallow')) { fs.rmSync(f('.swallow')); fs.appendFileSync(f('.typed'), '\\n') } else fs.rmSync(f('.typed'), { force: true }) }
`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
const { migrate, run, one, q, getSetting, now } = await import('./db.ts'); migrate()
const { pauseRole, resumeRole, stopForPause, stopsUnderWay, heldByPause, pauseRefused, PAUSE_NOTE } = await import('./pause.ts')
const { inTerminal, sendMessage, nextBatchFor, pendingFor, typeNext } = await import('./delivery.ts')
const { getAgent } = await import('./agents.ts')
const { attention, openAttention } = await import('./attention.ts')
const { idleTooLong } = await import('./bgruns.ts')
const { fallbackWords } = await import('./modelguard.ts')
const { socket } = await import('./tmux.ts')

const RULE = '─'.repeat(60)
const IDLE = `⏺ Reading PROJECT.md\n  ⎿  Interrupted · What should Claude do instead?\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ accept edits on (shift+tab to cycle)\n`
const WORKING = `✶ Tempering… (9s · ↓ 1.1k tokens · thinking)\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt\n`
const MENU = `${RULE}\n Bash command\n   rm -rf build\n Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n`

let n = 0
/** An agent whose terminal shows `screen`; after an Escape it shows the waiting prompt. */
function agent(role: string, screen: string, more: Record<string, string | number | null> = {}): { id: string; session: string } {
  const id = `${role}-${++n}`, session = `hq-pause-${n}`
  run(`INSERT INTO agents(id, role, model_alias, tmux_session, cwd, token_hash, status, in_plan_mode, started_at) VALUES (?, ?, 'haiku', ?, ?, 'x', 'working', 0, ?)`,
    id, role, session, root, Date.now())
  for (const [k, v] of Object.entries(more)) run(`UPDATE agents SET ${k} = ? WHERE id = ?`, v, id)
  fs.writeFileSync(path.join(screens, `${session}.txt`), screen); fs.writeFileSync(path.join(screens, `${session}.escape`), IDLE)
  return { id, session }
}
const calls = (session: string): string[][] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []).map((l) => JSON.parse(l) as string[])
  .map((c) => { assert.deepEqual(c.slice(0, 2), ['-S', socket()]); return c.slice(2) }).filter((c) => c[c.indexOf('-t') + 1] === session)
const escapes = (a: { session: string }): number => calls(a.session).filter((c) => c.includes('Escape')).length
const looks = (a: { session: string }): number => calls(a.session).filter((c) => c.includes('capture-pane')).length
const events = (agentId: string, kind: string): number => one<{ c: number }>('SELECT COUNT(*) c FROM events WHERE agent_id = ? AND kind = ?', agentId, kind)!.c
/** Whatever HQ has under way in these agents' terminals is over: the terminal's one-writer line has come round to this. */
const settledTerminals = (...as: { id: string }[]): Promise<unknown> => Promise.all(as.map((a) => inTerminal(a.id, async () => {})))
/** Every stop HQ has under way is over, a request that came during one too. */
async function settled(): Promise<void> { while (stopsUnderWay()) await new Promise((r) => setImmediate(r)) }
const stopped = (a: { id: string }): boolean => !!getAgent(a.id)!.pause_stopped_at
const paused = (): string[] => getSetting<string[]>('paused_roles', [])

test('Bug 195: a pause stops every agent of the role that has a turn at work: Escape in its terminal, once', async () => {
  const one_ = agent('engineer', WORKING), two = agent('engineer', WORKING)
  pauseRole('engineer', 'engineer x: model switched'); await settled()
  assert.deepEqual(paused(), ['engineer'])
  for (const a of [one_, two]) { assert.equal(escapes(a), 1, a.id); assert.ok(stopped(a), a.id); assert.equal(events(a.id, 'agent.pause_stopped'), 1) }
  // paused again (another engineer's switch) and a step of the same turn reported late: its screen waits at the prompt now, so no second Escape
  pauseRole('engineer', 'again'); stopForPause(one_.id, 'step'); await settled()
  assert.equal(escapes(one_), 1); assert.equal(escapes(two), 1); assert.equal(events(one_.id, 'agent.pause_stopped'), 1)
  resumeRole('engineer')
})

test('Bug 195: what the pause must not touch: another role, an idle prompt, a menu or dialog, a plan at the gate, a handoff note being written, an ended agent', async () => {
  const tpm = agent('tpm', WORKING), idle = agent('engineer', IDLE, { status: 'idle' }), menu = agent('engineer', MENU, { status: 'blocked', blocked_why: 'dialog' })
  const unseen = agent('engineer', MENU) // a dialog HQ hasn't heard of yet: its screen says so
  const gate = agent('engineer', WORKING, { status: 'plan_review' }), note = agent('engineer', WORKING, { fresh_start_at: Date.now() })
  const gone = agent('engineer', WORKING, { status: 'exited' }), busy = agent('engineer', WORKING)
  pauseRole('engineer', 'engineer x: model switched'); await settled()
  assert.equal(escapes(busy), 1) // the pause did run
  for (const a of [tpm, idle, menu, unseen, gate, note, gone]) { assert.equal(escapes(a), 0, a.id); assert.equal(stopped(a), false, a.id) }
  assert.deepEqual([tpm, note, gone].map(looks), [0, 0, 0], 'not even looked at')
  assert.deepEqual([tpm, note, gone, idle].map((a) => heldByPause(getAgent(a.id)!)), [false, false, false, true])
  // the dialog is answered and the turn goes on: its next step brings HQ back, and now there is a turn to stop
  fs.writeFileSync(path.join(screens, `${unseen.session}.txt`), WORKING); pauseRefused(getAgent(unseen.id)!); await settled()
  assert.equal(escapes(unseen), 1); assert.ok(stopped(unseen))
  resumeRole('engineer')
})

test('Bug 195: a turn that starts by itself during the pause is stopped as soon as its screen shows it', async () => {
  const a = agent('engineer', IDLE, { status: 'idle' })
  pauseRole('engineer', 'engineer x: model switched'); await settled(); assert.equal(escapes(a), 0)
  // its UserPromptSubmit hook (hooks.ts): a helper's end started a turn. On a screen that never shows one, the looks run out and nothing is sent
  stopForPause(a.id, 'prompt'); await settled(); assert.equal(escapes(a), 0); const before = looks(a); assert.ok(before > 2, 'it looked more than once')
  // asked while a look is under way (the prompt's hook comes just as the pause looks): not dropped. It runs next, and sees the turn once the screen shows it
  stopForPause(a.id, 'pause'); stopForPause(a.id, 'prompt')
  while (looks(a) < before + 2) await new Promise((r) => setImmediate(r)) // the pause's look and the prompt's first: both saw the idle prompt
  fs.writeFileSync(path.join(screens, `${a.session}.txt`), WORKING); await settled()
  assert.equal(escapes(a), 1); assert.ok(stopped(a)); assert.equal(events(a.id, 'agent.pause_stopped'), 1)
  resumeRole('engineer')
})

test('Bug 195: Resume: the agents HQ stopped are told to carry on, once, with the messages that waited; an agent that sat idle is told nothing', async () => {
  const busy = agent('engineer', WORKING), idle = agent('engineer', IDLE, { status: 'idle' })
  const notice = attention('model_fallback', fallbackWords({ id: busy.id, role: 'engineer', display_name: null }, 'claude-haiku-5-5', 'claude-opus-4-8'), { agentId: busy.id })!
  const other = attention('model_fallback', 'tpm t: switched', { agentId: agent('tpm', IDLE).id })! // another role's pause is not this Resume's to answer
  pauseRole('engineer', 'engineer x: model switched'); await settled()
  run('UPDATE agents SET interrupted_at = ?, status = ? WHERE id = ?', now(), 'idle', busy.id) // its mod says the turn was interrupted (delivery.ts turnEnded)
  sendMessage({ channel: 'dm', from: 'user', to: busy.id, reason: 'fyi', body: 'Also add a count.' })
  sendMessage({ channel: 'dm', from: 'user', to: idle.id, reason: 'fyi', body: 'Hello there.' })
  // while paused nothing is handed out, to the mod or typed, and its idle time is the pause's, not a sign it gave up
  for (const a of [busy, idle]) for (const by of ['mod', 'typed'] as const) assert.equal(nextBatchFor(getAgent(a.id)!, by), null, `${a.id} ${by}`)
  const ticket = { status: 'implementing', parked_at: null, auto_parked_why: null } as never, longAgo = Date.now() - 86_400_000
  run('UPDATE agents SET last_event_at = ? WHERE id IN (?, ?)', longAgo, busy.id, idle.id)
  run('UPDATE messages SET delivered_at = 1 WHERE to_id = ?', idle.id) // nothing on its way: only the pause explains its idleness
  assert.equal(idleTooLong(ticket, getAgent(idle.id)), false)
  run('UPDATE messages SET delivered_at = NULL WHERE to_id = ?', idle.id)

  resumeRole('engineer')
  assert.deepEqual(paused(), []); assert.equal(stopped(busy), false)
  assert.deepEqual(openAttention().map((x) => x.id), [other.id], 'the notice that asked for Resume is answered; the TPM one stays')
  assert.ok(notice.detail.includes('Resume'))
  const got = (a: { id: string }) => pendingFor(getAgent(a.id)!).map((m) => [m.from_id, m.reason, m.body.slice(0, 32)])
  assert.deepEqual(got(busy), [['user', 'fyi', 'Also add a count.'], ['hq', 'fyi', 'HQ: the pause is over, carry on.']])
  assert.deepEqual(got(idle), [['user', 'fyi', 'Hello there.']])
  assert.equal(events(busy.id, 'agent.pause_over'), 1); assert.equal(events(idle.id, 'agent.pause_over'), 0)
  // its turn was interrupted, so HQ types them (Bug 110): both in the one line
  const b = nextBatchFor(getAgent(busy.id)!, 'typed')!
  assert.match(b.text, /^HQ message batch B-[0-9a-f]+: \[fyi\] from the user .*Also add a count\. \[fyi\] from HQ .*HQ: the pause is over, carry on\./)
  assert.match(nextBatchFor(getAgent(idle.id)!, 'mod')!.text, /Hello there/) // never interrupted: its mod delivers, as always
  run('UPDATE messages SET delivered_at = 1 WHERE to_id = ?', idle.id) // read, long ago: now its idleness does count again
  assert.equal(idleTooLong(ticket, getAgent(idle.id)), true, 'what must not change: an engineer idle too long with no pause')
  resumeRole('engineer'); assert.equal(q('SELECT 1 FROM messages WHERE to_id = ? AND from_id = ?', busy.id, 'hq').length, 1, 'a second Resume tells it nothing more')
})

test('Bug 195: the refused step tells the agent to stop, and the notice says in plain words what HQ did and what ends it', () => {
  assert.match(PAUSE_NOTE, /^HQ: .*paused.*end your turn now/s)
  const words = fallbackWords({ id: 'eng-1', role: 'engineer', display_name: 'eng PAY-1' }, 'claude-haiku-5-5', 'claude-opus-4-8')
  assert.equal(words, 'eng PAY-1 switched models by itself: claude-haiku-5-5 → claude-opus-4-8. So that nothing runs on a model you didn\'t choose, HQ stopped every '
    + 'engineer at work and holds the messages for engineers. Resume lets them carry on, on the model each is on now.')
  assert.match(fallbackWords({ id: 'tpm-1', role: 'tpm', display_name: null }, 'a', 'b'), /^tpm tpm-1 switched .* stopped every TPM at work and holds the messages for TPMs\./)
})

test("Bug 195: a line HQ typed that Claude Code left in its box (the Enter taken for a line break) gets Enter again; a line that was sent gets none", async () => {
  const enters = (a: { session: string }): number => calls(a.session).filter((c) => c.at(-1) === 'Enter').length
  const typedOut = async (a: { id: string }): Promise<void> => { while (!events(a.id, 'batch.typed')) await new Promise((r) => setImmediate(r)) }
  const stuck = agent('engineer', IDLE, { status: 'idle', interrupted_at: now() }), fine = agent('engineer', IDLE, { status: 'idle', interrupted_at: now() })
  fs.writeFileSync(path.join(screens, `${stuck.session}.swallow`), '')
  for (const a of [stuck, fine]) { sendMessage({ channel: 'dm', from: 'hq', to: a.id, reason: 'fyi', body: `HQ: the pause is over, carry on. ${'And more words. '.repeat(40)}` }); typeNext(a.id) }
  await typedOut(stuck); await typedOut(fine)
  while (!events(stuck.id, 'typed.enter_again') || looks(fine) < 2) await new Promise((r) => setImmediate(r)) // HQ's look a moment after each line
  await settledTerminals(stuck, fine)
  assert.equal(enters(stuck), 2); assert.equal(events(stuck.id, 'typed.enter_again'), 1); assert.equal(fs.existsSync(path.join(screens, `${stuck.session}.typed`)), false, 'sent')
  assert.equal(enters(fine), 1); assert.equal(events(fine.id, 'typed.enter_again'), 0)
})

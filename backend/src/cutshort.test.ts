// Bug 296: interruptAndType marks an urgent message or a fresh start's request delivered, sends Escape, waits 1.5 s and types it, and acks it then.
// A backend restart in that gap left it delivered and never typed: the agent sat idle, and a Clear or fresh start waited 15 minutes for HQ's note.
// typeCutShort (run at start-up) types each such message again. Here the messages are left the way a restart leaves them (delivered, by tmux, not
// acked), and a stand-in tmux on PATH writes down every call and shows each session's screen from a file, so no real tmux is ever called.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-cutshort-'))
process.env.HQ_HOME = path.join(root, 'hq')
const bin = path.join(root, 'bin'), log = path.join(root, 'tmux.log'), screens = path.join(root, 'screens'); fs.mkdirSync(bin); fs.mkdirSync(screens)
// capture-pane prints screens/<session>.txt; an Escape to a session with screens/<session>.escape shows that one from then on (its turn stops)
fs.writeFileSync(path.join(bin, 'tmux'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), a = process.argv.slice(2), s = a[a.indexOf('-t') + 1], dir = ${JSON.stringify(screens)}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n')
if (a.includes('capture-pane')) { try { process.stdout.write(fs.readFileSync(path.join(dir, s + '.txt'), 'utf8')) } catch {} }
if (a.includes('Escape')) { try { fs.renameSync(path.join(dir, s + '.escape'), path.join(dir, s + '.txt')) } catch {} }
`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
const { migrate, run, one } = await import('./db.ts'); migrate()
const { typeCutShort, sendMessage, nextBatchFor } = await import('./delivery.ts')
const { getAgent } = await import('./agents.ts')
const { socket } = await import('./tmux.ts')

const RULE = '─'.repeat(60)
/** Claude Code's waiting prompt after Escape stopped a turn (2.1.322), and a turn at work. */
const IDLE = `⏺ Reading PROJECT.md\n  ⎿  Interrupted · What should Claude do instead?\n\n${RULE}\n❯ \n${RULE}\n  ⏸ manual mode on · ? for shortcuts\n`
const WORKING = `✶ Tempering… (9s · ↓ 1.1k tokens · thinking)\n\n${RULE}\n❯ \n${RULE}\n  ⏸ manual mode on · esc to interrupt\n`
/** A line somebody typed and didn't send, as tmux capture -e shows it (Bug 149). */
const DRAFT = `\x1b[38;5;244m${RULE}\n\x1b[39m❯ half-typed words of mine\n\x1b[38;5;244m${RULE}\n\x1b[39m  ⏸ manual mode on\n`

let n = 0
/** An agent whose terminal shows `screen`, with one message HQ was typing when the backend went down. */
function cutShort(o: { screen: string; status?: string; reason?: 'urgent' | 'fresh_start'; ago?: number; freshStartOver?: boolean; acked?: boolean; long?: boolean }) {
  const id = `tpm-${++n}`, session = `hq-cutshort-${n}`
  run(`INSERT INTO agents(id, role, model_alias, tmux_session, cwd, token_hash, status, in_plan_mode, started_at) VALUES (?, 'tpm', 'haiku', ?, ?, 'x', ?, 0, ?)`,
    id, session, root, o.status ?? 'working', Date.now())
  fs.writeFileSync(path.join(screens, `${session}.txt`), o.screen)
  const reason = o.reason ?? 'urgent', more = o.long ? ` ${'And then the next thing, with its own words. '.repeat(14)}` : ''
  const body = `${reason === 'fresh_start' ? 'Fresh start: write your note' : 'Stop and look at this'} (${id}).${more}`.trim()
  const m = sendMessage({ channel: 'dm', from: reason === 'urgent' ? 'user' : 'hq', to: id, reason, body })
  const at = Date.now() - (o.ago ?? 2000)
  run("UPDATE messages SET delivered_at = ?, delivery_method = 'tmux', ack_at = ? WHERE id = ?", at, o.acked ? at : null, m.id)
  if (reason === 'fresh_start') run('UPDATE agents SET fresh_start_at = ?, fresh_start_then = ?, fresh_start_msg = ? WHERE id = ?', at, 'clear', o.freshStartOver ? 'M-other' : m.id, id)
  return { id, session, m, line: reason === 'urgent' ? body : `[fresh_start] from HQ: ${body}` } // the line it is typed as: HQ's own is labelled
}
/** The calls to `session`, without the socket each names first (Bug 242). */
const callsTo = (session: string): string[][] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []).map((l) => JSON.parse(l) as string[])
  .map((c) => { assert.deepEqual(c.slice(0, 2), ['-S', socket()]); return c.slice(2) }).filter((c) => c[c.indexOf('-t') + 1] === session)
const keysTo = (session: string): string[][] => callsTo(session).filter((c) => c[0] === 'send-keys')
const typedTo = (session: string): string => keysTo(session).filter((c) => c.includes('-l')).map((c) => c.at(-1)).join('')
const msg = (id: string) => one<{ delivered_at: number | null; delivery_method: string | null; ack_at: number | null }>('SELECT * FROM messages WHERE id = ?', id)!
const events = (agentId: string, kind: string) => one<{ c: number }>('SELECT COUNT(*) c FROM events WHERE agent_id = ? AND kind = ?', agentId, kind)!.c
const lastPayload = (agentId: string, kind: string) =>
  JSON.parse(one<{ payload: string }>('SELECT payload FROM events WHERE agent_id = ? AND kind = ? ORDER BY id DESC LIMIT 1', agentId, kind)!.payload)

test('Bug 296: a restart after the Escape (the agent waits at its prompt): the request is typed at once, with no second Escape, and acked', async () => {
  const a = cutShort({ screen: IDLE, status: 'idle', reason: 'fresh_start' })
  await typeCutShort()
  assert.deepEqual(keysTo(a.session).filter((c) => c.includes('Escape')), [], 'no second Escape: twice opens the Rewind menu')
  assert.equal(typedTo(a.session), a.line); assert.deepEqual(keysTo(a.session).at(-1), ['send-keys', '-t', a.session, 'Enter'])
  assert.ok(msg(a.m.id).ack_at, 'acked: the fresh start counts from here, not 15 minutes on')
  assert.deepEqual(lastPayload(a.id, 'message.typed'), { id: a.m.id, reason: 'fresh_start', again: true })
  assert.equal(events(a.id, 'message.cut_short'), 1)
})

test('Bug 296: a restart before the Escape got there (its turn still runs): Escape first, then the message once the prompt waits', async () => {
  const a = cutShort({ screen: WORKING })
  fs.writeFileSync(path.join(screens, `${a.session}.escape`), IDLE)
  await typeCutShort()
  const keys = keysTo(a.session)
  assert.deepEqual(keys[0], ['send-keys', '-t', a.session, 'Escape'])
  assert.equal(typedTo(a.session), a.line); assert.ok(msg(a.m.id).ack_at)
})

test('Bug 296: a screen HQ must not type into after the restart: the message goes back in the queue, for the mod or typeNext', async () => {
  const draft = cutShort({ screen: DRAFT, status: 'idle' })
  const stuck = cutShort({ screen: WORKING }) // the Escape changes nothing on its screen: never typed into a turn at work
  const dialog = cutShort({ screen: IDLE, status: 'paused', reason: 'fresh_start' }) // HQ knows of a dialog: Enter would pick an option
  await typeCutShort()
  for (const [a, why] of [[draft, 'draft'], [stuck, 'screen'], [dialog, 'status']] as const) {
    assert.equal(typedTo(a.session), '', `nothing typed (${why})`)
    assert.deepEqual([msg(a.m.id).delivered_at, msg(a.m.id).delivery_method, msg(a.m.id).ack_at], [null, null, null], `back in the queue (${why})`)
    assert.deepEqual(lastPayload(a.id, 'message.held'), { id: a.m.id, why })
  }
  assert.equal(keysTo(dialog.session).length, 0, 'not even an Escape into a dialog')
})

test('Bug 296: what is not typed again: acked, an over fresh start, an agent that ended, one older than a fresh start waits for its request', async () => {
  const acked = cutShort({ screen: IDLE, acked: true })
  const over = cutShort({ screen: IDLE, reason: 'fresh_start', freshStartOver: true })
  const ended = cutShort({ screen: IDLE, status: 'exited' })
  const old = cutShort({ screen: IDLE, ago: 16 * 60_000 })
  const batch = cutShort({ screen: IDLE }) // a typed batch (Bug 110) has a batch of its own, which requeue handles
  run("INSERT INTO batches(id, agent_id, text, created_at, handed_at, method) VALUES ('B-cut', ?, 'x', 1, 1, 'typed')", batch.id)
  run("UPDATE messages SET batch_id = 'B-cut' WHERE id = ?", batch.m.id)
  await typeCutShort()
  for (const a of [acked, over, ended, old, batch]) {
    assert.deepEqual(callsTo(a.session), [], `${a.id}: its terminal untouched`)
    assert.equal(msg(a.m.id).delivery_method, 'tmux'); assert.equal(events(a.id, 'message.cut_short'), 0)
  }
  // and the ones typed above aren't typed a second time by a later start
  const before = fs.readFileSync(log, 'utf8'); await typeCutShort(); assert.equal(fs.readFileSync(log, 'utf8'), before)
})

// ---- Bug 331: the restart came in the middle of typeLine, whose 250-character pieces each go in whole: the first ones sit in the box ----
/** The waiting prompt with `typed` in its box, as tmux capture -e shows text somebody typed (wrapped at 100 columns, as Claude Code does). */
function boxWith(typed: string): string {
  const lines: string[] = []; let line = ''
  for (const w of typed.split(' ')) { if (line && (line + ' ' + w).length > 100) { lines.push(line); line = w } else line = line ? `${line} ${w}` : w }
  lines.push(line)
  return `\x1b[39m⏺ Reading PROJECT.md\n  ⎿  Interrupted · What should Claude do instead?\n\n\x1b[38;5;244m${RULE}\n\x1b[39m❯ ${lines.join('\n  ')}\n`
    + `\x1b[38;5;244m${RULE}\n\x1b[39m  ⏸ manual mode on\n`
}
/** HQ's half line of `a`: its first `n` pieces. */
const firstPieces = (line: string, n: number): string => line.slice(0, 250 * n)
const show = (session: string, screen: string): void => fs.writeFileSync(path.join(screens, `${session}.txt`), screen)

test("Bug 331: HQ's own first pieces of the line in the box after the restart: HQ types the rest and Enter, never the line again, and acks it", async () => {
  const a = cutShort({ screen: IDLE, status: 'idle', long: true }), b = cutShort({ screen: IDLE, status: 'idle', reason: 'fresh_start', long: true })
  assert.ok(a.line.length > 600 && b.line.length > 600)
  show(a.session, boxWith(firstPieces(a.line, 2))); show(b.session, boxWith(firstPieces(b.line, 1)))
  const whole = cutShort({ screen: IDLE, status: 'idle', long: true }); show(whole.session, boxWith(whole.line)) // all in: only Enter was missing
  await typeCutShort()
  assert.equal(typedTo(a.session), a.line.slice(500)); assert.equal(typedTo(b.session), b.line.slice(250))
  assert.equal(typedTo(whole.session), '')
  for (const x of [a, b, whole]) {
    assert.deepEqual(keysTo(x.session).at(-1), ['send-keys', '-t', x.session, 'Enter']); assert.deepEqual(keysTo(x.session).filter((c) => c.includes('Escape')), [])
    assert.ok(msg(x.m.id).ack_at, `${x.id} acked`); assert.equal(lastPayload(x.id, 'message.typed').finished, true); assert.equal(events(x.id, 'message.held'), 0)
  }
})

test("Bug 331: what is not HQ's own half line stays in the box untouched, and the message is held as before", async () => {
  const mine = cutShort({ screen: IDLE, status: 'idle', long: true }), short = cutShort({ screen: IDLE, status: 'idle', long: true })
  const other = cutShort({ screen: IDLE, status: 'idle', long: true }), busy = cutShort({ screen: IDLE, status: 'working', long: true })
  show(mine.session, boxWith(`${firstPieces(mine.line, 1)} and words of my own`)) // somebody typed after HQ's piece
  show(short.session, boxWith(short.line.slice(0, 200))) // not whole pieces: not what typeLine leaves
  show(other.session, boxWith(firstPieces(mine.line, 1))) // another message's start
  show(busy.session, boxWith(firstPieces(busy.line, 1)).replace('\x1b[39m❯', '\x1b[38;5;244m❯\x1b[39m')) // a turn runs (Bug 189's grey ❯)
  await typeCutShort()
  for (const x of [mine, short, other, busy]) {
    assert.deepEqual(keysTo(x.session).filter((c) => c.includes('-l') || c.includes('Enter')), [], `${x.id}: nothing typed`)
    assert.deepEqual(lastPayload(x.id, 'message.held'), { id: x.m.id, why: 'draft' }); assert.equal(msg(x.m.id).delivered_at, null)
  }
})

/** An agent HQ was typing a batch into (typeNext, Bug 110) when the backend went down: handed out and taken as received, never submitted. */
function cutBatch(screen: (text: string) => string) {
  const a = cutShort({ screen: IDLE, status: 'idle', acked: true }), m = sendMessage({ channel: 'dm', from: 'user', to: a.id, reason: 'fyi', body: 'x' })
  const text = `HQ message batch B-cut${n}: [fyi] from the user [msg ${m.id}]: ${'Please look at the list page and the add form. '.repeat(12)}`.trim()
  const t = Date.now() - 2000
  run("INSERT INTO batches(id, agent_id, text, created_at, handed_at, received_at, method) VALUES (?, ?, ?, ?, ?, ?, 'typed')", `B-cut${n}`, a.id, text, t, t, t)
  run("UPDATE messages SET batch_id = ?, delivered_at = ?, delivery_method = 'tmux' WHERE id = ?", `B-cut${n}`, t, m.id)
  run('UPDATE agents SET interrupted_at = ? WHERE id = ?', t, a.id); show(a.session, screen(text))
  return { ...a, m, b: `B-cut${n}`, text }
}
const batch = (id: string) => one<{ submitted_at: number | null; dropped_at: number | null }>('SELECT * FROM batches WHERE id = ?', id)!

test('Bug 331: a batch HQ was typing: the rest of its own half line is typed, and one it can\'t finish comes back to be typed again, not lost', async () => {
  const half = cutBatch((text) => boxWith(firstPieces(text, 1))), empty = cutBatch(() => IDLE), mine = cutBatch(() => DRAFT)
  await typeCutShort()
  assert.equal(typedTo(half.session), half.text.slice(250)); assert.deepEqual(keysTo(half.session).at(-1), ['send-keys', '-t', half.session, 'Enter'])
  assert.deepEqual(lastPayload(half.id, 'batch.cut_short'), { id: half.b, finished: true })
  for (const x of [empty, mine]) { assert.equal(typedTo(x.session), ''); assert.deepEqual(lastPayload(x.id, 'batch.cut_short'), { id: x.b, finished: false }) }
  for (const x of [half, empty, mine]) assert.ok(batch(x.b).submitted_at, `${x.b} counts as submitted: its ack, or the not-acked rule, ends it`)
  // with no prompt from it (no ack), its message goes back in the queue at the not-acked rule, to be typed again (Bug 110), not kept for good
  const later = Date.now() + 91_000
  nextBatchFor(getAgent(empty.id)!, 'mod', later)
  assert.ok(batch(empty.b).dropped_at); assert.equal(msg(empty.m.id).delivered_at, null)
})

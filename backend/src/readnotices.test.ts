// Bug 117: auto mode's look at the open notices (auto.ts readNotices) takes them all at once, then waits on tmux for each dialog. A
// notice replaced during one of those waits (a new dialog takes the old one's place) must not be acted on with its old words.
// Real SQLite in a temp HQ_HOME; Claude Code's session files in a temp HOME; a stand-in tmux on PATH, so no real tmux is ever called.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-readnotices-'))
process.env.HQ_HOME = path.join(root, 'hq'); process.env.HOME = path.join(root, 'home')
const bin = path.join(root, 'bin'); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }) // an empty screen
process.env.PATH = `${bin}:${process.env.PATH}`
const sessions = path.join(process.env.HOME, '.claude', 'sessions'); fs.mkdirSync(sessions, { recursive: true })
const { migrate, run, q, one } = await import('./db.ts'); migrate()
const { attention, openAttention } = await import('./attention.ts')
const { readNotices } = await import('./auto.ts')
const { getRepo } = await import('./records.ts')

const now = Date.now()
run("INSERT INTO repos(id, name, path, kind, created_at) VALUES ('r1', 'demo', ?, 'local', ?)", root, now)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('f1', 'r1', 'list', 'List', 'x', 'planning', ?, ?)", now, now)
for (const n of [1, 2]) {
  run(`INSERT INTO tickets(id, feature_id, key, slug, title, status, assignee_agent_id, go_ahead, created_at, updated_at)
    VALUES (?, 'f1', ?, ?, 'x', 'implementing', ?, 1, ?, ?)`, `t${n}`, `T${n}`, `t${n}`, `eng-${n}`, now, now)
  run(`INSERT INTO agents(id, role, repo_id, feature_id, ticket_id, model_alias, claude_session_id, token_hash, status, tmux_session, started_at)
    VALUES (?, 'engineer', 'r1', 'f1', ?, 'sonnet', ?, ?, 'blocked', ?, ?)`, `eng-${n}`, `t${n}`, `s${n}`, `eng-${n}`, `hq-readnotices-none-${n}`, now)
}
const session = (n: number, status: string, at: number) =>
  fs.writeFileSync(path.join(sessions, `${n}.json`), JSON.stringify({ sessionId: `s${n}`, status, statusUpdatedAt: at }))
const ask = (n: number, words: string, at: number) => {
  const a = attention('dialog', `eng-${n}: ${words}`, { agentId: `eng-${n}`, ticketId: `t${n}` })!
  run('UPDATE needs_attention SET created_at = ? WHERE id = ?', at, a.id); return a
}
const parked = (t: string) => one<{ auto_parked_why: string | null }>('SELECT auto_parked_why FROM tickets WHERE id = ?', t)!.auto_parked_why
const look = () => readNotices(getRepo('r1')!, q('SELECT * FROM tickets'))

test('Bug 117: a dialog notice replaced while HQ looks at another one is left alone; the next look parks with the new words', async () => {
  // eng-1 answered its first dialog; eng-2 answered its own later on. The look reads eng-2's (the newer) first, and waits on its screen.
  ask(1, 'Allow this?', now - 3000); session(1, 'busy', now - 2500)
  ask(2, 'Allow that?', now - 2000); session(2, 'busy', now - 1500)
  const looking = look()
  // While the look waits on eng-2's screen, eng-1 opens a new dialog: its hook replaces the old notice, its session file says waiting.
  const fresh = ask(1, 'May I run rm?', now - 1000); session(1, 'waiting', now - 1000)
  await looking
  assert.equal(parked('t1'), null, 'not parked on the old dialog\'s words')
  assert.deepEqual(openAttention().filter((a) => a.kind === 'dialog').map((a) => a.id).sort(), [fresh.id, openAttention().find((a) => a.agent_id === 'eng-2')!.id].sort())
  await look() // the next look: the dialog that is open now parks its ticket, with its words; the answered one still doesn't
  assert.match(parked('t1') ?? '', /May I run rm\?/); assert.equal(parked('t2'), null)
})

test('a ticket parked by one notice in a look has its other notices of that look resolved, as before; it parks once, with the first words', async () => {
  run("INSERT INTO tickets(id, feature_id, key, slug, title, status, go_ahead, created_at, updated_at) VALUES ('t3', 'f1', 'T3', 't3', 'x', 'implementing', 1, ?, ?)", now, now)
  run(`INSERT INTO agents(id, role, repo_id, feature_id, ticket_id, model_alias, claude_session_id, token_hash, status, tmux_session, started_at)
    VALUES ('eng-3', 'engineer', 'r1', 'f1', 't3', 'sonnet', 's3', 'eng-3', 'blocked', 'hq-readnotices-none-3', ?)`, now)
  run("UPDATE tickets SET assignee_agent_id = 'eng-3' WHERE id = 't3'")
  const blocked = attention('blocked', 'eng-3: needs an API key', { agentId: 'eng-3', ticketId: 't3' })!
  run('UPDATE needs_attention SET created_at = ? WHERE id = ?', now - 500, blocked.id)
  ask(3, 'Allow this?', now - 100); session(3, 'waiting', now - 100) // newer: read first, parks t3
  await look()
  assert.match(parked('t3') ?? '', /Allow this\?/)
  assert.deepEqual(openAttention().filter((a) => a.ticket_id === 't3').map((a) => a.kind), ['auto_parked'], 'the blocked notice went with the park')
})

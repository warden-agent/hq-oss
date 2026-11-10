// A terminal message from the page. A throw here used to reach ws's receiver, which then never read that socket again: every later
// message from the tab was lost while its patches still arrived, so the page looked fine (Bug 60).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-termws-'))
process.env.HQ_HOME = path.join(tmp, 'hq')
const { migrate, q } = await import('./db.ts'); migrate()
const { termMessage } = await import('./termws.ts')
type Term = import('./terminal.ts').Term

const fake = (log: string[] = []): Term => ({ write: (d) => { log.push(`write ${d}`) }, resize: (c, r) => { log.push(`resize ${c}x${r}`) }, kill: () => { log.push('kill') } })
const said = (sent: unknown[]) => (sent as { data: string }[]).map((m) => m.data).join('')

test('Bug 60: a terminal that can\'t open says so in its view, and nothing escapes to stall the socket', () => {
  const sent: unknown[] = [], terms = new Map<string, Term>()
  const open = () => { throw new Error('posix_spawnp failed.') }
  assert.doesNotThrow(() => termMessage({ type: 'term.open', agentId: 'a1', cols: 80, rows: 24 }, terms, (m) => sent.push(m), open))
  assert.deepEqual((sent[0] as { type: string; agentId: string }).type, 'term'); assert.equal((sent[0] as { agentId: string }).agentId, 'a1')
  assert.match(said(sent), /couldn't open this terminal: posix_spawnp failed/)
  assert.equal(terms.size, 0)
  assert.ok(q<{ payload: string }>("SELECT payload FROM events WHERE kind = 'backend.error'").some((e) => e.payload.includes('posix_spawnp')))
})

test('an agent HQ doesn\'t know says so too, rather than staying blank', () => {
  const sent: unknown[] = []
  termMessage({ type: 'term.open', agentId: 'gone', cols: 80, rows: 24 }, new Map(), (m) => sent.push(m), () => null)
  assert.match(said(sent), /couldn't open this terminal/)
})

test('a working terminal gets its input, size and close; a reopen replaces it, and the old one\'s late exit leaves the new one alone', () => {
  const log: string[] = [], terms = new Map<string, Term>(), sent: unknown[] = [], exits: (() => void)[] = []
  const open = (_id: string, _c: number, _r: number, _d: (s: string) => void, onExit: () => void) => { exits.push(onExit); return fake(log) }
  const msg = (m: Record<string, unknown>) => termMessage({ agentId: 'a1', ...m }, terms, (x) => sent.push(x), open)
  msg({ type: 'term.open', cols: 80, rows: 24 }); const first = terms.get('a1')
  msg({ type: 'term.input', data: 'hi', typed: true }); msg({ type: 'term.resize', cols: 100, rows: 30 })
  msg({ type: 'term.open', cols: 80, rows: 24 }); assert.notEqual(terms.get('a1'), first)
  exits[0]!(); assert.ok(terms.has('a1'))
  msg({ type: 'term.close' }); assert.equal(terms.has('a1'), false)
  assert.deepEqual(log, ['write hi', 'resize 100x30', 'kill', 'kill'])
})

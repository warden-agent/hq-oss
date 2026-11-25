// Bug 338 end to end (see harness.ts): ⟳ Fresh start the TPM, then Clear the project before its note is in. The Clear only changed
// `fresh_start_then`, so the terminal still held the Fresh start request and the TPM wrote the in-flight headings, not the Clear's. Now
// HQ types a request in the Clear's words that replaces the first one, and the clear ends with the note as before.
// The stand-in Claude Code doesn't read what is typed, so its terminal takes only about 1 KB of it: here `tmux` is a stand-in that writes
// down, per session, every send-keys HQ makes (the text, then "<Escape>" or "<Enter>"), and passes it on to the real tmux.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-b338-tmux-')), keys = path.join(bin, 'keys')
before(async () => {
  const real = process.env.PATH!.split(':').map((d) => path.join(d, 'tmux')).find((p) => fs.existsSync(p)); assert.ok(real, 'tmux is installed')
  fs.mkdirSync(keys)
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
keys=; name=; prev=; last=
for a in "$@"; do
  case "$a" in send-keys) keys=1;; esac
  if [ "$prev" = -t ]; then name="$a"; fi
  prev="$a"; last="$a"
done
if [ -n "$keys" ]; then case "$last" in Escape) printf '<Escape>' ;; Enter) printf '<Enter>\n' ;; *) printf '%s' "$last" ;; esac >> '${keys}'/"$name"; fi
exec '${real}' "$@"
`, { mode: 0o755 })
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}` } }); await hq.api('settings', { key: 'concurrency_cap', value: 20 })
})
after(async () => { await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })

/** What HQ typed into the agent's terminal, in order. */
const pane = (a: any): string => { try { return fs.readFileSync(path.join(keys, a.tmux_session), 'utf8') } catch { return '' } }
const agent = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
const CLEAR_HEADING = '## What the user wants from this project (in their words)'

test('Bug 338: a Clear during an open Fresh start types the Clear\'s request into the TPM\'s terminal, and the clear ends with its note', async () => {
  const repo = (await hq.api('repos', { path: hq.repo('b338clear') })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'b338clear', request: 'Build b338clear' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))

  assert.equal((await hq.api(`agents/${tpm.id}/fresh-start`, { then: 'continue' })).status, 200)
  await waitFor('the Fresh start request in its terminal', () => pane(tpm).includes('## In flight'), 15_000)
  assert.ok(pane(tpm).includes('Fresh start: this session is ending')); assert.ok(!pane(tpm).includes(CLEAR_HEADING))

  const r = await hq.api(`repos/${repo.id}/clear`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.noting, [tpm.display_name])
  await waitFor('the Clear\'s request in its terminal', () => pane(tpm).includes(CLEAR_HEADING), 15_000)
  const after = pane(tpm), at = after.lastIndexOf('This replaces HQ\'s earlier request for your handoff note')
  assert.ok(at > after.lastIndexOf('## In flight'), 'the replacing request comes after the first one')
  assert.ok(after.slice(at).includes("The user is clearing this project's board from HQ"))
  assert.match(after.slice(after.lastIndexOf('<Enter>', at)), /^<Enter>\n<Escape>\[fresh_start\] from HQ: This replaces/, 'an Escape first, as for the first request')
  assert.ok(!after.slice(at).includes('## In flight') && !after.slice(at).includes('Fresh start:'))

  const a = await agent(tpm.id); assert.equal(a.fresh_start_then, 'clear')
  const asks = (await hq.state()).messages.filter((m: any) => m.to_id === tpm.id && m.reason === 'fresh_start')
  assert.equal(asks.length, 2); assert.equal(a.fresh_start_msg, asks.find((m: any) => /^This replaces/.test(m.body)).id)
  await waitFor('the new request acked', async () => (await hq.state()).messages.find((m: any) => m.id === a.fresh_start_msg)?.ack_at)
  const lines = (await hq.api(`agents/${tpm.id}/events`)).json
  assert.deepEqual(lines.events.map((l: any) => l.text).filter((t: string) => t.startsWith('Asked again')), // once: typed whole (Bug 368)
    ['Asked again for its handoff note: you are clearing the project. A new TPM takes over from it after the clear'])

  assert.equal((await hq.mcp(tpm.id, 'write_handoff_note', { text: '## What the user wants from this project\n- b338 (B338-NOTE)' })).isError, false)
  await waitFor('the board gone', async () => !(await hq.state()).features.some((x: any) => x.repo_id === repo.id), 30_000)
  assert.equal((await hq.state()).repos.find((x: any) => x.id === repo.id).clearing_at, null)
})

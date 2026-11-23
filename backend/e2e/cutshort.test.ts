// Bug 296 end to end (see harness.ts): an urgent message or a fresh start's request is marked delivered, then HQ sends Escape, waits 1.5 s and
// types it, and only then acks it. A backend restart in that gap left it delivered and never typed: the agent sat idle, and a Clear waited 15
// minutes for HQ's own note. The stand-in Claude Code writes a note whenever a test tells it to, so only the terminal shows whether the request
// got there. Here `tmux` is a stand-in that holds the send-keys HQ types into one agent while a flag file is there, so the backend goes down
// exactly inside that gap: after the Escape went in (`after.`), or before it did (`before.`: that call is dropped with the old backend).
// Bug 331: or in the middle of typing the line (`midline.`: held after its first piece went in).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-b296-tmux-')), flags = path.join(bin, 'flags')
before(async () => {
  const real = process.env.PATH!.split(':').map((d) => path.join(d, 'tmux')).find((p) => fs.existsSync(p)); assert.ok(real, 'tmux is installed')
  fs.mkdirSync(flags)
  // For send-keys to <session>: `before.<session>` holds it while the file is there and then drops it (its backend is gone); `after.<session>`
  // runs it and then holds. Each waits with `held.<session>` written. Every Escape that went in adds a line to `escapes.<session>`, and one
  // to a session with `onescape.<session>` shows that screen from then on (its turn stopped): `sid.<session>` names the screen's file.
  // Bug 331: each piece typed (`-l`) goes in `typed.<session>`, one per line; with `midline.<session>` there, the first one holds after it went in.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
keys=; esc=; name=; prev=
for a in "$@"; do
  case "$a" in send-keys) keys=1;; Escape) esc=1;; esac
  if [ "$prev" = -t ]; then name="$a"; fi
  prev="$a"
done
f='${flags}'
if [ -n "$keys" ] && [ -e "$f/before.$name" ]; then : > "$f/held.$name"; while [ -e "$f/before.$name" ]; do sleep 0.05; done; exit 0; fi
'${real}' "$@"; code=$?
if [ -n "$keys" ] && [ -n "$esc" ]; then echo Escape >> "$f/escapes.$name"
  if [ -e "$f/onescape.$name" ]; then mv "$f/onescape.$name" "$HQ_FAKE_SCREEN_DIR/$(cat "$f/sid.$name").txt"; fi; fi
if [ -n "$keys" ] && [ -e "$f/after.$name" ]; then : > "$f/held.$name"; while [ -e "$f/after.$name" ]; do sleep 0.05; done; fi
case " $* " in *" -l -- "*) for a in "$@"; do last="$a"; done; printf '%s\n' "$last" >> "$f/typed.$name"
  if [ -e "$f/midline.$name" ]; then : > "$f/held.$name"; while [ -e "$f/midline.$name" ]; do sleep 0.05; done; fi;; esac
exit $code
`, { mode: 0o755 })
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}` } })
  await hq.api('settings', { key: 'concurrency_cap', value: 20 })
})
after(async () => { fs.rmSync(flags, { recursive: true, force: true }); await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })

const RULE = '─'.repeat(60)
/** Claude Code's waiting prompt after Escape stopped a turn (2.1.322), and a turn at work. */
const IDLE = `⏺ Reading PROJECT.md\n  ⎿  Interrupted · What should Claude do instead?\n\n${RULE} TPM demo ─\n❯ \n${RULE}\n  ⏸ manual mode on · ? for shortcuts\n`
const WORKING = `✶ Tempering… (9s · ↓ 1.1k tokens · thinking)\n\n${RULE} TPM demo ─\n❯ \n${RULE}\n  ⏸ manual mode on · esc to interrupt\n`
const pane = (a: any): string => hq.tmux('capture-pane', '-p', '-J', '-t', a.tmux_session).replace(/\n/g, '')
const escapes = (a: any): number => { try { return fs.readFileSync(path.join(flags, `escapes.${a.tmux_session}`), 'utf8').trim().split('\n').length } catch { return 0 } }
async function draw(a: any, text: string, shows: string): Promise<void> { await hq.screen(a, text); await waitFor(`the screen to show "${shows}"`, () => pane(a).includes(shows)) }
const msgTo = async (a: any, reason: string) => (await hq.state()).messages.find((m: any) => m.to_id === a.id && m.reason === reason)
const typedAgain = async (a: any) => (await hq.api(`events?agent=${a.id}`)).json.filter((e: any) => e.kind === 'message.typed').map((e: any) => JSON.parse(e.payload))

async function tpmOf(name: string): Promise<{ repo: any; f: any; tpm: any }> {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const b = (await hq.modNext(tpm.id)).batch; await hq.modEvent(tpm.id, { kind: 'batch_received', id: b.id })
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: b.text }) // at work on its launch prompt
  fs.writeFileSync(path.join(flags, `sid.${tpm.tmux_session}`), tpm.claude_session_id)
  await draw(tpm, WORKING, 'esc to interrupt')
  return { repo, f, tpm }
}

test('Bug 296: a restart after the Clear\'s Escape and before its note request was typed: the request is typed after the restart, and the clear ends', async () => {
  const { repo, tpm } = await tpmOf('b296clear')
  const flag = path.join(flags, `after.${tpm.tmux_session}`), held = path.join(flags, `held.${tpm.tmux_session}`)
  fs.writeFileSync(flag, '')
  try {
    void hq.api(`repos/${repo.id}/clear`, {}).catch(() => null) // it never answers: the backend goes down under it
    await waitFor('the Escape in the TPM\'s terminal', () => fs.existsSync(held), 15_000)
    assert.equal(escapes(tpm), 1)
    await draw(tpm, IDLE, 'Interrupted') // its turn stopped: it waits at its prompt
    const m = await msgTo(tpm, 'fresh_start'); assert.ok(m.delivered_at); assert.equal(m.ack_at, null) // what a restart now leaves behind
    await hq.down()
  } finally { fs.rmSync(flag, { force: true }) }
  await hq.up()

  await waitFor('the request in the TPM\'s terminal', () => pane(tpm).includes('Call write_handoff_note once'), 15_000)
  await waitFor('the request acked', async () => (await msgTo(tpm, 'fresh_start')).ack_at)
  assert.deepEqual((await typedAgain(tpm)).map((p: any) => [p.reason, p.again ?? false]), [['fresh_start', true]])
  assert.equal(escapes(tpm), 1, 'no second Escape into a waiting prompt (twice opens the Rewind menu)')
  // the TPM answers what it now sees, and the clear ends with its note
  assert.equal((await hq.mcp(tpm.id, 'write_handoff_note', { text: '## What the user wants\n- b296 (CUT-NOTE)' })).isError, false)
  await waitFor('the board gone', async () => !(await hq.state()).features.some((x: any) => x.repo_id === repo.id), 30_000)
  assert.equal((await hq.state()).repos.find((x: any) => x.id === repo.id).clearing_at, null)
})

test('Bug 296: a restart before an urgent message\'s Escape got there: after the restart HQ stops the turn, then types the message', async () => {
  const { tpm } = await tpmOf('b296urgent')
  fs.writeFileSync(path.join(flags, `onescape.${tpm.tmux_session}`), IDLE) // an Escape stops its turn
  const flag = path.join(flags, `before.${tpm.tmux_session}`), held = path.join(flags, `held.${tpm.tmux_session}`)
  fs.rmSync(held, { force: true }); fs.writeFileSync(flag, '')
  try {
    void hq.api(`agents/${tpm.id}/message`, { body: 'Stop: b296 urgent words.', urgent: true }).catch(() => null)
    await waitFor('HQ to reach the TPM\'s terminal', () => fs.existsSync(held), 15_000)
    assert.equal(escapes(tpm), 0); assert.ok((await msgTo(tpm, 'urgent')).delivered_at)
    await hq.down()
  } finally { fs.rmSync(flag, { force: true }) } // the old backend's Escape is dropped: it never gets there
  await hq.up()

  await waitFor('the message in the TPM\'s terminal', () => pane(tpm).includes('Stop: b296 urgent words.'), 15_000)
  assert.equal(escapes(tpm), 1, 'one Escape, from the new backend, before the line')
  await waitFor('the message acked', async () => (await msgTo(tpm, 'urgent')).ack_at)
  assert.deepEqual((await typedAgain(tpm)).map((p: any) => [p.reason, p.again ?? false]), [['urgent', true]])
})

test("Bug 331: a restart in the middle of typing an urgent message: HQ types the rest after its own first piece, and the message goes in whole", async () => {
  const { tpm } = await tpmOf('b331half')
  fs.writeFileSync(path.join(flags, `onescape.${tpm.tmux_session}`), IDLE) // the first backend's Escape stops its turn
  const flag = path.join(flags, `midline.${tpm.tmux_session}`), held = path.join(flags, `held.${tpm.tmux_session}`), typed = path.join(flags, `typed.${tpm.tmux_session}`)
  const body = `Stop: b331 urgent words. ${'Move the button to the right of Undo, and keep the list as it is. '.repeat(6)}`.trim()
  fs.rmSync(held, { force: true }); fs.writeFileSync(flag, '')
  try {
    void hq.api(`agents/${tpm.id}/message`, { body, urgent: true }).catch(() => null)
    await waitFor('HQ\'s first piece in the TPM\'s box', () => fs.existsSync(held), 15_000)
    assert.equal(fs.readFileSync(typed, 'utf8'), `${body.slice(0, 250)}\n`)
    // what Claude Code shows then: the first piece in its box (typed text in the terminal's own colour)
    await draw(tpm, `${IDLE.split(RULE)[0]}\x1b[38;5;244m${RULE}\n\x1b[39m❯ ${body.slice(0, 250)}\n\x1b[38;5;244m${RULE}\n\x1b[39m  ⏸ manual mode on\n`, '❯ Stop: b331')
    await hq.down()
  } finally { fs.rmSync(flag, { force: true }) }
  await hq.up()

  await waitFor('the message acked', async () => (await msgTo(tpm, 'urgent')).ack_at, 15_000)
  assert.equal(fs.readFileSync(typed, 'utf8').split('\n').join(''), body, 'the first piece, then only the rest: the line once, whole')
  assert.deepEqual((await typedAgain(tpm)).map((p: any) => [p.again ?? false, p.finished ?? false]), [[true, true]])
  const events = (await hq.api(`events?agent=${tpm.id}`)).json.map((e: any) => e.kind)
  assert.ok(!events.includes('message.held'), 'not held as somebody\'s draft')
  assert.equal(escapes(tpm), 1, 'no second Escape')
})

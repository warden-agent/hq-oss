// Bug 275 end to end (see harness.ts): a Clear asks its agents one after the other inside the request, so a backend restart in the
// first moment of it left the ones not reached yet running with no request (an engineer at plan review), and the clear said
// "Clearing…" for good. Here `tmux` is a stand-in that holds the Escape HQ types into the TPM for its note request while a flag file
// is there, so the backend goes down exactly while the request is on the TPM and before it reaches the engineer. After the restart
// HQ asks the rest itself: the engineer stops with HQ's note, and the clear finishes once the TPM's note is in. Bug 261: HQ's note
// for that engineer tells the archive's reader what happened, not to answer the plan.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-clear-tmux-')), flags = path.join(bin, 'flags')
before(async () => {
  const real = process.env.PATH!.split(':').map((d) => path.join(d, 'tmux')).find((p) => fs.existsSync(p)); assert.ok(real, 'tmux is installed')
  fs.mkdirSync(flags)
  // `before.send-keys.<session>`: a send-keys to that session waits while the file is there, then runs; it writes `held.…` once it waits.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
verb=; name=; prev=
for a in "$@"; do
  case "$a" in send-keys) verb="$a";; esac
  if [ "$prev" = -t ]; then name="$a"; fi
  prev="$a"
done
key="$verb.$name"
if [ -n "$verb" ] && [ -e "${flags}/before.$key" ]; then : > "${flags}/held.$key"; while [ -e "${flags}/before.$key" ]; do sleep 0.05; done; fi
exec '${real}' "$@"
`, { mode: 0o755 })
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}`, HQ_FRESH_START_TIMEOUT_S: '30' } })
  await hq.api('settings', { key: 'concurrency_cap', value: 20 })
})
after(async () => { fs.rmSync(flags, { recursive: true, force: true }); await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })

const agent = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)

test('Bug 275: a restart while the Clear request is still asking its agents for notes: HQ asks the rest after it, and the clear finishes', async () => {
  const dir = hq.repo('restart-first'), repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'restart first', request: 'Build it' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Plan', size: 'S', spec: 'Plan.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await agent(eng.id))?.status === 'working')
  const b = (await hq.modNext(eng.id)).batch; await hq.modEvent(eng.id, { kind: 'batch_received', id: b.id })
  await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
  void hq.hook(eng.id, exitPlanMode('Plan: write plan.txt.')).catch(() => null) // held at the gate; the restart drops it
  await waitFor('the review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open'))

  const flag = path.join(flags, `before.send-keys.${tpm.tmux_session}`), held = path.join(flags, `held.send-keys.${tpm.tmux_session}`)
  fs.writeFileSync(flag, '')
  try {
    void hq.api(`repos/${repo.id}/clear`, {}).catch(() => null) // it never answers: the backend goes down under it
    await waitFor('the request to reach the TPM', () => fs.existsSync(held), 15_000)
    const s0 = await hq.state()
    assert.ok(s0.repos.find((x: any) => x.id === repo.id).clearing_at); assert.ok(s0.agents.find((a: any) => a.id === tpm.id).fresh_start_at)
    const e0 = s0.agents.find((a: any) => a.id === eng.id); assert.equal(e0.status, 'plan_review'); assert.equal(e0.fresh_start_at, null) // not reached yet
    await hq.down()
  } finally { fs.rmSync(flag, { force: true }) } // the old backend's call goes on into a terminal nobody reads now
  await hq.up()

  // The engineer the request never reached is stopped with HQ's note; the TPM, asked before the restart, is still writing its own
  await waitFor('the engineer stopped after the restart', async () => (await agent(eng.id))?.status === 'exited', 30_000)
  assert.ok((await hq.state()).features.some((x: any) => x.id === f.id), 'the TPM still writes its note: the board stays until then')
  assert.equal((await agent(tpm.id)).status, 'working')
  assert.equal((await hq.mcp(tpm.id, 'write_handoff_note', { text: '## What the user wants\n- it built (FIRST-NOTE)' })).isError, false)
  await waitFor('the board gone', async () => !(await hq.state()).features.some((x: any) => x.repo_id === repo.id), 30_000)
  const s = await hq.state()
  assert.equal(s.repos.find((x: any) => x.id === repo.id).clearing_at, null)
  assert.match(s.attention.find((a: any) => a.kind === `repo_cleared:${repo.id}`).detail, /Cleared restart-first: 1 feature and 1 ticket/)

  // Bug 261: the archive's note for that engineer says what happened, for whoever reads it later; it doesn't ask them to answer the plan
  const base = path.join(hq.hqHome, 'archive', 'restart-first'), [stamp] = fs.readdirSync(base), arch = path.join(base, stamp!)
  const [folder] = fs.readdirSync(arch).filter((x) => x !== 'SUMMARY.md' && x !== 'tpm'), tdir = path.join(arch, folder!, 'tickets', t.key)
  const note = fs.readFileSync(path.join(tdir, 'HANDOFF.md'), 'utf8')
  assert.match(note, /^\(Written by HQ: the engineer didn't leave a note: the project was cleared while T-01's plan waited for the user's review, /)
  assert.match(note.split('\n')[0]!, /so it was never approved; its plan is archived as PLAN\.md\.\)$/)
  assert.doesNotMatch(note, /Answer it|your review/)
  assert.match(fs.readFileSync(path.join(tdir, 'PLAN.md'), 'utf8'), /write plan\.txt/)
  assert.match(fs.readFileSync(path.join(arch, 'tpm', 'HANDOFF.md'), 'utf8'), /FIRST-NOTE/)
})

// Bugs 138 and 151 end to end (see harness.ts): once a minute (here: every second) HQ looks at each live agent, and each look waits on
// tmux or `ps`. HQ can stop the agent, or the agent can open a new dialog, during one of those waits. The check used to go on with what it
// had read before the wait: it set a stopped agent back to idle or working, raised a notice nothing would clear, or cleared a dialog that
// had just opened. Here `tmux` and `ps` are stand-ins that hold one call while a test's flag file is there (as in missing.test.ts), so a
// test can stop an agent, or open a dialog, exactly while the check waits.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-held-look-')), flags = path.join(bin, 'flags'), log = path.join(bin, 'calls.log')
const pids: number[] = []
const real = (cmd: string) => process.env.PATH!.split(':').map((d) => path.join(d, cmd)).find((p) => fs.existsSync(p))
before(async () => {
  const tmux = real('tmux'), ps = real('ps'); assert.ok(tmux, 'tmux is installed'); assert.ok(ps, 'ps is there')
  fs.mkdirSync(flags)
  // The calls a test can hold, by what they are for: `capture-visible` (the dialog check's look at the screen), `capture-history` (the look
  // for a changed screen), `capture-idle` (the look for Claude Code's idle prompt, right after that one), `pane-pid`, and has-/kill-session.
  // `before.<call>`: the call waits, then runs. `after.<call>`: it runs, then waits before it answers. Either way it writes `held.…` once it
  // waits. A number in the flag file lets that many calls through first.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
verb=; name=; prev=; pid=; hist=
for a in "$@"; do
  if [ -n "$verb" ] && [ "$a" = -S ]; then hist=1; fi
  case "$a" in has-session|kill-session|capture-pane|display-message) if [ -z "$verb" ]; then verb="$a"; fi;; '#{pane_pid}') pid=1;; esac
  if [ "$prev" = -t ]; then name="$a"; fi
  prev="$a"
done
case "$verb" in
  capture-pane) if [ -z "$hist" ]; then verb=capture-visible
    elif [ "$(tail -n 1 '${log}' 2>/dev/null)" = "capture-history.$name" ]; then verb=capture-idle; else verb=capture-history; fi;;
  display-message) if [ -n "$pid" ]; then verb=pane-pid; else verb=; fi;;
esac
if [ -z "$verb" ]; then exec '${tmux}' "$@"; fi
key="$verb.$name"; echo "$key" >> '${log}'
go() { f="${flags}/$1.$key"; [ -e "$f" ] || return 1; n=$(cat "$f"); if [ -n "$n" ] && [ "$n" -gt 0 ]; then echo $((n - 1)) > "$f"; return 1; fi; return 0; }
hold() { : > "${flags}/held.$1.$key"; while [ -e "${flags}/$1.$key" ]; do sleep 0.05; done; }
if go before; then hold before; fi
if ! go after; then exec '${tmux}' "$@"; fi
'${tmux}' "$@"; s=$?; hold after; exit $s
`, { mode: 0o755 })
  // the frozen-run check's \`ps\` (bgruns.ts PS_ARGS): with \`after.ps\` there, the next one runs and then waits until the test lets it go
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh
if [ "$*" = "-axo pid=,ppid=,pgid=,time=,lstart=" ] && mv '${flags}/after.ps' '${flags}/taken.ps' 2>/dev/null; then
  '${ps}' "$@"; s=$?; : > '${flags}/held.after.ps'; while [ -e '${flags}/taken.ps' ]; do sleep 0.05; done; exit $s
fi
exec '${ps}' "$@"
`, { mode: 0o755 })
  hq = await start()
})
/** A test HQ that looks at its agents every second, through the stand-in `tmux` and `ps`. */
async function start(env: Record<string, string> = {}): Promise<Hq> {
  const h = await startHq({ env: { PATH: `${bin}:${process.env.PATH}`, HQ_STUCK_TICK_S: '1', ...env } })
  await h.api('settings', { key: 'concurrency_cap', value: 20 }); await h.api('settings', { key: 'bg_stall_min', value: 0.1 }) // 6 s
  return h
}
after(async () => {
  fs.rmSync(flags, { recursive: true, force: true }); for (const p of pids) try { process.kill(-p, 'SIGKILL') } catch { /* gone */ }
  await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true })
})

let n = 0
async function tpm(): Promise<any> {
  const repo = (await hq.api('repos', { path: hq.repo(`r${++n}`) })).json, a = (await hq.api(`repos/${repo.id}/message`, { body: 'hello' })).json.agent
  return waitFor('the TPM', async () => (await hq.state()).agents.find((x: any) => x.id === a.id && x.status === 'working'))
}
async function engineer(): Promise<any> {
  const repo = (await hq.api('repos', { path: hq.repo(`r${++n}`) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: `f${n}`, request: `Build f${n}` })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  return waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
}
type When = 'before' | 'after'
const flag = (when: When, call: string, a: any) => path.join(flags, `${when}.${call}.${a.tmux_session}`)
const hold = (when: When, call: string, a: any, through = 0) => fs.writeFileSync(flag(when, call, a), through ? String(through) : '')
const letGo = (when: When, call: string, a: any) => fs.rmSync(flag(when, call, a), { force: true })
const held = (when: When, call: string, a: any) => fs.existsSync(path.join(flags, `held.${when}.${call}.${a.tmux_session}`))
/** As in missing.test.ts: the check goes through the agents in the order they started, so once it has asked twice more whether `next`'s
 *  terminal is there, it is done with every agent started before it. */
const looks = (a: any) => { try { return fs.readFileSync(log, 'utf8').split('\n').filter((l) => l === `has-session.${a.tmux_session}`).length } catch { return 0 } }
async function movedOn(next: any): Promise<void> { const from = looks(next); await waitFor('the check to move on', () => looks(next) >= from + 2, 15_000) }
const kinds = async (a: any): Promise<string[]> => (await hq.api(`events?agent=${a.id}`)).json.map((e: any) => e.kind).reverse() // oldest first
const agentOf = async (a: any) => (await hq.state()).agents.find((x: any) => x.id === a.id)
const alerts = async (a: any, kind: string) => (await hq.state()).attention.filter((x: any) => x.kind === kind && x.agent_id === a.id && !x.resolved_at)
const note = (a: any, message: string) => hq.hook(a.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message })
const stop = async (a: any) => { assert.equal((await hq.api(`agents/${a.id}/stop`, {})).status, 200); assert.equal((await agentOf(a)).status, 'exited') }
/** Stopped by HQ and nothing since: still exited, once, with no "missing", "lost" or "process ended" after it. */
async function stayedStopped(a: any): Promise<string[]> {
  const ks = await kinds(a), x = await agentOf(a)
  assert.equal(x.status, 'exited', ks.join(' ')); assert.equal(x.ended_why, 'user')
  assert.equal(ks.filter((k) => k === 'agent.stopped').length, 1); assert.deepEqual(ks.filter((k) => k === 'agent.missing' || k === 'agent.lost'), [], ks.join(' '))
  assert.deepEqual(await alerts(a, 'agent_exited'), []); return ks
}
/** Bug 327: HQ is stopping `a` right now (Bug 104): the stop's `kill-session` waits, so the agent is not exited yet, until the returned
 *  function lets it go and the stop ends. A look that goes on with the agent it read before its wait, instead of reading it again, acts on
 *  this one: nothing else stops it then (a stop that has ended has resolved the agent's notices, and those notices refuse an ended agent). */
async function stopping(a: any): Promise<() => Promise<void>> {
  hold('before', 'kill-session', a); const res = hq.api(`agents/${a.id}/stop`, {})
  await waitFor('the stop to reach its terminal', () => held('before', 'kill-session', a), 15_000)
  return async () => { letGo('before', 'kill-session', a); assert.equal((await res).status, 200); assert.equal((await agentOf(a)).status, 'exited') }
}
/** Bug 327: what the stand-in `tmux` was asked about `a`'s terminal after HQ's stop killed it. A look that read the agent again leaves it alone. */
function asksAfterStop(a: any): string[] {
  const ls = fs.readFileSync(log, 'utf8').split('\n'), i = ls.lastIndexOf(`kill-session.${a.tmux_session}`); assert.ok(i >= 0, 'the stop killed its terminal')
  return ls.slice(i + 1).filter((l) => l.endsWith(`.${a.tmux_session}`))
}

/** An agent with a dialog open, answered with no hook (denied, say: Bug 62): its status file says it's idle. The first look that finds the
 *  dialog gone goes through; the second, the one that clears it, waits in `tmux`, and `during` runs while it waits. */
async function secondDialogLook(a: any, during: () => Promise<void>): Promise<void> {
  await hq.session(a.id, 'waiting'); await note(a, 'Allow this?'); assert.equal((await agentOf(a)).status, 'blocked')
  hold('before', 'capture-visible', a, 1); await hq.session(a.id, 'idle')
  try { await waitFor('the second look at its screen', () => held('before', 'capture-visible', a), 15_000); await during() } finally { letGo('before', 'capture-visible', a) }
}

// Bug 327: stopped, the look's dialog notices went with it (clearDialogs reads them again); still being stopped, only the look's own re-read
// (stuck.ts dialogSweep, `live`) keeps it from clearing the dialog and setting the agent idle under the stop.
const hasStopped = { stopped: 'has stopped', stopping: 'is still stopping' } as const
for (const how of ['stopped', 'stopping'] as const) {
  test(`Bug 138: an agent HQ ${hasStopped[how]} when the dialog check's look at its screen ends stays stopped`, async () => {
    const a = await tpm(), next = await tpm()
    let end = async () => {}
    try {
      await secondDialogLook(a, async () => { if (how === 'stopped') await stop(a); else end = await stopping(a) })
      await movedOn(next)
      if (how !== 'stopped') { assert.equal((await agentOf(a)).status, 'blocked'); assert.equal((await alerts(a, 'dialog')).length, 1, 'the look left its dialog alone') }
    } finally { await end() }
    const ks = await stayedStopped(a); assert.ok(!ks.includes('agent.dialog_cleared'), ks.join(' '))
    if (how === 'stopped') assert.deepEqual(asksAfterStop(a), [])
    assert.equal((await agentOf(next)).status, 'working') // and only that one: nothing in this HQ sets a quiet agent idle (Bug 326)
  })
}

for (const [what, words] of [['a new dialog', 'Allow that as well?'], ['the same dialog again', 'Allow this?']]) {
  test(`Bug 151: ${what} opening while the check looks at the screen is not cleared, and the agent stays blocked`, async () => {
    const a = await tpm(), next = await tpm()
    await secondDialogLook(a, async () => { await hq.session(a.id, 'waiting'); await note(a, words) })
    await movedOn(next)
    assert.equal((await agentOf(a)).status, 'blocked')
    const open = await alerts(a, 'dialog'); assert.equal(open.length, 1); assert.match(open[0].detail, new RegExp(words.replace('?', '\\?')))
    assert.ok(!(await kinds(a)).includes('agent.dialog_cleared'))
    // and once that one is answered with no hook as well, it clears as before
    await hq.session(a.id, 'idle')
    await waitFor('the dialog to clear', async () => !(await alerts(a, 'dialog')).length, 15_000); assert.equal((await agentOf(a)).status, 'idle')
  })
}

// Bug 327: stopped, attention() refuses a notice for an ended agent (Bug 153); still being stopped, after the user dismissed the notice, only the
// re-read after `ps` (stuck.ts runSweep) keeps it from coming back until the stop ends.
for (const how of ['stopped', 'stopping'] as const) test(`Bug 138: an engineer HQ ${hasStopped[how]} when the check's \`ps\` for its frozen run ends gets \
no new "frozen" notice`, async () => {
  const eng = await engineer(), next = await tpm()
  // what a real engineer did (bgruns.test.ts): a test run with a time limit that Claude Code moved to the background, then the turn ended
  const use = 'toolu_frozen', command = 'npm run test-backend', input = { command, timeout: 600000 }
  await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: 'run the tests' })
  await hq.hook(eng.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: use, tool_input: input })
  pids.push(await hq.spawn(eng.id, 'exec node -e "setInterval(() => {}, 1e9)"'))
  await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: use, tool_input: input,
    tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'btfrozen', timedOutAfterMs: 600000 } })
  await hq.hook(eng.id, { hook_event_name: 'Stop', last_assistant_message: 'The run is still going.' })
  await waitFor('the frozen run notice', async () => (await alerts(eng, 'bg_stalled')).length > 0, 30_000)
  fs.rmSync(path.join(flags, 'held.after.ps'), { force: true }); fs.writeFileSync(path.join(flags, 'after.ps'), '')
  let end = async () => {}
  try {
    try {
      await waitFor('the check to run ps', () => fs.existsSync(path.join(flags, 'held.after.ps')), 15_000)
      if (how === 'stopped') { await stop(eng); assert.deepEqual(await alerts(eng, 'bg_stalled'), [], 'the stop cleared it') } else {
        const [open] = await alerts(eng, 'bg_stalled'); assert.equal((await hq.api(`attention/${open.id}/resolve`, {})).status, 200) // the user dismissed it
        end = await stopping(eng)
      }
    } finally { for (const f of ['after.ps', 'taken.ps']) fs.rmSync(path.join(flags, f), { force: true }) }
    await movedOn(next)
    assert.deepEqual(await alerts(eng, 'bg_stalled'), [])
  } finally { await end() }
  const ks = await stayedStopped(eng); assert.ok(!ks.includes('bg.stop_failed'))
  assert.equal(ks.filter((k) => k === 'attention.bg_stalled').length, 1, ks.join(' ')) // not raised again, not even for a moment
  if (how === 'stopped') assert.deepEqual(asksAfterStop(eng), [])
})

test('Bug 138: an engineer HQ stops while the check looks at its screen gets no "idle" notice', async () => {
  const eng = await engineer(), next = await tpm()
  const launch = (await hq.modNext(eng.id)).batch; await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: launch.text })
  await hq.hook(eng.id, { hook_event_name: 'Stop', last_assistant_message: 'I will wait for the results.' })
  await hq.api('settings', { key: 'stuck_idle_min', value: 0.05 }) // 3 s
  try {
    await waitFor('the idle engineer notice', async () => (await alerts(eng, 'engineer_idle')).length > 0, 20_000)
    hold('after', 'capture-history', eng)
    try {
      await waitFor('the look at its screen', () => held('after', 'capture-history', eng), 15_000)
      await stop(eng); assert.deepEqual(await alerts(eng, 'engineer_idle'), [], 'the stop cleared it')
    } finally { letGo('after', 'capture-history', eng) }
    await movedOn(next)
    assert.deepEqual(await alerts(eng, 'engineer_idle'), []); await stayedStopped(eng); assert.deepEqual(asksAfterStop(eng), [])
  } finally { await hq.api('settings', { key: 'stuck_idle_min', value: 45 }) }
})

// Bug 326: this test has an HQ of its own, so it is the file's last. It needs Bug 25's idle fix after 2 s and Claude Code's idle prompt on every
// screen, and with those HQ sets each working agent idle a few seconds after it starts. The tests above used to share that HQ, and the first
// one's "the next agent is still working" then held only when no look of HQ's fell between that agent's start and the test's dialog.
// One HQ at a time: the stand-in `tmux` tells the idle look from the look before it by the last line of the one log.
test('Bug 138: a working agent HQ stops while the check reads its idle screen is not set back to idle', async () => {
  await hq.stop(); hq = await start({ HQ_IDLE_FIX_S: '2', HQ_FAKE_IDLE_SCREEN: '1' })
  const a = await tpm(), next = await tpm() // working, and its screen shows Claude Code's idle prompt: a Stop hook was missed (Bug 25)
  hold('after', 'capture-idle', a, 1) // the first look at the idle prompt goes through; the second, the one that sets it idle, waits
  try { await waitFor('the second look at its idle screen', () => held('after', 'capture-idle', a), 20_000); await stop(a) } finally { letGo('after', 'capture-idle', a) }
  await movedOn(next)
  const ks = await stayedStopped(a); assert.ok(!ks.includes('agent.idle_fixed'), ks.join(' '))
})

// Bug 327: the re-read after the look for a changed screen (stuck.ts tick, after `paneHash`). The one after the idle look catches the same stop, so
// without it nothing shows but one more look: HQ still takes the stopped agent for working and reads its screen for the idle prompt.
test('Bug 138: a working agent HQ stops while the check reads its screen for a change is not looked at again', async () => {
  const a = await tpm(), next = await tpm()
  hold('after', 'capture-idle', a) // the first look at its idle prompt waits; the next look's read for a changed screen is the one held
  try {
    await waitFor('the first look at its idle screen', () => held('after', 'capture-idle', a), 20_000); hold('after', 'capture-history', a)
  } finally { letGo('after', 'capture-idle', a) }
  try { await waitFor('the next look at its screen', () => held('after', 'capture-history', a), 15_000); await stop(a) } finally { letGo('after', 'capture-history', a) }
  await movedOn(next)
  const ks = await stayedStopped(a); assert.ok(!ks.includes('agent.idle_fixed'), ks.join(' ')); assert.deepEqual(asksAfterStop(a), [])
})

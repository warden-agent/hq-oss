// Bug 104 end to end (see harness.ts): once a minute (here: every second) HQ checks that every live agent's terminal is still there.
// It reads the list of agents once and looks at each terminal after that, so HQ can stop an agent in between. Such an agent was
// logged as "missing", and one stopped on the second look in a row was "lost", with a "process ended" alert. Here `tmux` is a
// stand-in that holds one call while a test's flag file is there, so a test can stop an agent exactly while the check looks at
// it. An agent whose terminal went by itself is still missing, then lost.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-held-tmux-')), flags = path.join(bin, 'flags'), log = path.join(bin, 'calls.log')
before(async () => {
  const real = process.env.PATH!.split(':').map((d) => path.join(d, 'tmux')).find((p) => fs.existsSync(p)); assert.ok(real, 'tmux is installed')
  fs.mkdirSync(flags)
  // `before.<call>`: the call waits, then runs. `after.<call>`: it runs, then waits before it answers. Either way it writes `held.…` once it waits.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
verb=; name=; prev=
for a in "$@"; do
  case "$a" in has-session|kill-session) verb="$a";; esac
  if [ "$prev" = -t ]; then name="$a"; fi
  prev="$a"
done
if [ -z "$verb" ]; then exec '${real}' "$@"; fi
key="$verb.$name"; echo "$key" >> '${log}'
hold() { : > "${flags}/held.$1.$key"; while [ -e "${flags}/$1.$key" ]; do sleep 0.05; done; }
if [ -e "${flags}/before.$key" ]; then hold before; fi
if [ ! -e "${flags}/after.$key" ]; then exec '${real}' "$@"; fi
'${real}' "$@"; s=$?; hold after; exit $s
`, { mode: 0o755 })
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}`, HQ_STUCK_TICK_S: '1' } })
})
after(async () => { fs.rmSync(flags, { recursive: true, force: true }); await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })

let n = 0
async function tpm(): Promise<any> {
  const repo = (await hq.api('repos', { path: hq.repo(`m${++n}`) })).json, a = (await hq.api(`repos/${repo.id}/message`, { body: 'hello' })).json.agent
  return waitFor('the TPM', async () => (await hq.state()).agents.find((x: any) => x.id === a.id && x.status === 'working'))
}
type When = 'before' | 'after'
const flag = (when: When, verb: string, a: any) => path.join(flags, `${when}.${verb}.${a.tmux_session}`)
const hold = (when: When, verb: string, a: any) => fs.writeFileSync(flag(when, verb, a), '')
const letGo = (when: When, verb: string, a: any) => fs.rmSync(flag(when, verb, a), { force: true })
const held = (when: When, verb: string, a: any) => fs.existsSync(path.join(flags, `held.${when}.${verb}.${a.tmux_session}`))
/** How many times the check has asked tmux whether the agent's terminal is there. Only the check asks that about a TPM. */
const looks = (a: any) => { try { return fs.readFileSync(log, 'utf8').split('\n').filter((l) => l === `has-session.${a.tmux_session}`).length } catch { return 0 } }
/** The check goes through the agents in the order they started, one after the other, so once it has asked about `next` (started
 *  after the agent a test is about) it is done with that agent. Twice: the first may be a pass that was already on its way. */
async function movedOn(next: any): Promise<void> { const from = looks(next); await waitFor('the check to move on', () => looks(next) >= from + 2, 15_000) }
const kinds = async (a: any): Promise<string[]> => (await hq.api(`events?agent=${a.id}`)).json.map((e: any) => e.kind).reverse() // oldest first
const statusOf = async (a: any) => (await hq.state()).agents.find((x: any) => x.id === a.id).status
const alerts = async (a: any) => (await hq.state()).attention.filter((x: any) => x.kind === 'agent_exited' && x.agent_id === a.id)
const sessions = () => hq.tmux('list-sessions', '-F', '#{session_name}').split('\n')
const none = (ks: string[]) => ks.filter((k) => k === 'agent.missing' || k === 'agent.lost')

test('Bug 104: an agent HQ stops while the check waits to look at its terminal is not logged as missing', async () => {
  const a = await tpm(), next = await tpm()
  hold('before', 'has-session', a)
  await waitFor('the check to reach its terminal', () => held('before', 'has-session', a), 15_000) // its list was read with the agent still live
  assert.ok(sessions().includes(a.tmux_session))
  assert.equal((await hq.api(`agents/${a.id}/stop`, {})).status, 200); assert.equal(await statusOf(a), 'exited'); assert.equal(sessions().includes(a.tmux_session), false)
  letGo('before', 'has-session', a); await movedOn(next)
  const ks = await kinds(a); assert.deepEqual(none(ks), [], ks.join(' ')); assert.equal(ks.filter((k) => k === 'agent.stopped').length, 1)
  assert.deepEqual(await alerts(a), []); assert.equal(await statusOf(next), 'working')
})

test('Bug 104: nor is one whose terminal is already gone while HQ is still stopping it, however often the check looks', async () => {
  const a = await tpm(), next = await tpm()
  hold('after', 'kill-session', a)
  const stop = hq.api(`agents/${a.id}/stop`, {})
  try {
    await waitFor('its terminal to be gone', () => held('after', 'kill-session', a), 15_000)
    assert.equal(sessions().includes(a.tmux_session), false); assert.equal(await statusOf(a), 'working') // gone, and HQ hasn't written yet that it stopped it
    // two looks in a row find no terminal: that used to be "missing", then "lost" with its alert
    const from = looks(a); await waitFor('two looks at it', () => looks(a) >= from + 2, 15_000); await movedOn(next)
    assert.deepEqual(none(await kinds(a)), []); assert.deepEqual(await alerts(a), []); assert.equal(await statusOf(a), 'working')
  } finally { letGo('after', 'kill-session', a); await stop.catch(() => {}) } // a failed test leaves no call waiting
  assert.equal((await stop).status, 200); assert.equal(await statusOf(a), 'exited')
  await movedOn(next)
  const ks = await kinds(a); assert.deepEqual(none(ks), [], ks.join(' ')); assert.equal(ks.filter((k) => k === 'agent.stopped').length, 1)
  assert.deepEqual(await alerts(a), [])
})

test('an agent whose terminal went by itself is still missing on the first look and lost on the second, with its alert', async () => {
  const a = await tpm(), next = await tpm()
  hq.tmux('kill-session', '-t', a.tmux_session)
  await waitFor('it to be lost', async () => (await statusOf(a)) === 'exited', 15_000)
  const ks = await kinds(a); assert.deepEqual(none(ks), ['agent.missing', 'agent.lost'], ks.join(' ')); assert.ok(!ks.includes('agent.stopped'))
  const open = await alerts(a); assert.equal(open.length, 1); assert.equal(open[0].detail, `${a.display_name} process ended`); assert.equal(open[0].resolved_at, null)
  await movedOn(next); assert.deepEqual(none(await kinds(next)), []); assert.equal(await statusOf(next), 'working') // and only that one
})

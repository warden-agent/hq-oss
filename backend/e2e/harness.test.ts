// The harness itself: the fake Claude Code starts and reports in, the tests can act as an agent through its hooks and MCP
// tools, the plan gate holds and answers, and nothing reaches the live HQ.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startHq, waitFor, exitPlanMode, pendingAfter, lockOf, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

test('fake agents report in, hooks and MCP work as the agent, the plan gate holds until answered', async () => {
  const dir = hq.repo('smoke')
  const repo = (await hq.api('repos', { path: dir })).json; assert.equal(repo.kind, 'local')
  const f = (await hq.api('features', { repoId: repo.id, title: 'Smoke', request: 'Make a thing' })).json
  const tpm = await waitFor('the TPM to report in', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  assert.equal(tpm.role, 'tpm')
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Add b', size: 'S', spec: 'Add b.txt' })).json
  const launched = await hq.api(`tickets/${t.id}/launch`, {}); assert.equal(launched.status, 200, JSON.stringify(launched.json))
  const eng = await waitFor('the engineer to report in', async () => (await hq.state()).agents.find((a: any) => a.id === launched.json.id && a.status === 'working'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key)
  assert.match(lockOf(dir, wt) ?? '', new RegExp(`^claude session ${t.key} \\(pid \\d+ `)) // locked like Claude Code does

  const got = await hq.mcp(eng.id, 'get_ticket'); assert.equal(got.isError, false); assert.match(got.text, new RegExp(`# ${t.key} \\(S\\): Add b`))
  const held = hq.hook(eng.id, exitPlanMode('Plan: add b.txt'))
  assert.equal(await pendingAfter(held, 500), true) // held for a verdict
  const review = await waitFor('the review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open'))
  assert.equal((await hq.api(`reviews/${review.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  const answer = await held
  assert.equal(answer.hookSpecificOutput.decision.behavior, 'allow'); assert.equal(answer.hookSpecificOutput.decision.updatedInput.plan, 'Plan: add b.txt')

  // Isolation: the agents live on the harness's own tmux server, and HQ's trust entries went to the harness's home only.
  assert.match(hq.tmux('ls'), new RegExp(`hq-${eng.id}`))
  const live = (() => { const e = { ...process.env }; delete e.TMUX_TMPDIR; delete e.TMUX; try { return execFileSync('tmux', ['ls'], { env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' } })()
  assert.doesNotMatch(live, new RegExp(`hq-${eng.id}`))
  const trusted = (file: string) => fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? {}) : []
  assert.ok(trusted(path.join(hq.home, '.claude.json')).some((p) => p.startsWith(path.dirname(hq.home))))
  assert.ok(!trusted(path.join(os.homedir(), '.claude.json')).some((p) => p.startsWith(path.dirname(hq.home))))
})

test('a Stop HQ answers with a message goes on like Claude Code: the turn ends again, and the agent is idle', async () => {
  const dir = hq.repo('stop-again'); const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'Stop again', request: 'Make a thing' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const status = async () => (await hq.state()).agents.find((a: any) => a.id === tpm.id).status
  await hq.api(`agents/${tpm.id}/message`, { body: 'One more thing.', reason: 'fyi' }) // the fake has no mod: the Stop hook carries it
  const r = await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  assert.equal(r.decision, 'block'); assert.equal(await status(), 'idle') // the first answer, and the Stop that ended the turn it started
  assert.deepEqual(await hq.hookOnce(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' }), {}) // nothing left to hand over
})

test('stopping a test HQ twice never reaches a tmux server outside its own folder', async () => {
  // A tmux that records every call and refuses kill-server unless it names a socket first, so even a regression here can't reach the user's server.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-faketmux-')), calls = path.join(bin, 'calls')
  const real = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim()
  const script = ['#!/bin/sh', `echo "$*" >> '${calls}'`, `case " $* " in *" kill-server "*) [ "$1" = -S ] || { echo 'refused: no -S' >&2; exit 1; } ;; esac`, `exec '${real}' "$@"`]
  fs.writeFileSync(path.join(bin, 'tmux'), script.join('\n') + '\n', { mode: 0o755 })
  const hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}` } })
  hq.tmux('new-session', '-d', '-s', 'probe', 'sleep 60') // its own server, as an agent's would start it
  await hq.stop(); await hq.stop() // the second used to run a bare kill-server after its folder had gone: the default server
  const kills = fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.split(' ').includes('kill-server'))
  assert.ok(kills.length >= 1, 'it stopped its own server')
  const own = (process.env.HQ_SHORT_TMPDIR ?? '/tmp').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') // own-tmp.mjs gives the run a folder of its own there
  for (const k of kills) assert.match(k, new RegExp(`^-S ${own}/hq-e2e-\\S+/tmux-\\d+/default kill-server$`), k)
  fs.rmSync(bin, { recursive: true, force: true })
})


/** Something else listening on `port`, as another test HQ's hooks server would. */
const squat = (port: number): Promise<net.Server> => new Promise((resolve, reject) => {
  const s = net.createServer((c) => c.end('HTTP/1.1 404 Not Found\r\ncontent-length: 2\r\n\r\n{}')); s.on('error', reject); s.listen(port, '127.0.0.1', () => resolve(s))
})
const closed = (s: net.Server) => new Promise((r) => s.close(r))
const freeNow = async (): Promise<number> => { const s = await squat(0), p = (s.address() as net.AddressInfo).port; await closed(s); return p }

test('Bug 92: a port taken before the backend listens gets new ports, so MCP calls reach HQ\'s MCP server', async () => {
  const taken = await freeNow(), other = await squat(taken)
  const hq = await startHq({ ports: { mcp: taken } })
  try {
    assert.notEqual(hq.ports.mcp, taken, 'it moved off the taken port')
    assert.equal(new Set(Object.values(hq.ports)).size, 3, 'three different ports')
    assert.match(hq.log(), /EADDRINUSE/, 'the first try did hit it')
    const repo = (await hq.api('repos', { path: hq.repo('ports') })).json
    const f = (await hq.api('features', { repoId: repo.id, title: 'Ports', request: 'Make a thing' })).json
    await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
    const r = await hq.mcp(f.tpm_agent_id, 'list_tickets'); assert.equal(r.isError, false, r.text)
  } finally { await hq.stop(); await closed(other) }
})

test('Bug 92: a restart whose port was taken meanwhile says so, rather than running without that server', async () => {
  const hq = await startHq()
  try {
    await hq.down(); const other = await squat(hq.ports.mcp)
    try { await assert.rejects(hq.up(), /was taken while it was down/) } finally { await closed(other) }
    await hq.up(); assert.equal((await hq.api('state')).status, 200, 'and it starts once the port is free')
  } finally { await hq.stop() }
})

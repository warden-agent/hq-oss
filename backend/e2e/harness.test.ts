// The harness itself: the fake Claude Code starts and reports in, the tests can act as an agent through its hooks and MCP
// tools, the plan gate holds and answers, and nothing reaches the live HQ.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
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


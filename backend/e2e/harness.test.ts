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
  const trusted = (file: string) => Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? {})
  assert.ok(trusted(path.join(hq.home, '.claude.json')).some((p) => p.startsWith(path.dirname(hq.home))))
  assert.ok(!trusted(path.join(os.homedir(), '.claude.json')).some((p) => p.startsWith(path.dirname(hq.home))))
})

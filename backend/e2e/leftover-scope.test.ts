// Bug 100 end to end (see harness.ts): the look after an agent's Bash command covers only what that command can have left, in
// its agent's worktree, and asks lsof nothing when nothing new is there; the full look (here: an agent stopped) still covers
// everything. `ps` and `lsof` go through shims that write down each call. The whole file finishes well inside a minute, so HQ's
// minute-long full look can't take part.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
const pids: number[] = []
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-shims-')), log = path.join(bin, 'calls.log')
before(async () => {
  for (const cmd of ['ps', 'lsof']) {
    const real = execFileSync('sh', ['-c', `command -v ${cmd}`]).toString().trim()
    fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh\necho "${cmd} $*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
  }
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}` } }); await hq.api('settings', { key: 'concurrency_cap', value: 20 })
})
after(async () => { for (const p of pids) try { process.kill(p, 'SIGKILL') } catch { /* gone */ } await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
let n = 0
/** `sleep …` started with `&` from a shell that then ends, in `cwd`: orphaned to init, like a test's server. */
function orphan(cwd: string): Promise<number> {
  const arg = `61.${process.pid % 1000}${++n}`
  return new Promise((resolve) => spawn('sh', ['-c', `sleep ${arg} &`], { cwd, detached: true, stdio: 'ignore' }).once('exit', () => setTimeout(() => {
    const pid = Number(execFileSync('ps', ['-axo', 'pid=,args=']).toString().split('\n').map((l) => l.trim()).find((l) => l.endsWith(` sleep ${arg}`))?.split(/\s+/)[0] ?? 0)
    pids.push(pid); resolve(pid)
  }, 200)))
}
async function engineer(name: string) {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id)?.status === 'working')
  return { eng, wt: (await hq.state()).tickets.find((x: any) => x.id === t.id).worktree_path as string }
}
const bash = (agentId: string, ev: 'PreToolUse' | 'PostToolUse', use: string) =>
  hq.hook(agentId, { hook_event_name: ev, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: use })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const calls = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
/** The leftover looks' own calls since call `from`: how many ps-es of every process with its start, and which pids lsof was
 *  asked for the working folder of (other programs on this machine that were orphaned just now are asked about too). */
const looks = (from: number) => {
  const c = calls().slice(from), lsof = c.filter((l) => l.startsWith('lsof -a -d cwd -p '))
  return { ps: c.filter((l) => l.includes('etime=')).length, lsof: lsof.length, asked: new Set(lsof.flatMap((l) => l.split(' ')[5]!.split(',').map(Number))) }
}

test("after a command: only what it can have left, in its own agent's worktree; the full look covers the rest", async () => {
  const a = await engineer('scope-a'), b = await engineer('scope-b')
  const older = await orphan(a.wt) // in A's worktree, from before A's command (a stand-in for anything a narrowed look can't tell is that command's)
  await sleep(6000) // clearly older than the command: ps gives start times in whole seconds, and a busy HQ reads them late

  // one command that leaves nothing, then one that leaves a server while something new turns up in B's worktree too (B runs
  // nothing). Looks run one at a time, so once the server is gone every look after either command is in the log.
  const from = calls().length
  await bash(a.eng.id, 'PreToolUse', 'q1'); await bash(a.eng.id, 'PostToolUse', 'q1')
  await waitFor('the look after the command', () => looks(from).ps >= 1, 10_000)
  await bash(a.eng.id, 'PreToolUse', 'q2'); const left = await orphan(a.wt), elsewhere = await orphan(b.wt)
  await bash(a.eng.id, 'PostToolUse', 'q2')
  await waitFor(`pid ${left} to be stopped`, () => !alive(left), 12_000)
  const seen = `left ${left}, older ${older}, elsewhere ${elsewhere}:\n${calls().slice(from).join('\n')}`
  assert.ok(looks(from).asked.has(left), seen); assert.ok(!looks(from).asked.has(older), seen) // on a quiet machine q1's look runs no lsof at all
  assert.ok(alive(older), 'began before the command: not looked at after it')
  assert.ok(alive(elsewhere), "another agent's worktree: not looked at after A's command")

  // the full look, when an agent stops (and every minute): both go
  assert.equal((await hq.api(`agents/${b.eng.id}/stop`, {})).status, 200)
  await waitFor('the full look to stop both', () => !alive(older) && !alive(elsewhere), 15_000)
})

test('a TPM, or any agent with no worktree, gets no look at all after its commands', async () => {
  const repo = (await hq.api('repos', { path: hq.repo('scope-tpm') })).json
  const first = (await hq.api(`repos/${repo.id}/message`, { body: 'A place to jot notes.' })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === first.agent.id)?.status === 'working', 20_000)
  await sleep(6500) // let any look already due go by
  const from = calls().length
  await bash(first.agent.id, 'PreToolUse', 't1'); await bash(first.agent.id, 'PostToolUse', 't1')
  await sleep(4000); assert.equal(looks(from).ps, 0, calls().slice(from).join('\n'))
})

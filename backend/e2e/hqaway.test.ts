// Bug 85 end to end (see harness.ts): an agent's request for HQ's OK, run with the command HQ wrote into its settings.json the way
// Claude Code runs it, waits while the backend is away and is answered when it's back. An agent that was told to stop and wait
// (HQ away too long) hears from HQ once it's back: at the start, and when its next hook arrives.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { startHq, waitFor, pendingAfter, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

/** Runs a hook command as Claude Code does (a shell, the hook's JSON on stdin) and resolves with what it printed. */
const runHook = (command: string, input: unknown): Promise<string> => new Promise((resolve, reject) => {
  const p = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'inherit'] }); let out = ''
  p.stdout.on('data', (d) => { out += d }); p.on('error', reject); p.on('close', () => resolve(out)); p.stdin.end(JSON.stringify(input))
})
const fromHq = async (agentId: string) => (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === agentId && /HQ is back/.test(m.body))

test('Bug 85: a request for HQ\'s OK made while the backend is away waits for it, and an agent told to wait hears when HQ is back', async () => {
  const repo = (await hq.api('repos', { path: hq.repo('away') })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'away', request: 'Build it' })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  const dir = path.join(hq.hqHome, 'agents', eng.id), mark = path.join(dir, 'hq-unreachable')
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  const [gate, other] = settings.hooks.PermissionRequest.map((g: any) => g.hooks[0])
  for (const h of [gate, other]) {
    assert.equal(h.type, 'command'); assert.ok(h.command.includes('hookwait.mjs'))
    assert.ok(!h.command.includes(hq.agentToken(eng.id))) // its token stays in its own file (Bug 87)
  }
  const ask = { hook_event_name: 'PermissionRequest', tool_name: 'mcp__hq__get_ticket', tool_input: {}, permission_mode: 'plan', session_id: 's' }

  assert.equal(JSON.parse(await runHook(other.command, ask)).hookSpecificOutput.decision.behavior, 'allow') // HQ up: as before

  await hq.down()
  const held = runHook(other.command, ask)
  assert.equal(await pendingAfter(held, 2500), true) // no refusal while HQ is away
  await hq.up()
  assert.equal(JSON.parse(await held).hookSpecificOutput.decision.behavior, 'allow')
  assert.ok(!fs.existsSync(mark)); assert.deepEqual(await fromHq(eng.id), []) // it went through: nothing to tell the agent

  // Told to stop and wait (hookwait.mjs left its note), and HQ comes back with the agent sitting idle: HQ tells it at the start
  await hq.down(); fs.writeFileSync(mark, String(Date.now())); await hq.up()
  await waitFor('HQ\'s message to the agent', async () => (await fromHq(eng.id)).length === 1)
  assert.ok(!fs.existsSync(mark))

  // HQ came back just before the note was written: the agent's next hook is what tells HQ
  fs.writeFileSync(mark, String(Date.now()))
  await hq.hook(eng.id, { hook_event_name: 'Stop', last_assistant_message: 'Waiting for HQ.' })
  await waitFor('a second message', async () => (await fromHq(eng.id)).length === 2)
  await hq.hook(eng.id, { hook_event_name: 'Stop', last_assistant_message: 'Waiting for HQ.' })
  await hq.down(); await hq.up()
  assert.equal((await fromHq(eng.id)).length, 2) // once per note, never again
})

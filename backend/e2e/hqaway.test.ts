// Bug 85 end to end (see harness.ts): an agent's request for HQ's OK, run with the command HQ wrote into its settings.json the way
// Claude Code runs it, waits while the backend is away and is answered when it's back. An agent that was told to stop and wait
// (HQ away too long) hears from HQ once it's back: at the start, and when its next hook arrives.
// Bug 112: an engineer's build or full test run that starts while the backend is away, or that was waiting its turn when it went, waits for it and is in
// HQ's line again once it's back; small commands go ahead at once.
// Bug 145: a restarted backend still counts the run that was going, and the line keeps its order.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { startHq, waitFor, pendingAfter, type Hq } from './harness.ts'

let hq: Hq
/** Hook commands still running, by the process group each has to itself: a test that fails halfway leaves none waiting for an HQ that's gone. */
const hooks = new Set<number>()
before(async () => { hq = await startHq() })
after(async () => { for (const pid of hooks) { try { process.kill(-pid, 'SIGKILL') } catch { /* ended */ } } await hq?.stop() })

/** Runs a hook command as Claude Code does (a shell, the hook's JSON on stdin) and resolves with what it printed. */
const runHook = (command: string, input: unknown): Promise<string> => new Promise((resolve, reject) => {
  const p = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'inherit'], detached: true }); let out = ''
  if (p.pid) hooks.add(p.pid)
  p.stdout.on('data', (d) => { out += d }); p.on('error', reject); p.on('close', () => { hooks.delete(p.pid!); resolve(out) }); p.stdin.end(JSON.stringify(input))
})
/** Room for every engineer a test launches (the default cap is 2): each test sets it itself, so it passes run alone or in any order (Bug 204). */
const roomForEngineers = async () => assert.equal((await hq.api('settings', { key: 'concurrency_cap', value: 20 })).status, 200)
/** Launches a ticket's engineer; a refusal (e.g. no room under the cap) fails here, with HQ's reason, not later on a missing id. */
const launch = async (ticketId: string) => {
  const r = await hq.api(`tickets/${ticketId}/launch`, {}); assert.equal(r.status, 200, `launch refused: ${JSON.stringify(r.json)}`); return r.json
}
const fromHq = async (agentId: string) => (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === agentId && /HQ is back/.test(m.body))

test('Bug 85: a request for HQ\'s OK made while the backend is away waits for it, and an agent told to wait hears when HQ is back', async () => {
  await roomForEngineers()
  const repo = (await hq.api('repos', { path: hq.repo('away') })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'away', request: 'Build it' })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json
  const eng = await launch(t.id)
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

test('Bug 112: with the backend away, engineers\' builds and test runs wait for it and then take turns; small commands go ahead at once', async () => {
  const engineer = async (name: string) => {
    const repo = (await hq.api('repos', { path: hq.repo(name) })).json, f = (await hq.api('features', { repoId: repo.id, title: name, request: 'Build it' })).json
    const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json, eng = await launch(t.id)
    const bash = JSON.parse(fs.readFileSync(path.join(hq.hqHome, 'agents', eng.id, 'settings.json'), 'utf8')).hooks.PreToolUse[0]
    assert.equal(bash.matcher, 'Bash'); assert.equal(bash.hooks[0].type, 'command'); assert.ok(bash.hooks[0].command.includes('turnwait.mjs'))
    assert.ok(!bash.hooks[0].command.includes(hq.agentToken(eng.id))) // its token stays in its own file (Bug 87)
    return { repo, t, eng, hook: bash.hooks[0].command as string }
  }
  const pre = (use: string, command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: use, tool_input: { command }, permission_mode: 'acceptEdits', session_id: 's' })
  const ended = (agentId: string, use: string) => hq.hook(agentId, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: use, tool_input: {} })
  const events = async (kind: string) => ((await hq.api('events?limit=300')).json as any[]).filter((e) => e.kind === kind).map((e) => ({ agent: e.agent_id, ...JSON.parse(e.payload) })).reverse()
  await roomForEngineers()
  const a = await engineer('away-a'), b = await engineer('away-b')
  // project b's test command is one no rule knows by name; saved the way the Auto box saves it, it is in the file the hook reads while HQ is away
  assert.equal((await hq.api(`repos/${b.repo.id}/test-cmd`, { cmd: './verify.sh' })).status, 200)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hq.hqHome, 'test-cmds.json'), 'utf8')), { [b.repo.id]: './verify.sh' })

  assert.equal(await runHook(a.hook, pre('u1', 'npm test')), '{}'); await ended(a.eng.id, 'u1') // HQ up and nobody running: answered at once, as before

  await hq.down()
  assert.equal(await runHook(a.hook, pre('u2', 'git status')), '{}') // a small command doesn't wait for HQ
  assert.equal(await runHook(a.hook, pre('u3', './verify.sh')), '{}') // nor does another project's test command
  const runA = runHook(a.hook, pre('u4', 'npm test')), runB = runHook(b.hook, pre('u5', './verify.sh 2>&1 | tail -20'))
  assert.equal(await pendingAfter(Promise.race([runA, runB]), 2500), true) // before: both began here, at the same moment
  await hq.up()
  const first = await Promise.race([runA.then((out) => ({ out, x: a, use: 'u4', other: runB, y: b })), runB.then((out) => ({ out, x: b, use: 'u5', other: runA, y: a }))])
  assert.equal(first.out, '{}') // HQ is back: one of them has the turn…
  assert.equal(await pendingAfter(first.other, 1500), true) // …and the other waits in HQ's line, where the board shows it
  const waiting = await waitFor('the other in HQ\'s line', async () => (await events('turns.waiting')).find((e) => e.agent === first.y.eng.id))
  assert.deepEqual(waiting.behind, [`eng ${first.x.t.key}`])
  assert.match((await hq.state()).agents.find((x: any) => x.id === first.y.eng.id).activity, /^Waiting its turn to run tests$/)
  await ended(first.x.eng.id, first.use); assert.equal(await first.other, '{}') // the first run ends: the other begins
  await ended(first.y.eng.id, first.use === 'u4' ? 'u5' : 'u4')

  // The backend goes while a run waits in its line: the cut connection used to count as HQ's answer, and the run began
  assert.deepEqual(await hq.hook(a.eng.id, pre('u6', 'npm test')), {}) // a is running its tests
  const held = runHook(b.hook, pre('u7', 'npm run build'))
  await waitFor('b in HQ\'s line', async () => (await events('turns.waiting')).some((e) => e.use === 'u7'))
  await hq.down()
  assert.equal(await pendingAfter(held, 2500), true)
  await hq.up()
  assert.ok((await waitFor('b asking again', async () => (await events('hook.PreToolUse:Bash')).filter((e) => e.use === 'u7').length === 2)))
  assert.equal(await pendingAfter(held, 1500), true) // Bug 145: a restarted HQ still counts a's run, so b's waits for it…
  await ended(a.eng.id, 'u6'); assert.equal(await held, '{}') // …and begins when it ends
  await ended(b.eng.id, 'u7')
})

test('Bug 145: after a restart HQ still counts the run that was going, and the line keeps its order whichever hook asks again first', async () => {
  const engineer = async (name: string) => {
    const repo = (await hq.api('repos', { path: hq.repo(name) })).json, f = (await hq.api('features', { repoId: repo.id, title: name, request: 'Build it' })).json
    const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json, eng = await launch(t.id)
    const hook = JSON.parse(fs.readFileSync(path.join(hq.hqHome, 'agents', eng.id, 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command as string
    return { t, eng, hook }
  }
  const pre = (use: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: use, tool_input: { command: 'npm test' }, permission_mode: 'acceptEdits', session_id: 's' })
  const ended = (agentId: string, use: string) => hq.hook(agentId, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: use, tool_input: {} })
  const events = async (kind: string) => ((await hq.api('events?limit=300')).json as any[]).filter((e) => e.kind === kind).map((e) => ({ agent: e.agent_id, ...JSON.parse(e.payload) }))
  const asked = async (use: string) => (await events('hook.PreToolUse:Bash')).filter((e) => e.use === use).length
  /** A hook command run as Claude Code runs it, which this test can also kill (its own process group). */
  const hookRun = (command: string, input: unknown) => {
    const p = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'inherit'], detached: true }); let text = ''
    if (p.pid) hooks.add(p.pid)
    const out = new Promise<string>((resolve, reject) => {
      p.stdout.on('data', (d) => { text += d }); p.on('error', reject); p.on('close', () => { hooks.delete(p.pid!); resolve(text) })
    })
    p.stdin.end(JSON.stringify(input)); return { out, kill: () => { try { process.kill(-p.pid!, 'SIGKILL') } catch { /* ended */ } } }
  }
  await roomForEngineers()
  const p = await engineer('order-p'), q = await engineer('order-q'), r = await engineer('order-r')
  assert.deepEqual(await hq.hook(p.eng.id, pre('o1')), {}) // p runs its tests
  const qFirst = hookRun(q.hook, pre('o2'))
  await waitFor('q in HQ\'s line', async () => (await events('turns.waiting')).some((e) => e.use === 'o2'))
  const rRun = hookRun(r.hook, pre('o3'))
  await waitFor('r in HQ\'s line behind q', async () => (await events('turns.waiting')).some((e) => e.use === 'o3'))
  const said = async () => { const as = (await hq.state()).agents; return [p, q, r].map((x) => as.find((a: any) => a.id === x.eng.id).activity) }
  const boxes = ['Running: npm test', 'Waiting its turn to run tests', 'Waiting its turn to run tests']
  assert.deepEqual(await said(), boxes)

  await hq.down()
  qFirst.kill(); await qFirst.out // q's hook will ask again only after r's has (here: a new one for the same command, started once r's has asked)
  await hq.up()
  const back = await waitFor('the turns read back', async () => (await events('turns.read_back')).find((e) => e.waiting.includes(`eng ${q.t.key}`)))
  assert.deepEqual([back.running, back.waiting], [[`eng ${p.t.key}`], [`eng ${q.t.key}`, `eng ${r.t.key}`]])
  // Bug 186: the boxes say again what runs and who waits. p's and q's from what HQ kept: p's hook was answered long ago, and q's is gone
  assert.deepEqual(await said(), boxes)
  await waitFor('r asking again', async () => await asked('o3') === 2)
  const qRun = hookRun(q.hook, pre('o2'))
  await waitFor('q asking again', async () => await asked('o2') === 2)
  assert.equal(await pendingAfter(Promise.race([qRun.out, rRun.out]), 1500), true) // p's run still holds the turn: neither began
  await ended(p.eng.id, 'o1')
  assert.equal(await qRun.out, '{}') // q waited longest: it goes first…
  assert.equal(await pendingAfter(rRun.out, 1500), true) // …and r waits for it, though r asked again first
  await ended(q.eng.id, 'o2'); assert.equal(await rRun.out, '{}')
  await ended(r.eng.id, 'o3')
})

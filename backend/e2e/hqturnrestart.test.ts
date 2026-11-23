// Bugs 309, 312 end to end (see harness.ts): HQ's own test of a finished ticket waits its turn behind an engineer's test run. Its wait reaches the
// ticket's engineer's Events tab (309: it carried no ticket, so no tab had it), and after a backend restart it keeps its place in the line ahead of an
// engineer who asked after it (312: the read-back engineer went first and HQ's test waited behind it).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, pending, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_AUTO_SOON_MS: '100', HQ_AUTO_TICK_MS: '500' } }) })
after(async () => { await hq?.stop() })

test('HQ\'s test waiting its turn shows on its ticket\'s Events tab and keeps its place in the line across a restart', async () => {
  const HELD = 'until [ -f go ]; do sleep 0.2; done', dir = hq.repo('b309x')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'b309x', private: true, scripts: { test: 'node --test' } }))
  fs.mkdirSync(path.join(dir, 'test')); fs.writeFileSync(path.join(dir, 'test', 'ok.test.js'), "require('node:test').test('ok',()=>{})\n"); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
  await hq.api('settings', { key: 'concurrency_cap', value: 3 })
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: 'Watering', request: 'Remind me to water' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  await hq.api(`repos/${repo.id}/test-cmd`, { cmd: HELD })
  assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  const ticket = async (title: string) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.`, depends_on: [] })).json
  const t1 = await ticket('One'), t2 = await ticket('Two'), t3 = await ticket('Three')
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Split done.' })
  const engineer = (t: any) => waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id
    && a.status === 'working'), 30_000)
  const e1 = await engineer(t1), e2 = await engineer(t2), e3 = await engineer(t3)
  const shown = async (): Promise<string> => (await hq.state()).testRuns.map((r: any) => `${r.ticket_id ?? 'main'}:${r.state}`).join(' ')
  const onPage = (want: string) => waitFor(`the page to say "${want}"`, async () => (await shown()) === want, 40_000)
  const letGo = () => waitFor("HQ's test checkout", () => { // HQ's run of the held command ends
    const d = path.join(dir, '.claude', 'worktrees'), [x] = fs.existsSync(d) ? fs.readdirSync(d).filter((y) => y.startsWith('hq-test-')) : []
    if (!x) return false
    fs.writeFileSync(path.join(d, x, 'go'), ''); return true
  })
  await onPage('main:running'); await letGo(); await onPage('') // main's test as the run starts
  const activity = async (a: any): Promise<string> => (await hq.state()).agents.find((x: any) => x.id === a.id)?.activity ?? ''
  const tab = async (a: any): Promise<string[]> => ((await hq.api(`agents/${a.id}/events`)).json.events as any[]).map((e) => e.text)
  const npmTest = (a: any, use: string) => hq.hook(a.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: use, tool_input: { command: 'npm test' } })

  await hq.hook(e2.id, { hook_event_name: 'UserPromptSubmit', prompt: 'run the tests' }); assert.deepEqual(await npmTest(e2, 'g2'), {}) // e2 has the turn
  await hq.hook(e1.id, exitPlanMode(`Plan for ${t1.key}`))
  const wt = path.join(dir, '.claude', 'worktrees', t1.key); fs.writeFileSync(path.join(wt, 'one.js'), '1\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'one')
  await hq.mcp(e1.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(e1.id, 'open_pr', { title: 'One', body: 'One.\n\n## Deviations from approved plan\nNone\n\n## Tests left out\nNothing', feature_map_unchanged: true })
  assert.equal(r.isError, false, r.text)
  await onPage(`${t1.id}:waiting`)
  // Bug 309: the ticket's engineer's Events tab says HQ's test waits, and behind whom; the tab of the engineer it waits behind doesn't
  const waits = `HQ's test of ${t1.key} waits its turn behind eng ${t2.key}`
  await waitFor(`"${waits}" on ${t1.key}'s Events tab`, async () => (await tab(e1)).includes(waits))
  assert.ok(!(await tab(e2)).some((x) => x.includes(`HQ's test of ${t1.key}`)))
  await hq.hook(e3.id, { hook_event_name: 'UserPromptSubmit', prompt: 'run the tests' })
  const held = npmTest(e3, 'g3').catch(() => 'dropped') // e3 asks after HQ's test
  await waitFor('e3 in line', async () => (await activity(e3)).startsWith('Waiting its turn'))
  assert.ok(await pending(held))

  // Bug 312: the backend restarts; e3's hook asks again (turnwait.mjs does, every second), and auto mode starts HQ's test again
  await hq.down(); await hq.up()
  const back = ((await hq.api('events?limit=500')).json as any[]).find((e) => e.kind === 'turns.read_back')
  assert.deepEqual(JSON.parse(back.payload).waiting, [`HQ's test of ${t1.key}`, `eng ${t3.key}`], 'read back in the order they asked')
  const again = npmTest(e3, 'g3').catch(() => 'dropped')
  await onPage(`${t1.id}:waiting`); assert.ok(await pending(again))
  await hq.hook(e2.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'g2', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } })
  await onPage(`${t1.id}:running`) // HQ's test goes first, as before the restart…
  await waitFor('e3 behind HQ\'s test', async () => (await activity(e3)) === `Waiting its turn to run tests behind HQ's test of ${t1.key}`)
  assert.ok(await pending(again)) // …and e3 waits behind it
  await letGo(); assert.deepEqual(await again, {}) // e3's turn once HQ's test is done
  await waitFor(`${t1.key} merged`, async () => (await hq.state()).tickets.find((x: any) => x.id === t1.id)?.status === 'merged', 30_000)
  assert.ok((await tab(e1)).some((x) => new RegExp(`^HQ's test of ${t1.key} started after waiting \\d+ s$`).test(x)), (await tab(e1)).join('\n'))
  await hq.hook(e3.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'g3', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } })
})

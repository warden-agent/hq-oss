// Bug 162 end to end (local repo, auto mode off): an engineer that ran only its own test file can't finish its ticket. open_pr names the
// project's test command; after a run of it, an edit in the worktree asks for another run, and the before_pr handoff has to come after the run.
// The test acts as the engineer (fake Claude Code); see harness.ts.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

const BODY = { title: 'Totals', body: 'Adds totals.\n\n## Deviations from approved plan\nNone' }
const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
/** A Bash call that is over, as Claude Code's hooks send it: ran (exit 0), or failed with `error`. */
const bash = (e: any, command: string, error?: string) => hq.hook(e.id, { hook_event_name: error === undefined ? 'PostToolUse' : 'PostToolUseFailure', tool_name: 'Bash',
  tool_input: { command }, tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, ...(error === undefined ? { tool_response: { stdout: '' } } : { error }) })
const handoff = (e: any) => hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'npm test: 6 pass, 1 fail (formatPrice, already failing on main).' })

test('Bug 162: only its own test file ran, so open_pr is refused until the project\'s test command has run, after the last edit, before the handoff', async () => {
  const dir = hq.repo('shop162')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop162', private: true, scripts: { start: 'node server.js', test: 'node --test' } }))
  fs.mkdirSync(path.join(dir, 'test'))
  for (const f of ['list', 'format']) fs.writeFileSync(path.join(dir, 'test', `${f}.test.js`), `require('node:test').test('${f}', () => {})\n`)
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'two test files')
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: 'shop', request: 'A shopping list' })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Totals', size: 'S', spec: 'Totals. The tests run with npm test.' })).json
  assert.equal((await hq.api(`tickets/${t.id}/launch`, {})).status, 200)
  const e = await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key)
  fs.writeFileSync(path.join(wt, 'list.js'), 'exports.total = () => 0\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'totals')

  await bash(e, 'node --test test/list.test.js'); assert.equal((await handoff(e)).isError, false)
  let r = await hq.mcp(e.id, 'open_pr', BODY)
  assert.equal(r.isError, true); assert.match(r.text, /HQ hasn't seen this project's test command run on .*: npm test\./)
  const was = (await tk(t)).status; assert.ok(!['pr_ready', 'pr_open', 'merged'].includes(was), was)
  const refusals = async () => ((await hq.api(`agents/${e.id}/events`)).json.events as any[]).map((x) => x.text).filter((x: string) => x.includes('as finished (open pr)'))
  assert.deepEqual(await refusals(), [`HQ didn't take ${t.key} as finished (open pr): ${r.text}`]) // Bug 248: on its Events tab, not only in its terminal

  await bash(e, `cd ${JSON.stringify(wt)} && npm test 2>&1 | tail -20`, 'Exit code 1') // it ran, and failed in the other file
  await hq.hook(e.id, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(wt, 'list.js'), old_string: '0', new_string: '1' } })
  r = await hq.mcp(e.id, 'open_pr', BODY); assert.equal(r.isError, true); assert.match(r.text, /You changed files after the last run/)

  await bash(e, 'npm test -- --test-force-exit', 'Exit code 1')
  r = await hq.mcp(e.id, 'open_pr', BODY); assert.equal(r.isError, true); assert.match(r.text, /handoff came before your last run of the test command \(npm test\)/)

  assert.equal((await handoff(e)).isError, false)
  r = await hq.mcp(e.id, 'open_pr', BODY); assert.equal(r.isError, false, r.text)
  assert.equal((await refusals()).length, 3) // one line per refusal above; the call that went through adds none
  await waitFor(`${t.key} finished`, async () => ['pr_ready', 'pr_open', 'merged'].includes((await tk(t)).status))
})

test('what it must not catch: a project with no tests HQ can find finishes as before', async () => {
  const dir = hq.repo('notests162')
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: 'nt', request: 'Something' })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Thing', size: 'S', spec: 'Thing.' })).json
  assert.equal((await hq.api(`tickets/${t.id}/launch`, {})).status, 200)
  const e = await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key)
  fs.writeFileSync(path.join(wt, 'version.txt'), 'v2\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'v2')
  assert.equal((await handoff(e)).isError, false)
  const r = await hq.mcp(e.id, 'open_pr', BODY); assert.equal(r.isError, false, r.text)
})

/** Bug 194: HQ has kept what the worktree held after the last run of the test command (the engineer's next command comes after that). */
const stateKept = (e: any) => waitFor('the run\'s worktree state', async () => {
  const db = new DatabaseSync(path.join(hq.hqHome, 'hq.sqlite'), { readOnly: true })
  try { return (db.prepare(`SELECT json_extract(payload, '$.tree') AS tree FROM events WHERE agent_id = ? AND json_extract(payload, '$.suite') IS NOT NULL
    ORDER BY id DESC LIMIT 1`).get(e.id) as { tree: string | null } | undefined)?.tree } finally { db.close() }
})

test('Bug 194: a sed -i through Bash after the run asks for another run; reading files and committing what the run saw don\'t', async () => {
  const dir = hq.repo('shop194')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop194', private: true, scripts: { test: 'node --test' } }))
  fs.writeFileSync(path.join(dir, 'list.js'), 'exports.total = () => 0\n'); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'start')
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: 'shop', request: 'A shopping list' })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Totals', size: 'S', spec: 'Totals.' })).json
  assert.equal((await hq.api(`tickets/${t.id}/launch`, {})).status, 200)
  const e = await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key)
  fs.writeFileSync(path.join(wt, 'list.js'), 'exports.total = (xs) => xs.length\n')
  await bash(e, 'npm test'); await stateKept(e); assert.equal((await handoff(e)).isError, false)
  await bash(e, 'cat list.js; git diff --stat') // only reading
  sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'totals') // commits what the run saw: no file changes
  const js = path.join(wt, 'list.js'); fs.writeFileSync(js, fs.readFileSync(js, 'utf8').replace('length', 'length + 0')) // what sed -i does
  await bash(e, "sed -i 's/length/length + 0/' list.js")
  let r = await hq.mcp(e.id, 'open_pr', BODY); assert.equal(r.isError, true, 'the sed -i is a change'); assert.match(r.text, /You changed files after the last run/)

  sh(wt, 'commit', '-qam', 'plus zero'); await bash(e, 'npm test 2>&1 | tail -5'); await stateKept(e); assert.equal((await handoff(e)).isError, false)
  await bash(e, 'cat list.js && git log --oneline'); sh(wt, 'commit', '-q', '--allow-empty', '-m', 'nothing')
  r = await hq.mcp(e.id, 'open_pr', BODY); assert.equal(r.isError, false, r.text)
  await waitFor(`${t.key} finished`, async () => ['pr_ready', 'pr_open', 'merged'].includes((await tk(t)).status))
})

/** Bug 213: what HQ kept on a Bash call's PreToolUse event (`before`: the worktree's state before the line started). */
const keptBefore = (e: any, use: string) => {
  const db = new DatabaseSync(path.join(hq.hqHome, 'hq.sqlite'), { readOnly: true })
  try { return (db.prepare(`SELECT json_extract(payload, '$.before') AS b FROM events WHERE agent_id = ? AND kind = 'hook.PreToolUse:Bash'
    AND json_extract(payload, '$.use') = ?`).get(e.id, use) as { b: string | null } | undefined)?.b ?? null } finally { db.close() }
}
test('Bug 213: `npm test && sed -i … && git commit` in one Bash line asks for a run on a line of its own; an ordinary run doesn\'t', async () => {
  const dir = hq.repo('shop213')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop213', private: true, scripts: { test: 'node --test' } }))
  fs.writeFileSync(path.join(dir, 'list.js'), 'exports.total = (xs) => xs.length\n'); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'start')
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: 'shop', request: 'A shopping list' })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Totals', size: 'S', spec: 'Totals.' })).json
  assert.equal((await hq.api(`tickets/${t.id}/launch`, {})).status, 200)
  const e = await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key)
  /** One Bash call as Claude Code makes it: its PreToolUse (the line starts once HQ answers), the line itself (`does`), then its PostToolUse. */
  const line = async (command: string, use: string, does = () => {}) => {
    const pre = await hq.hook(e.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: use })
    assert.deepEqual(pre, {}, 'the line goes ahead'); const before = keptBefore(e, use) // read as soon as HQ answered
    does(); await hq.hook(e.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: use, tool_response: { stdout: '' } })
    await stateKept(e); return before
  }
  const one = "npm test && sed -i 's/length/length ^ 0/' list.js && git commit -qam e"
  const js = path.join(wt, 'list.js')
  assert.ok(await line(one, 'toolu_213a', () => { fs.writeFileSync(js, fs.readFileSync(js, 'utf8').replace('length', 'length ^ 0')); sh(wt, 'commit', '-qam', 'e') }),
    'HQ kept what the worktree held before the line, before it answered')
  assert.equal((await handoff(e)).isError, false)
  let r = await hq.mcp(e.id, 'open_pr', BODY); assert.equal(r.isError, true, 'the sed -i in the same line is a change the tests may not have seen')
  assert.match(r.text, /had `sed -i 's\/length\/length \^ 0\/' list\.js` after it in the same Bash line, and the files changed during that line/)
  assert.match(r.text, /npm test, on a Bash line of its own/)

  assert.equal(await line('npm test 2>&1 | tail -5', 'toolu_213b'), null, 'an ordinary run: nothing kept before it, and no wait')
  assert.equal((await handoff(e)).isError, false)
  r = await hq.mcp(e.id, 'open_pr', BODY); assert.equal(r.isError, false, r.text)
  await waitFor(`${t.key} finished`, async () => ['pr_ready', 'pr_open', 'merged'].includes((await tk(t)).status))
})

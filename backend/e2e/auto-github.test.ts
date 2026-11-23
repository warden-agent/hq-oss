// Auto mode on a GitHub repo (no network: see github-merge.test.ts): a finished ticket is tested on origin/main, merged through a PR
// as HQ's account, and a merge GitHub refuses stops the project with GitHub's reason.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq, bin: string, state: string
before(async () => {
  bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-agh-'))); state = path.join(bin, 'gh-state.json')
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dirname, 'fake-gh.mjs'))} "$@"\n`, { mode: 0o755 })
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, HQ_AUTO_SOON_MS: '100', HQ_AUTO_TICK_MS: '500' } })
})
after(async () => { await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })
const gh = { read: () => JSON.parse(fs.readFileSync(state, 'utf8')), write: (s: unknown) => fs.writeFileSync(state, JSON.stringify(s)) }

test('GitHub: tested on origin/main, merged through a PR; a refused merge stops the project until Resume', async () => {
  const dir = hq.repo('agh'), bare = path.join(hq.root, 'bare', 'agh.git')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agh', private: true, scripts: { test: 'node --test' } }))
  fs.mkdirSync(path.join(dir, 'test')); fs.writeFileSync(path.join(dir, 'test', 'ok.test.js'), "require('node:test').test('ok',()=>{})\n"); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
  sh(hq.root, 'clone', '-q', '--bare', dir, bare)
  gh.write({ prs: {}, next: 1, bares: { 'e2e/agh': bare } })
  sh(dir, 'remote', 'add', 'origin', 'git@github.com:e2e/agh.git')
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}"]\n\tinsteadOf = https://github.com/e2e/agh.git\n`)
  const repo = (await hq.api('repos', { path: dir })).json; assert.equal(repo.kind, 'github')
  const f = (await hq.api('features', { repoId: repo.id, title: 'agh', request: 'Build' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  await hq.api(`repos/${repo.id}/auto`, { on: true })
  const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
  const finish = async (title: string) => {
    const t = (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
    await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
    const e = await waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
    await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'more to come' }) // the TPM is busy, so the merge doesn't end the run: both tickets are one run, whatever the timing
    await hq.hook(e.id, exitPlanMode('Plan'))
    const wt = path.join(dir, '.claude', 'worktrees', t.key); fs.writeFileSync(path.join(wt, `${title}.txt`), 'x\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', title)
    await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
    const r = await hq.mcp(e.id, 'open_pr', { title, body: `${title}.\n\n## Deviations from approved plan\nNone` }); assert.equal(r.isError, false, r.text)
    return t
  }
  const t1 = await finish('one')
  await waitFor('the merge', async () => (await tk(t1))?.status === 'merged', 15_000)
  assert.equal((await tk(t1)).pr_state, 'merged'); assert.ok(sh(bare, 'ls-tree', '--name-only', 'main').includes('one.txt'))
  assert.deepEqual(gh.read().mergeShas, [(await tk(t1)).finished_sha], 'GitHub merges only the commit HQ tested (Bug 143)')

  gh.write({ ...gh.read(), refuseMerge: 'Required status check "ci" is expected' })
  const t2 = await finish('two')
  const why = await waitFor('the stop', async () => (await hq.state()).repos.find((r: any) => r.id === repo.id).auto_stopped_why, 15_000)
  assert.match(why, /Required status check/); assert.notEqual((await tk(t2)).status, 'merged')
  gh.write({ ...gh.read(), refuseMerge: undefined })
  await hq.api(`repos/${repo.id}/auto-resume`, {})
  await waitFor('the merge after Resume', async () => (await tk(t2))?.status === 'merged', 15_000)

  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
  const run = await waitFor('the run to finish', async () => (await hq.state()).autoRuns.find((r: any) => r.status === 'finished'), 15_000)
  const undone = await hq.api(`auto-runs/${run.id}/undo`, {}); assert.equal(undone.status, 200, JSON.stringify(undone.json))
  const files = sh(bare, 'ls-tree', '--name-only', 'main'); assert.ok(!files.includes('one.txt') && !files.includes('two.txt'), files)
})

// Bug 184: on GitHub the merge takes a while (a push, the PR, GitHub's merge). A commit that reaches the branch meanwhile can't keep the ticket open, as GitHub
// has merged its PR: HQ names it, to the TPM and the user, instead of leaving it on the branch unsaid.
test('GitHub: a commit that lands while GitHub merges is named to the TPM and the user, not left on the branch unsaid', async () => {
  const dir = hq.repo('agl'), bare = path.join(hq.root, 'bare', 'agl.git')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agl', private: true, scripts: { test: 'node --test' } }))
  fs.mkdirSync(path.join(dir, 'test')); fs.writeFileSync(path.join(dir, 'test', 'ok.test.js'), "require('node:test').test('ok',()=>{})\n"); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
  sh(hq.root, 'clone', '-q', '--bare', dir, bare)
  gh.write({ prs: {}, next: 1, bares: { 'e2e/agl': bare } })
  sh(dir, 'remote', 'add', 'origin', 'git@github.com:e2e/agl.git')
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}"]\n\tinsteadOf = https://github.com/e2e/agl.git\n`)
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: 'agl', request: 'Build' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  await hq.api(`repos/${repo.id}/auto`, { on: true })
  const t = (await hq.api('tickets', { featureId: f.id, title: 'one', size: 'S', spec: 'one.' })).json
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
  const e = await waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  await hq.hook(e.id, exitPlanMode('Plan'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key); fs.writeFileSync(path.join(wt, 'one.txt'), 'x\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'one')
  const first = sh(wt, 'rev-parse', 'HEAD'), q = JSON.stringify
  gh.write({ ...gh.read(), beforeMerge: `cd ${q(wt)} && echo late > late.txt && git add late.txt && git commit -qm 'late fix'` })
  await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(e.id, 'open_pr', { title: 'one', body: 'one.\n\n## Deviations from approved plan\nNone' }); assert.equal(r.isError, false, r.text)
  const heard = await waitFor('the TPM to hear', async () => (await hq.state()).messages.find((m: any) => m.to_id === tpm.id && /got a commit after that/.test(m.body)), 15_000)
  const late = sh(wt, 'rev-parse', 'HEAD'), tk = (await hq.state()).tickets.find((x: any) => x.id === t.id); assert.notEqual(late, first)
  assert.equal(heard.body, `HQ: ${t.key} merged as HQ tested it, but ${tk.branch} got a commit after that, while it merged, which isn't in main: "${late.slice(0, 7)} late fix". `
    + `If it's still wanted, make a ticket for it: its engineer can bring it in with git cherry-pick ${first.slice(0, 7)}..${late.slice(0, 7)}.`)
  assert.equal(tk.status, 'merged'); assert.deepEqual(gh.read().mergeShas, [first])
  assert.ok(!sh(bare, 'ls-tree', '--name-only', 'main').includes('late.txt'), 'GitHub merged only what HQ tested')
  const att = (await hq.state()).attention.find((a: any) => a.kind === 'left_behind' && a.ticket_id === t.id && !a.resolved_at)
  assert.ok(att, 'the user sees it too'); assert.match(att.detail, /^agl: .+ It is still on its branch\.$/)
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'ok' }) // the run ends: its summary says so too
  const run = await waitFor('the run to finish', async () => (await hq.state()).autoRuns.find((x: any) => x.repo_id === repo.id && x.status === 'finished'), 15_000)
  assert.match(run.summary, new RegExp(`## Worth a look\\n- ${t.key}: a commit made while it merged isn't in main: it is still on ${tk.branch}`))
})

// Bug 209: a PR HQ opens on auto is one HQ tests and merges, so the TPM hears that, not "The user merges it". A ticket finished with auto off, waiting for the user.
const finishedByHand = async (name: string) => {
  const dir = hq.repo(name), bare = path.join(hq.root, 'bare', `${name}.git`)
  sh(hq.root, 'clone', '-q', '--bare', dir, bare)
  gh.write({ prs: {}, next: 1, bares: { [`e2e/${name}`]: bare } })
  sh(dir, 'remote', 'add', 'origin', `git@github.com:e2e/${name}.git`)
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}"]\n\tinsteadOf = https://github.com/e2e/${name}.git\n`)
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: name, request: 'Build' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'one', size: 'S', spec: 'one.' })).json
  await hq.api(`tickets/${t.id}/launch`, {})
  const e = await waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key); fs.writeFileSync(path.join(wt, 'one.txt'), 'x\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'one')
  await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(e.id, 'open_pr', { title: 'one', body: 'one.\n\n## Deviations from approved plan\nNone' }); assert.equal(r.isError, false, r.text)
  const toTpm = async (): Promise<string[]> => (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === tpm.id).map((m: any) => m.body) // newest first
  return { dir, repo, t, toTpm, tk: async () => (await hq.state()).tickets.find((x: any) => x.id === t.id) }
}

// The user's Make PR lands just after auto went on (the box still showed it). HELD keeps HQ's test of the ticket going meanwhile.
test('GitHub on auto: a PR HQ opens for a finished ticket is told to the TPM as one HQ tests and merges', async () => {
  const { dir, repo, t, toTpm, tk } = await finishedByHand('agp'), manual = (await toTpm()).length
  const running = async () => (await hq.state()).testRuns.some((x: any) => x.ticket_id === t.id && x.what === 'ticket' && x.state === 'running')
  assert.equal((await hq.api(`repos/${repo.id}/test-cmd`, { cmd: 'until [ -f go ]; do sleep 0.1; done' })).status, 200)
  assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  await waitFor(`HQ's test of ${t.key}`, running, 20_000)
  assert.equal((await hq.api(`tickets/${t.id}/make-pr`, {})).status, 200)
  const x = await tk(); assert.deepEqual([x.status, x.pr_state], ['pr_open', 'open'])
  const told = (await toTpm()).find((b) => b.startsWith(`HQ: PR #${x.pr_number} is open`))
  assert.equal(told, `HQ: PR #${x.pr_number} is open for ${t.key} (${x.branch}). HQ tests it on origin/main and merges it; you'll be told when it merges.`)
  const d = path.join(dir, '.claude', 'worktrees'); fs.writeFileSync(path.join(d, fs.readdirSync(d).find((n) => n.startsWith('hq-test-'))!, 'go'), '')
  await waitFor('the merge', async () => (await tk())?.status === 'merged', 20_000)
  assert.deepEqual([(await tk()).pr_number, gh.read().merged], [x.pr_number, [x.pr_number]], 'HQ merged the PR it opened')
  const onAuto = (await toTpm()).slice(0, -manual) // what HQ said once auto was on
  assert.ok(!onAuto.some((b) => /The user (merges|opens|tries)/.test(b)), onAuto.join('\n'))
})

// What the fix must not catch: auto mode stopped (here at GitHub's refusal of the PR HQ opens to merge it) leaves the merge to the user until Resume, as the board does (Bug 193).
test('GitHub on auto, stopped: the PR the watcher opens after a refusal is the user\'s to merge until Resume', async () => {
  const { repo, t, toTpm, tk } = await finishedByHand('ags')
  gh.write({ ...gh.read(), refuseCreate: 'Resource not accessible by integration' })
  const refused = await hq.api(`tickets/${t.id}/make-pr`, {}); assert.equal(refused.status, 409); assert.equal((await tk()).pr_state, 'not_opened')
  assert.match(refused.json.error, /Create PR ↗ on its box opens GitHub's own form/) // the link the box now has (Bug 244)
  assert.match((await tk()).pr_url, /compare/)
  assert.equal((await hq.api(`repos/${repo.id}/test-cmd`, { cmd: 'true' })).status, 200)
  assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  const why = await waitFor('the stop', async () => (await hq.state()).repos.find((r: any) => r.id === repo.id).auto_stopped_why, 15_000)
  assert.match(why, /^HQ couldn't open a PR to merge/) // HQ's own try as it merges, not the refused Make PR's notice (Bug 247)
  gh.write({ ...gh.read(), refuseCreate: undefined })
  await hq.api(`repos/${repo.id}/sync`, {}) // repo.synced: the watcher tries the PR again
  const x = await waitFor('the PR', async () => { const y = await tk(); return y?.status === 'pr_open' && y }, 15_000)
  assert.equal((await toTpm()).find((b) => b.startsWith(`HQ: PR #${x.pr_number} is open`)),
    `HQ: PR #${x.pr_number} is open for ${t.key} (${x.branch}). The user merges it; you'll be told when it merges.`)
  assert.equal((await hq.api(`repos/${repo.id}/auto-resume`, {})).status, 200)
  await waitFor('the merge after Resume', async () => (await tk())?.status === 'merged', 20_000)
  assert.deepEqual(gh.read().merged, [x.pr_number])
})

// Bug 247: a Make PR GitHub refused left its notice open, and auto mode stopped on that notice at once, again after every Resume, until the PR was opened: HQ never
// looked again. On auto HQ opens the PR itself as it merges, so the old notice stops nothing: HQ's own try does, with GitHub's reason, and each Resume tries again.
test('Bug 247: a refused Make PR doesn\'t stop auto mode by itself; HQ\'s own try does, and Resume tries again', async () => {
  const { repo, t, tk } = await finishedByHand('agq')
  gh.write({ ...gh.read(), refuseCreate: 'Resource not accessible by integration' })
  assert.equal((await hq.api(`tickets/${t.id}/make-pr`, {})).status, 409); assert.equal((await tk()).pr_state, 'not_opened')
  const tries = () => fs.readFileSync(`${state}.log`, 'utf8').split('\n').filter((l) => l.includes('"POST"') && l.includes('/pulls"')).length, made = tries()
  const stopped = () => waitFor('the stop', async () => (await hq.state()).repos.find((r: any) => r.id === repo.id).auto_stopped_why, 20_000)
  assert.equal((await hq.api(`repos/${repo.id}/test-cmd`, { cmd: 'true' })).status, 200)
  assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  assert.match(await stopped(), new RegExp(`^HQ couldn't open a PR to merge ${t.key}: .*can't open PRs on e2e/agq`), 'HQ tried, and says GitHub\'s reason')
  assert.equal(tries(), made + 1, 'HQ itself asked GitHub for the PR')
  assert.equal((await hq.api(`repos/${repo.id}/auto-resume`, {})).status, 200) // GitHub still refuses: HQ looks again, and stops again
  await waitFor('a second try', async () => tries() === made + 2, 20_000); assert.match(await stopped(), /can't open PRs/)
  gh.write({ ...gh.read(), refuseCreate: undefined })
  assert.equal((await hq.api(`repos/${repo.id}/auto-resume`, {})).status, 200) // at once, before the watcher's next look
  await waitFor('the merge after Resume', async () => (await tk())?.status === 'merged', 20_000)
  assert.equal(gh.read().merged.length, 1)
  assert.ok(!(await hq.state()).attention.some((a: any) => a.ticket_id === t.id && a.kind === 'pr_failed' && !a.resolved_at), 'the old notice went with the merge')
})
// What the notice tells the user to do: open the PR by hand with its link. HQ's own tries are still refused; Resume merges the PR the user opened.
test('Bug 247: a PR the user opened by hand after a refused Make PR is merged after Resume, though GitHub still refuses HQ\'s own', async () => {
  const { repo, t, tk } = await finishedByHand('agh2')
  gh.write({ ...gh.read(), refuseCreate: 'Resource not accessible by integration' })
  assert.equal((await hq.api(`tickets/${t.id}/make-pr`, {})).status, 409)
  assert.equal((await hq.api(`repos/${repo.id}/test-cmd`, { cmd: 'true' })).status, 200)
  assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  await waitFor('the stop', async () => (await hq.state()).repos.find((r: any) => r.id === repo.id).auto_stopped_why, 20_000)
  const s = gh.read(), branch = (await tk()).branch
  gh.write({ ...s, prs: { ...s.prs, [branch]: [{ number: 41, url: 'https://github.com/e2e/agh2/pull/41', state: 'OPEN', mergeable: 'MERGEABLE' }] } })
  assert.equal((await hq.api(`repos/${repo.id}/auto-resume`, {})).status, 200)
  await waitFor('the merge after Resume', async () => (await tk())?.status === 'merged', 20_000)
  assert.deepEqual([(await tk()).pr_number, gh.read().merged], [41, [41]], 'HQ merged the PR the user opened')
})
// Bug 265: the user opened the PR by hand after GitHub refused HQ's (the notice says to); the watcher sees it open, so the notice that says to open it goes too.
test('Bug 265: a PR the user opened by hand after a refused Make PR takes down "Open it yourself"', async () => {
  const { repo, t, tk } = await finishedByHand('agm')
  gh.write({ ...gh.read(), refuseCreate: 'Resource not accessible by integration' })
  assert.equal((await hq.api(`tickets/${t.id}/make-pr`, {})).status, 409)
  const open = async () => (await hq.state()).attention.find((a: any) => a.ticket_id === t.id && a.kind === 'pr_failed' && !a.resolved_at)
  assert.match((await open())?.detail ?? '', /Open it yourself/)
  const s = gh.read(), branch = (await tk()).branch
  gh.write({ ...s, prs: { ...s.prs, [branch]: [{ number: 52, url: 'https://github.com/e2e/agm/pull/52', state: 'OPEN', mergeable: 'MERGEABLE' }] } })
  assert.equal((await hq.api(`repos/${repo.id}/sync`, {})).status, 200) // Sync: the watcher looks at once
  await waitFor('the PR seen', async () => (await tk())?.status === 'pr_open', 15_000)
  await waitFor('the notice to go', async () => !(await open()), 5_000)
  assert.deepEqual([(await tk()).pr_number, (await tk()).pr_state], [52, 'open'])
})

// Bug 266: a push GitHub refused leaves a push_failed notice, which stops auto mode. Once a later push of the same ticket goes through, the notice is moot:
// it goes, and Resume goes on (before, it stopped auto again at every Resume until someone ticked it off or the ticket merged).
test('Bug 266: a refused push\'s notice goes with the next good push, and Resume goes on', async () => {
  const dir = hq.repo('agr'), bare = path.join(hq.root, 'bare', 'agr.git')
  sh(hq.root, 'clone', '-q', '--bare', dir, bare)
  gh.write({ prs: {}, next: 1, bares: { 'e2e/agr': bare } })
  sh(dir, 'remote', 'add', 'origin', 'git@github.com:e2e/agr.git')
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}"]\n\tinsteadOf = https://github.com/e2e/agr.git\n`)
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: 'agr', request: 'Build' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  assert.equal((await hq.api(`repos/${repo.id}/test-cmd`, { cmd: 'true' })).status, 200)
  await hq.api(`repos/${repo.id}/auto`, { on: true })
  const t = (await hq.api('tickets', { featureId: f.id, title: 'one', size: 'S', spec: 'one.' })).json
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
  const e = await waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  await hq.hook(e.id, exitPlanMode('Plan'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key); fs.writeFileSync(path.join(wt, 'one.txt'), 'x\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'one')
  const hook = path.join(bare, 'hooks', 'pre-receive') // GitHub refusing the push, as for an account without Write access
  fs.writeFileSync(hook, '#!/bin/sh\necho "remote: Permission to e2e/agr.git denied to warden-agent." >&2\nexit 1\n', { mode: 0o755 })
  await hq.hook(e.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'true' }, tool_use_id: `toolu_${e.id}_1` })
  await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const pr = () => hq.mcp(e.id, 'open_pr', { title: 'one', body: 'one.\n\n## Deviations from approved plan\nNone', feature_map_unchanged: true })
  const refused = await pr(); assert.equal(refused.isError, true); assert.match(refused.text, /HQ could not push/)
  const notice = async () => (await hq.state()).attention.find((a: any) => a.ticket_id === t.id && a.kind === 'push_failed' && !a.resolved_at)
  assert.ok(await notice(), 'the user is told')
  const stopped = () => waitFor('the stop', async () => (await hq.state()).repos.find((r: any) => r.id === repo.id).auto_stopped_why, 15_000)
  assert.match(await stopped(), /can't push to e2e\/agr/)
  fs.rmSync(hook) // the user gave the account Write access; the engineer is told and calls open_pr again
  const ok = await pr(); assert.equal(ok.isError, false, ok.text)
  assert.equal(await notice(), undefined, 'the good push takes the notice down')
  assert.equal((await hq.api(`repos/${repo.id}/auto-resume`, {})).status, 200)
  await waitFor('the merge after Resume', async () => (await hq.state()).tickets.find((x: any) => x.id === t.id)?.status === 'merged', 20_000)
  assert.equal((await hq.state()).repos.find((r: any) => r.id === repo.id).auto_stopped_why, null)
})

// Bug 280: HQ's own PR try on auto was refused, auto stopped with "HQ couldn't open a PR to merge T-01", but the ticket stayed `waiting`, so the box offered a
// Make PR that failed once more before the link came. The ticket now lands as after a refused Make PR: `not_opened` with GitHub's form, Create PR ↗ on the box.
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files (as src/prformlink.test.ts)
const boardActs = async (t: any): Promise<string[]> => {
  const { register } = await import('node:module') // the frontend imports its own files without an extension (Vite finds them)
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
    if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
    return next(s, c) }`)}`)
  ;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
  const { mergeActs } = await import(BOARD) as { mergeActs: (t: any, base: string, eng: any) => any[] }
  return mergeActs(t, 'main', null).map((a) => a.kind === 'link' ? `link:${a.label}` : a.kind)
}
test('Bug 280: after HQ\'s own PR try is refused on auto, the ticket is as after a refused Make PR: Create PR ↗ on its box at once', async () => {
  const dir = hq.repo('agx'), bare = path.join(hq.root, 'bare', 'agx.git')
  sh(hq.root, 'clone', '-q', '--bare', dir, bare)
  gh.write({ prs: {}, next: 1, bares: { 'e2e/agx': bare }, refuseCreate: 'Resource not accessible by integration' })
  sh(dir, 'remote', 'add', 'origin', 'git@github.com:e2e/agx.git')
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}"]\n\tinsteadOf = https://github.com/e2e/agx.git\n`)
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: 'agx', request: 'Build' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  assert.equal((await hq.api(`repos/${repo.id}/test-cmd`, { cmd: 'true' })).status, 200)
  assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  const t = (await hq.api('tickets', { featureId: f.id, title: 'one', size: 'S', spec: 'one.' })).json
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
  const e = await waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'more to come' })
  await hq.hook(e.id, exitPlanMode('Plan'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key); fs.writeFileSync(path.join(wt, 'one.txt'), 'x\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'one')
  await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(e.id, 'open_pr', { title: 'one', body: 'one.\n\n## Deviations from approved plan\nNone' }); assert.equal(r.isError, false, r.text)
  const tk = async () => (await hq.state()).tickets.find((x: any) => x.id === t.id)
  const why = await waitFor('the stop', async () => (await hq.state()).repos.find((x: any) => x.id === repo.id).auto_stopped_why, 20_000)
  assert.match(why, new RegExp(`^HQ couldn't open a PR to merge ${t.key}: .*can't open PRs on e2e/agx.*\\. Create PR ↗ on its box opens GitHub's own form, filled in\\.$`))
  const x = await tk() // at once: the stop and the ticket's state come together
  assert.deepEqual([x.status, x.pr_state], ['pr_ready', 'not_opened']); assert.match(x.pr_url, /^https:\/\/github\.com\/e2e\/agx\/compare\/main\.\.\./)
  assert.deepEqual(await boardActs(x), ['merge', 'link:Create PR ↗'], 'the box: Merge into main and GitHub\'s own form, no Make PR')
  const db = hq.db() // the Events tab's record of it
  try {
    const ev = db.prepare("SELECT payload FROM events WHERE kind = 'ticket.merge_refused' AND payload LIKE ?").all(`%${t.id}%`).map((v: any) => JSON.parse(v.payload))
    assert.equal(ev.length, 1); assert.match(ev[0].why, /can't open PRs on e2e\/agx/); assert.equal(ev[0].link, x.pr_url)
  } finally { db.close() }
  // The user's own Merge into main, refused the same way, keeps it so and says the same (the error the page shows)
  const m = await hq.api(`tickets/${t.id}/merge`, {}); assert.equal(m.status, 409)
  assert.match(m.json.error, /^HQ couldn't open a PR to merge .*Create PR ↗ on its box/); assert.equal((await tk()).pr_state, 'not_opened')
  gh.write({ ...gh.read(), refuseCreate: undefined })
  assert.equal((await hq.api(`repos/${repo.id}/auto-resume`, {})).status, 200)
  await waitFor('the merge after Resume', async () => (await tk())?.status === 'merged', 20_000)
  assert.equal(gh.read().merged.length, 1)
})
// What it must not catch: a ticket whose PR was closed on GitHub keeps its "closed" state when HQ's try is refused, and the words name no button it hasn't got.
test('Bug 280: a refused try on a ticket whose PR was closed keeps it closed and names no Create PR ↗', async () => {
  const { repo, t, tk } = await finishedByHand('agc')
  const s = gh.read(), branch = (await tk()).branch
  gh.write({ ...s, refuseCreate: 'Resource not accessible by integration', prs: { ...s.prs, [branch]: [{ number: 9, url: 'https://github.com/e2e/agc/pull/9', state: 'CLOSED' }] } })
  await hq.api(`repos/${repo.id}/sync`, {}) // the watcher reads the closed PR
  await waitFor('the closed PR', async () => (await tk())?.pr_state === 'closed', 15_000)
  const m = await hq.api(`tickets/${t.id}/merge`, {}); assert.equal(m.status, 409)
  assert.match(m.json.error, /^HQ couldn't open a PR to merge .*can't open PRs/); assert.doesNotMatch(m.json.error, /Create PR/)
  const x = await tk(); assert.deepEqual([x.pr_state, x.pr_url], ['closed', 'https://github.com/e2e/agc/pull/9'])
})

// Bug 301: a finished ticket whose PR was closed on GitHub offered only "Create PR ↗", which opened the closed PR; once HQ had opened a PR for it (pr_open),
// a closed one left the box with no button at all. It has no open PR, so Make PR and Merge each open a new one (Make PR pushes the branch first, since GitHub's
// Delete branch sits by a closed PR), and the "closed" notice goes once a new PR is open.
test('Bug 301: a ticket whose PR was closed: Make PR opens a new one (branch pushed again), and Merge merges through a new one', async () => {
  const { repo, t, tk } = await finishedByHand('b301x'), bare = path.join(hq.root, 'bare', 'b301x.git'), branch = (await tk()).branch
  const closedNotice = async () => (await hq.state()).attention.find((a: any) => a.ticket_id === t.id && a.kind === 'pr_closed' && !a.resolved_at)
  const close = (n: number) => { const s = gh.read(); gh.write({ ...s, prs: { ...s.prs, [branch]: (s.prs[branch] ?? []).map((p: any) => p.number === n ? { ...p, state: 'CLOSED' } : p) } }) }
  const s0 = gh.read(); gh.write({ ...s0, next: 10, prs: { [branch]: [{ number: 9, url: 'https://github.com/e2e/b301x/pull/9', state: 'CLOSED' }] } })
  await hq.api(`repos/${repo.id}/sync`, {}) // the watcher reads the closed PR
  await waitFor('the closed PR', async () => (await tk())?.pr_state === 'closed', 15_000)
  let x = await tk(); assert.deepEqual([x.status, x.pr_number], ['pr_ready', 9]); assert.ok(await closedNotice())
  assert.deepEqual(await boardActs(x), ['merge', 'make-pr', 'link:PR #9 ↗'], 'Merge and Make PR, the closed PR as its own link, no Create PR ↗')

  sh(bare, 'branch', '-D', branch) // the user pressed GitHub's Delete branch by the closed PR
  const made = await hq.api(`tickets/${t.id}/make-pr`, {}); assert.equal(made.status, 200, JSON.stringify(made.json))
  x = await tk(); assert.deepEqual([x.status, x.pr_state, x.pr_number], ['pr_open', 'open', 10])
  assert.equal(sh(bare, 'rev-parse', `refs/heads/${branch}`), x.finished_sha, 'the branch is on GitHub again')
  assert.equal(await closedNotice(), undefined, 'a new PR is open: the closed one\'s notice is moot')

  close(10) // closed again, now from pr_open: the box had no button at all
  await hq.api(`repos/${repo.id}/sync`, {})
  await waitFor('the second closed PR', async () => (await tk())?.pr_state === 'closed', 15_000)
  x = await tk(); assert.deepEqual([x.status, x.pr_number], ['pr_open', 10])
  assert.deepEqual(await boardActs(x), ['merge', 'make-pr', 'link:PR #10 ↗'])
  const m = await hq.api(`tickets/${t.id}/merge`, {}); assert.equal(m.status, 200, JSON.stringify(m.json))
  x = await tk(); assert.deepEqual([x.status, x.pr_state, x.pr_number], ['merged', 'merged', 11])
  assert.deepEqual(gh.read().merged, [11]); assert.ok(sh(bare, 'ls-tree', '--name-only', 'main').includes('one.txt'))
})
// Bug 334: finishing again (here a Fix conflicts) set a ticket whose PR was closed back to "waiting", so the watcher saw the same old closed PR as new and raised
// "PR #9 was closed" again after the user had dismissed it. The ticket keeps its closed PR: no notice again, and the box still offers Merge and Make PR.
test('Bug 334: a ticket whose PR was closed, fixed and finished again, doesn\'t raise "PR #9 was closed" again', async () => {
  const { dir, repo, t, tk } = await finishedByHand('b334x'), bare = path.join(hq.root, 'bare', 'b334x.git'), branch = (await tk()).branch
  const closedNotices = async () => (await hq.state()).attention.filter((a: any) => a.ticket_id === t.id && a.kind === 'pr_closed' && !a.resolved_at)
  gh.write({ ...gh.read(), next: 10, prs: { [branch]: [{ number: 9, url: 'https://github.com/e2e/b334x/pull/9', state: 'CLOSED' }] } })
  await hq.api(`repos/${repo.id}/sync`, {})
  await waitFor('the closed PR', async () => (await tk())?.pr_state === 'closed', 15_000)
  const [notice] = await closedNotices(); assert.ok(notice); await hq.api(`attention/${notice.id}/resolve`, {}) // the user dismisses it
  const gc = path.join(hq.root, 'b334x-clone'); sh(hq.root, 'clone', '-q', bare, gc) // main moves on: the same file, other words
  fs.writeFileSync(path.join(gc, 'one.txt'), 'y\n'); sh(gc, 'add', '.'); sh(gc, 'commit', '-qm', 'other one'); sh(gc, 'push', '-q', 'origin', 'main')
  await hq.api(`repos/${repo.id}/sync`, {})
  await waitFor('the conflict', async () => (await tk())?.conflict_files != null, 15_000)
  const r = await hq.api(`tickets/${t.id}/fix-conflicts`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  const e = await waitFor('its engineer', async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key)
  try { sh(wt, 'merge', '--no-edit', 'origin/main') } catch { /* the conflict */ }
  fs.writeFileSync(path.join(wt, 'one.txt'), 'x\ny\n'); sh(wt, 'add', 'one.txt'); sh(wt, 'commit', '--no-edit', '-q')
  const done = await hq.mcp(e.id, 'open_pr', { title: 'one', body: 'one.\n\n## Deviations from approved plan\nNone' }); assert.equal(done.isError, false, done.text)
  const looked = await hq.beat('merges'); await hq.api(`repos/${repo.id}/sync`, {}); await hq.api(`repos/${repo.id}/sync`, {})
  await hq.beats('merges', 2, { from: looked }) // a whole look of the watcher after open_pr
  const x = await tk(); assert.deepEqual([x.status, x.pr_state, x.pr_number, x.conflict_files], ['pr_ready', 'closed', 9, null])
  assert.deepEqual(await closedNotices(), [], 'the closed PR is the one the user already dismissed')
  assert.deepEqual(await boardActs(x), ['merge', 'make-pr', 'link:PR #9 ↗'])
  const m = await hq.api(`tickets/${t.id}/merge`, {}); assert.equal(m.status, 200, JSON.stringify(m.json)) // and Merge still opens a new PR and merges it
  assert.deepEqual([(await tk()).status, gh.read().merged], ['merged', [10]])
})
// The box and the TPM's board say that on auto "HQ opens a new PR and merges it": it does.
test('Bug 301: on auto, a ticket whose PR was closed is merged through a new PR', async () => {
  const { repo, tk } = await finishedByHand('b301y'), branch = (await tk()).branch
  gh.write({ ...gh.read(), next: 10, prs: { [branch]: [{ number: 9, url: 'https://github.com/e2e/b301y/pull/9', state: 'CLOSED' }] } })
  await hq.api(`repos/${repo.id}/sync`, {})
  await waitFor('the closed PR', async () => (await tk())?.pr_state === 'closed', 15_000)
  assert.equal((await hq.api(`repos/${repo.id}/test-cmd`, { cmd: 'true' })).status, 200)
  assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  await waitFor('the merge', async () => (await tk())?.status === 'merged', 20_000)
  assert.deepEqual([(await tk()).pr_number, gh.read().merged], [10, [10]])
})

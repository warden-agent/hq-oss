// The test setup helper (Tester & Checker, Part 3): a one-off Claude Code session (the Launch helper's role and lockdown, its own job, Opus by default) that
// works out how HQ runs the app for scenarios: its production start, where it keeps its state, a clean seed, and what kind of work each API endpoint does
// (testsetupstore.ts). It reads the code in a throwaway worktree and calls save_test_setup; HQ then checks the setup for real in its own test sandbox (a
// scenario: seed, start, open the page, reset, open it again) and messages the helper what happened, until the check passes, the helper calls
// report_cant_test, or it runs out of saves. A setup that passed is used from then on with no tokens, and shown to the user once.
// Engineers change it with update_test_setup when a ticket changes the backend; HQ applies that when the ticket merges, and checks it again.
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS } from './config.ts'
import { getSetting } from './db.ts'
import { emit, type HqEvent } from './events.ts'
import { attention, resolveKind } from './attention.ts'
import { getFeature, getRepo, getTicket, notClearing, type Repo } from './records.ts'
import { getAgent, launchAgent, stopAgent, type Agent } from './agents.ts'
import { git } from './reposync.ts'
import { mergeBase } from './conflicts.ts'
import { ensureFresh } from './repos.ts'
import { excludeHqFolders, listWorktrees, seedPackages } from './worktrees.ts'
import { killUnder } from './procs.ts'
import { sendMessage } from './delivery.ts'
import { runnableRecipe, row, repush, serial } from './preview.ts'
import { runScenario, type ScenarioResult } from './scenario.ts'
import { checkSetup, mergeSetup, readSetup, writeSetup, type SetupFile, type TestSetup } from './testsetupstore.ts'

export const SETUP_SAVES = 4
const notice = (repoId: string, good = false) => `${good ? 'repo_testsetup_ok' : 'repo_testsetup'}:${repoId}`
/** One notice about a project's test setup at a time. A checked, saved setup is good news (green, Bug 251), so it has a kind of its own. */
const tell = (repoId: string, detail: string, good = false): void => { resolveKind(notice(repoId, !good), null); attention(notice(repoId, good), detail) }
const untell = (repoId: string): void => { resolveKind(notice(repoId), null); resolveKind(notice(repoId, true), null) }
/** The setup helper's model: Opus, unless the user has set one for it. */
const model = (): string => (getSetting('models', DEFAULTS.models) as Record<string, string>).test_setup ?? 'opus'
const live = (agentId: string | null | undefined): Agent | undefined => { const a = agentId ? getAgent(agentId) : undefined; return a && a.status !== 'exited' ? a : undefined }
/** The project whose setup this agent works on. */
function repoOfAgent(agentId: string): string | null {
  const a = getAgent(agentId); if (!a?.repo_id) return null
  return readSetup(a.repo_id).job?.agent_id === agentId ? a.repo_id : null
}
const update = (repoId: string, fn: (f: SetupFile) => SetupFile): SetupFile => { const next = fn(readSetup(repoId)); writeSetup(repoId, next); repush(repoId); return next }
/** Is this agent a test setup helper (so the Launch helper's sweep leaves it alone)? */
export const isSetupHelper = (agentId: string): boolean => !!repoOfAgent(agentId)
export const SETUP_WORKTREE = 'testsetup-'

function prompt(repo: Repo, why: 'first' | 'again', current: TestSetup | null): string {
  const recipe = runnableRecipe(row(repo.id), repo.path)!
  return [`Project: ${repo.name}. Your job this time is the TEST SETUP (the "Test setup" section of your instructions), not the start steps.`, '',
    'The start steps HQ uses for the live preview (the parts your setup must cover, by name):',
    JSON.stringify(recipe.parts.map((p) => ({ name: p.name, dir: p.dir, run: p.run, port: p.port })), null, 1),
    ...(why === 'again' && current ? ['', 'The setup HQ has now (the user asked for it to be worked out again; keep what is still right):', JSON.stringify(current, null, 1)] : []),
  ].join('\n')
}

/** Starts the setup helper for this project. One at a time per project: in the preview's queue, so a second click (another tab) finds the first one on it. */
export function startSetupHelper(repoId: string): Promise<ReturnType<typeof setupState>> { return serial(repoId, () => startOne(repoId)) }
async function startOne(repoId: string): Promise<ReturnType<typeof setupState>> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  notClearing(repoId)
  const f = readSetup(repoId)
  if (live(f.job?.agent_id)) return setupState(repoId) // already on it
  if (!runnableRecipe(row(repoId), repo.path)) throw new Error(`HQ doesn't know how to start ${repo.name} yet. Launch it once first; testing starts the app the same way.`)
  if (repo.empty) throw new Error(`${repo.name} has nothing on ${repo.default_branch} to test yet.`)
  if (f.job?.worktree) await removeWorktree(repo.path, f.job.worktree)
  const name = `${SETUP_WORKTREE}${Date.now().toString(36)}`, wt = path.join(repo.path, '.claude', 'worktrees', name)
  await git(repo.path, ['worktree', 'add', '-q', '-b', `hq-testsetup/${name}`, wt, mergeBase(repo).name])
  await excludeHqFolders(repo.path)
  await seedPackages(repo.path, wt).catch(() => [])
  untell(repoId)
  let a: Agent
  try {
    a = await launchAgent({ role: 'launcher', repoId, model: model(), cwd: repo.path, displayName: `test setup ${repo.name}`, worktreeName: name,
      launchPrompt: prompt(repo, f.setup ? 'again' : 'first', f.setup), localOnly: true }) // localhost only: it reads code and tries commands, it downloads nothing
  } catch (e) { await removeWorktree(repo.path, wt); throw e }
  update(repoId, (x) => ({ ...x, job: { agent_id: a.id, worktree: wt, saves: 0, state: 'working', started_at: Date.now() }, ended: null }))
  emit({ agentId: a.id, source: 'system', kind: 'testsetup.helper_started', payload: { repo: repo.name } })
  return setupState(repoId)
}
export const setupState = (repoId: string) => readSetup(repoId)

/** The helper is done (or gone): stop it and delete its worktree. `ended`: what the pane says next (null: nothing). */
export async function finishSetup(repoId: string, ended: SetupFile['ended']): Promise<void> {
  const f = readSetup(repoId), repo = getRepo(repoId); if (!repo) return
  update(repoId, (x) => ({ ...x, job: null, ended }))
  if (live(f.job?.agent_id)) await stopAgent(f.job!.agent_id, 'test setup helper done').catch(() => {})
  if (f.job?.worktree) await removeWorktree(repo.path, f.job.worktree)
  emit({ agentId: f.job?.agent_id ?? null, source: 'system', kind: 'testsetup.helper_done', payload: { repo: repo.name, state: ended?.state ?? 'saved', note: ended?.note ?? null } })
}
async function removeWorktree(repoPath: string, wt: string): Promise<void> {
  await killUnder(wt).catch(() => [])
  await git(repoPath, ['worktree', 'unlock', wt]).catch(() => {}) // Claude Code locks the worktree it runs in
  await git(repoPath, ['worktree', 'remove', '--force', wt]).catch(() => { fs.rmSync(wt, { recursive: true, force: true }) })
  await git(repoPath, ['worktree', 'prune']).catch(() => {})
  await git(repoPath, ['branch', '-D', `hq-testsetup/${path.basename(wt)}`]).catch(() => {})
}

/** HQ's check of a setup, for real: the app on its seed, the page opened, a reset, the page opened again. Null when it passed, else what's wrong, in words
 *  the helper (or the user) can act on, with the scenario it ran. */
export async function checkSetupRun(repoId: string, setup: TestSetup): Promise<{ problem: string | null; scenario: ScenarioResult | null; stopped?: boolean }> {
  const r = await runScenario(repoId, [{ action: 'navigate', url: '/' }, { action: 'reset' }, { action: 'navigate', url: '/' }], { name: 'HQ\'s check of the test setup', setup, show: 'setup_check' })
  if (r === 'stopped') return { problem: 'HQ\'s check was stopped (the project was stopped or auto mode went off)', scenario: null, stopped: true }
  if (!('id' in r)) return { problem: r.why, scenario: null }
  const tail = (f: string) => { try { return fs.readFileSync(path.join(r.dir, f), 'utf8').trim().split('\n').slice(-30).join('\n') } catch { return '' } }
  if (!r.started) return { problem: `${r.why}${tail('start-output.log') ? `\nIts output:\n${tail('start-output.log')}` : ''}`, scenario: r }
  const bad = r.steps.findIndex((s) => !s.ok)
  if (bad >= 0) return { problem: `step ${bad + 1} (${['open the page', 'reset', 'open the page again'][bad]}) failed: ${r.steps[bad]!.why}\nServer output:\n${tail('server.log')}`, scenario: r }
  // The reset put back exactly what the start had: the same state, file for file
  const snaps = fs.readFileSync(path.join(r.dir, 'snaps.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { label: string; hash: string })
  const first = snaps[0]?.hash, afterReset = snaps.find((s) => s.label === 'reset')?.hash
  if (!first || first !== afterReset) return { problem: 'after a reset the state paths weren\'t what the seed wrote: something else changes them, or the app writes to them as it starts', scenario: r }
  // A dev server hands out the source: what the page loaded says so
  const calls = fs.readFileSync(path.join(r.dir, 'api.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { path: string })
  const dev = calls.find((c) => /^\/(@vite\/|@react-refresh|@fs\/|__vite|src\/.+\.(tsx?|jsx|vue|svelte)(\?|$))|\/_next\/webpack-hmr|__webpack_hmr|sockjs-node/.test(c.path))
  if (dev) return { problem: `the page loaded ${dev.path}: that's a dev server, which hands out the app's source. Start a production build instead.`, scenario: r }
  const errs = r.flags.filter((x) => x.kind === 'error' && (x.status ?? 0) >= 500)
  if (errs.length) return { problem: `opening the page got server errors: ${errs.map((x) => `${x.method} ${x.path} → ${x.status}`).join(', ')}\nServer output:\n${tail('server.log')}`, scenario: r }
  return { problem: null, scenario: r }
}

type Result = { ok: boolean; text: string }
/** save_test_setup: checks the setup's shape at once, then for real in the background; the helper hears how that went as a message. */
export function saveTestSetup(agent: Agent, input: unknown): Result {
  const repoId = repoOfAgent(agent.id), repo = repoId ? getRepo(repoId) : undefined, f = repoId ? readSetup(repoId) : null
  if (!repoId || !repo || !f?.job) return { ok: false, text: 'HQ is not waiting for a test setup from you. Stop here.' }
  if (f.job.state === 'checking') return { ok: false, text: 'HQ is still checking your last setup. End your turn; its message will come.' }
  const recipe = runnableRecipe(row(repoId), repo.path); if (!recipe) return { ok: false, text: 'The project has no start steps any more. Stop here.' }
  const checked = checkSetup(input, recipe, f.job.worktree)
  if ('error' in checked) return { ok: false, text: `Not saved: ${checked.error}. Fix it and call save_test_setup again.` }
  const saves = f.job.saves + 1
  if (saves > SETUP_SAVES) {
    tell(repoId, `${repo.name}: Claude tried ${SETUP_SAVES} times and couldn't get HQ's testing set up.`)
    setTimeout(() => { void finishSetup(repoId, { state: 'failed', note: `Claude tried ${SETUP_SAVES} times and couldn't get it to work.`, at: Date.now() }) }, 1500)
    return { ok: false, text: `That was save ${saves}; HQ allows ${SETUP_SAVES}. HQ stops you now and tells the user.` }
  }
  update(repoId, (x) => ({ ...x, job: x.job ? { ...x.job, saves, state: 'checking' } : x.job }))
  emit({ agentId: agent.id, source: 'system', kind: 'testsetup.saved', payload: { repo: repo.name, saves, setup: checked.setup } })
  void checkDraft(repoId, agent.id, checked.setup)
  return { ok: true, text: 'Saved. HQ now runs it for real in its own sandbox (seed, start, open the page, reset, open it again). End your turn; the result comes to you as a message.' }
}
async function checkDraft(repoId: string, agentId: string, setup: TestSetup): Promise<void> {
  const c = await checkSetupRun(repoId, setup).catch((e) => ({ problem: `HQ's check broke off: ${(e as Error).message}`, scenario: null }))
  const f = readSetup(repoId), repo = getRepo(repoId)
  if (!repo || f.job?.agent_id !== agentId) return // stopped or replaced meanwhile
  const helper = live(agentId)
  if (c.problem) {
    update(repoId, (x) => ({ ...x, job: x.job ? { ...x.job, state: 'working' } : x.job }))
    if (helper) sendMessage({ channel: 'dm', from: 'hq', to: agentId, reason: 'fyi', body: `HQ's check of your test setup failed: ${c.problem}\n\nFix it and call save_test_setup again.` })
    return
  }
  update(repoId, (x) => ({ ...x, setup, saved_at: Date.now(), by: 'Claude (test setup)', seen: false, checked: { ok: true, at: Date.now(), why: null, scenario: c.scenario?.id ?? null } }))
  tell(repoId, `${repo.name}: Claude worked out how HQ tests the app (production start, a clean seed, resets). See it under ⚙ in the preview.`, true)
  const passed = `HQ's check passed: ${c.scenario?.summary ?? 'the app started, reset and started again'}. HQ saved your setup and ends your session now; do nothing else.`
  if (helper) sendMessage({ channel: 'dm', from: 'hq', to: agentId, reason: 'fyi', body: passed })
  setTimeout(() => { void finishSetup(repoId, null) }, 3000)
}

/** report_cant_test: the app can't be tested here (it needs a real database server, an account). The user hears why. */
export function cantTest(agent: Agent, reason: string): Result {
  const repoId = repoOfAgent(agent.id), repo = repoId ? getRepo(repoId) : undefined; if (!repoId || !repo) return { ok: false, text: 'HQ is not waiting on you any more.' }
  tell(repoId, `${repo.name}: Claude can't set up HQ's testing: ${reason}`)
  setTimeout(() => { void finishSetup(repoId, { state: 'cant_test', note: reason, at: Date.now() }) }, 1500)
  return { ok: true, text: 'Told the user. HQ ends this session now.' }
}
/** The user stops the helper (or says they've seen the setup). */
export async function dismissSetup(repoId: string): Promise<SetupFile> {
  untell(repoId)
  const f = readSetup(repoId)
  if (f.job) await finishSetup(repoId, null)
  return update(repoId, (x) => ({ ...x, seen: true }))
}

/** A setup helper that exited by itself or was lost. */
export function onSetupAgentGone(agentId: string | null): void {
  const repoId = agentId ? repoOfAgent(agentId) : null; if (!repoId) return
  void finishSetup(repoId, { state: 'failed', note: 'Claude stopped before it finished.', at: Date.now() })
}
/** On backend start: helpers that didn't survive the restart are finished (a check in flight was lost with the backend). */
export async function recoverSetupHelpers(repos: Repo[]): Promise<void> {
  for (const r of repos) {
    const f = readSetup(r.id)
    if (f.job && (!live(f.job.agent_id) || f.job.state === 'checking')) await finishSetup(r.id, { state: 'failed', note: 'HQ restarted while Claude was working it out.', at: Date.now() })
    const keep = readSetup(r.id).job?.worktree // and setup worktrees nobody owns (HQ stopped mid-start)
    for (const w of await listWorktrees(r.path).catch(() => [])) if (path.basename(w.path).startsWith(SETUP_WORKTREE) && w.path !== keep) await removeWorktree(r.path, w.path)
    if (readSetup(r.id).merged.length) void checkMerged(r.id) // merged changes whose check didn't finish
  }
}

/** update_test_setup (engineers): a change to the project's setup that their ticket makes, kept with the ticket and applied when it merges. */
export function proposeSetupChange(agent: Agent, input: unknown): Result {
  const t = agent.ticket_id ? getTicket(agent.ticket_id) : undefined, f = t ? getFeature(t.feature_id) : undefined
  if (!t || !f) return { ok: false, text: 'You have no ticket.' }
  const cur = readSetup(f.repo_id); if (!cur.setup) return { ok: false, text: 'This project has no test setup yet, so there is nothing to update. Carry on with your ticket.' }
  const repo = getRepo(f.repo_id)!, recipe = runnableRecipe(row(f.repo_id), repo.path); if (!recipe) return { ok: false, text: 'This project has no start steps; nothing to update.' }
  const change = (input ?? {}) as Partial<TestSetup>
  const checked = checkSetup(mergeSetup(cur.setup, change), recipe, t.worktree_path ?? repo.path)
  if ('error' in checked) return { ok: false, text: `Not saved: ${checked.error}. Fix it and call update_test_setup again.` }
  update(f.repo_id, (x) => ({ ...x, pending: { ...x.pending, [t.id]: { key: t.key, setup: change, at: Date.now() } } }))
  emit({ agentId: agent.id, source: 'system', kind: 'testsetup.change_proposed', payload: { repo: repo.name, ticket: t.key, fields: Object.keys(change) } })
  return { ok: true, text: `Saved with ${t.key}. HQ applies it when ${t.key} merges, and checks it then.` }
}
/** A ticket merged: its setup change (if any) joins the project's queue of merged changes, which HQ checks one at a time on the new main. A change is applied
 *  only once its check passes; a failed one is the user's to see and the setup stays as it was. The queue is on disk: a check that was stopped, or lost to a
 *  backend restart, is taken up again at the next merge or the next start (recoverSetupHelpers). */
export function onMergedSetup(e: HqEvent): void {
  const t = getTicket(String(e.payload.ticket ?? '')), f = t ? getFeature(t.feature_id) : undefined; if (!t || !f) return
  const cur = readSetup(f.repo_id), mine = cur.pending[t.id]
  if (mine) update(f.repo_id, (x) => { const pending = { ...x.pending }; delete pending[t.id]; return { ...x, pending, merged: [...x.merged, { ...mine, ticket_id: t.id }] } })
  void checkMerged(f.repo_id)
}
const checking = new Set<string>()
/** Works through the project's queue of merged changes, oldest first, each on top of the setup as the ones before it left it. */
export async function checkMerged(repoId: string): Promise<void> {
  if (checking.has(repoId)) return; checking.add(repoId)
  try {
    for (;;) {
      const cur = readSetup(repoId), next = cur.merged[0], repo = getRepo(repoId)
      if (!next || !repo) return
      if (!cur.setup) { update(repoId, (x) => ({ ...x, merged: x.merged.slice(1) })); continue } // nothing to change any more
      await ensureFresh(repoId).catch(() => null)
      const candidate = mergeSetup(cur.setup, next.setup), c = await checkSetupRun(repoId, candidate)
      if (c.stopped) return // stays queued: the next merge or the next start takes it up
      const done = (x: SetupFile): SetupFile => ({ ...x, merged: x.merged.filter((m) => m.ticket_id !== next.ticket_id) })
      if (c.problem) {
        update(repoId, done)
        tell(repoId, `${repo.name}: ${next.key} changed how HQ tests the app, and HQ's check of it failed (${c.problem.split('\n')[0]}). HQ kept the setup it had.`)
      } else {
        update(repoId, (x) => ({ ...done(x), setup: candidate, saved_at: Date.now(), by: next.key, seen: false, checked: { ok: true, at: Date.now(), why: null, scenario: c.scenario?.id ?? null } }))
        tell(repoId, `${repo.name}: ${next.key} changed how HQ tests the app; HQ checked it. See it under ⚙ in the preview.`, true)
      }
    }
  } finally { checking.delete(repoId) }
}
/** A ticket that won't merge any more takes its change with it. */
export function dropSetupChange(repoId: string, ticketId: string): void {
  if (readSetup(repoId).pending[ticketId]) update(repoId, (x) => { const pending = { ...x.pending }; delete pending[ticketId]; return { ...x, pending } })
}

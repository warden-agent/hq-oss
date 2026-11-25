// The test steps helper (Bug 411): a one-off Claude Code session (the Launch helper's role and lockdown, its own job) that works out how HQ tests a project
// whose tests HQ's own rules can't all run: a frontend beside a Python backend, a backend on Poetry, Django's own test runner, a language the rules have no
// command for. Plain code decides when it is needed (testcensus.ts: test files the command runs nothing of), so a project the rules cover never starts one.
// The helper reads the code in a throwaway worktree, tries things, and calls save_test_steps; HQ then runs the steps for real in its own test sandbox, on
// the commit the helper looked at, and messages it what happened, until every part installs and passes and no test file is left out without a reason, the
// helper calls report_cant_test_steps, or it runs out of saves. Steps that passed are used from then on with no tokens, and shown to the user once
// (teststepsstore.ts). The user's own test command always comes first and never starts a helper.
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS } from './config.ts'
import { getSetting, q } from './db.ts'
import { emit } from './events.ts'
import { attention, resolveKind } from './attention.ts'
import { getRepo, getTicket, notClearing, type Repo } from './records.ts'
import { getAgent, launchAgent, stopAgent, type Agent } from './agents.ts'
import { git } from './reposync.ts'
import { mergeBase } from './conflicts.ts'
import { excludeHqFolders, listWorktrees, seedPackages } from './worktrees.ts'
import { killUnder } from './procs.ts'
import { sendMessage } from './delivery.ts'
import { repush, serial } from './preview.ts'
import { onPath } from './apprun.ts'
import { saveTestCmds } from './heavy.ts'
import { detectTests, failReport, filesAt, testBase, testParts } from './testrun.ts'
import { countWords } from './testcounts.ts'
import { notRun, notRunWords, ruleParts, type NotRun } from './testcensus.ts'
import { chain, checkSteps, gapKey, hasTests, readSteps, stepsSkip, writeSteps, type SavedSteps, type StepsFile, type TestSteps } from './teststepsstore.ts'
import { j } from './util.ts'

export const STEPS_SAVES = 4
export const STEPS_WORKTREE = 'teststeps-'
const notice = (repoId: string, good = false) => `${good ? 'repo_teststeps_ok' : 'repo_teststeps'}:${repoId}`
/** One notice about a project's test steps at a time. Steps that were checked and saved are good news, so they have a kind of their own. */
const tell = (repoId: string, detail: string, good = false): void => { resolveKind(notice(repoId, !good), null); attention(notice(repoId, good), detail) }
const untell = (repoId: string): void => { resolveKind(notice(repoId), null); resolveKind(notice(repoId, true), null) }
/** The helper's model: Sonnet, unless the user has set one for it (six layouts on real sessions, 2026-11-25: Sonnet's steps passed HQ's check). */
const model = (): string => (getSetting('models', DEFAULTS.models) as Record<string, string>).test_steps ?? 'sonnet'
const live = (agentId: string | null | undefined): Agent | undefined => { const a = agentId ? getAgent(agentId) : undefined; return a && a.status !== 'exited' ? a : undefined }
/** The project whose test steps this agent works on. */
function repoOfAgent(agentId: string): string | null {
  const a = getAgent(agentId); if (!a?.repo_id) return null
  return readSteps(a.repo_id).job?.agent_id === agentId ? a.repo_id : null
}
/** Changes what HQ keeps for the project and tells the page. Nothing is written for a project removed from HQ meanwhile: its folder is gone, and must stay gone. */
const update = (repoId: string, fn: (f: StepsFile) => StepsFile): StepsFile => {
  const next = fn(readSteps(repoId)); if (!getRepo(repoId)) return next
  writeSteps(repoId, next); repush(repoId); return next
}
/** Is this agent a test steps helper (so the Launch helper's sweep leaves it alone)? */
export const stepsHelperOf = (repoId: string): string | null => readSteps(repoId).job?.agent_id ?? null

/** What commit `ref` of this project has in test files that HQ would run nothing of, with what it runs now: the saved steps, else its rules. Nothing for a
 *  project with a test command of the user's own: HQ can't tell what that runs, and it is theirs to say. `shaky`: a Python project of the rules' whose setup
 *  they can't be sure of (no uv.lock, and no requirements.txt that names pytest: the rules' `uv sync` and pytest are a guess there). */
export async function stepsGap(repo: Repo, ref: string, o: { own?: boolean } = {}): Promise<{ runs: string | null; gaps: NotRun[]; shaky: string[]; key: string }> {
  if (o.own !== false && repo.test_cmd?.trim()) return { runs: repo.test_cmd.trim(), gaps: [], shaky: [], key: '' } // own: false = what HQ would run without the user's command
  const files = await filesAt(repo.path, ref).catch(() => [] as string[]), set = new Set(files), has = (p: string) => set.has(p)
  const read = (p: string): string => { try { return fs.readFileSync(path.join(repo.path, p), 'utf8') } catch { return '' } }
  const steps = readSteps(repo.id).steps
  if (steps) { const gaps = stepsSkip(files, steps, has, read); return { runs: chain(steps.parts), gaps, shaky: [], key: gapKey(gaps) } }
  const plan = detectTests(repo.path), parts = plan ? ruleParts(plan.test) : [], gaps = notRun(files, parts, has, read)
  const shaky = parts.filter((p) => p.kind === 'python' && !has(p.dir === '.' ? 'uv.lock' : `${p.dir}/uv.lock`)
    && !/^\s*pytest\b/im.test(read(p.dir === '.' ? 'requirements.txt' : `${p.dir}/requirements.txt`))).map((p) => p.dir)
  return { runs: plan?.test ?? null, gaps, shaky, key: [gapKey(gaps), ...shaky.map((d) => `${d}:python-setup`)].filter(Boolean).join(',') }
}
/** The package and build tools on HQ's PATH, as the backend (outside any sandbox) sees them. The helper's own sandbox hides the user's home folder, where
 *  many of them live, so `which` there says "not found" for a tool that runs (spike 2026-11-25: it then ignored a uv.lock and installed with pip). */
function toolsLine(): string {
  const all = ['npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry', 'pdm', 'pipenv', 'python3', 'go', 'cargo', 'mvn', 'gradle', 'bundle', 'composer', 'dotnet', 'mix']
  const there = all.filter((t) => onPath(t)), gone = all.filter((t) => !there.includes(t))
  return `Tools HQ found installed on this computer: ${there.join(', ') || 'none of the ones it looks for'}.${gone.length ? ` Not found: ${gone.join(', ')}.` : ''}`
}
function prompt(repo: Repo, why: 'first' | 'again' | 'gap', gap: Awaited<ReturnType<typeof stepsGap>>, current: SavedSteps | null, ticketKey: string | null): string {
  return [`Project: ${repo.name}. Your job this time is the TEST STEPS (the "Test steps" section of your instructions), not the start steps.`, '',
    ...(ticketKey ? [`You are looking at ${mergeBase(repo).name} with ticket ${ticketKey} merged in: the ticket adds tests HQ's steps don't run yet.`] : []),
    `What HQ runs now: ${gap.runs ? `\`${gap.runs}\`` : 'nothing: its rules found no tests they know how to run'}`,
    ...(gap.gaps.length ? [`Test files that leaves out: ${gap.gaps.map((g) => `${notRunWords(g)}, e.g. ${g.example}`).join('; ')}`] : []),
    ...(gap.shaky.length ? [`HQ's rules can't be sure how the Python project in ${gap.shaky.map((d) => d === '.' ? 'the root' : `${d}/`).join(', ')} installs its packages.`] : []),
    toolsLine(),
    ...(why !== 'first' && current ? ['', 'The steps HQ has now (keep what is still right):', JSON.stringify({ parts: current.parts.map((p) => ({ dir: p.dir, install: p.install, test: p.test })),
      left_out: current.left_out, notes: current.notes }, null, 1)] : []),
  ].join('\n')
}

/** Starts the helper for this project. One at a time per project: in the preview's queue, so a second click (another tab) finds the first one on it.
 *  `sha`: the commit to work on (default: the tip of the project's base branch); `ticketId`: the ticket whose merge that commit is, when it is one. */
export function startStepsHelper(repoId: string, o: { why?: 'first' | 'again' | 'gap'; sha?: string; ticketId?: string | null } = {}): Promise<StepsFile> {
  return serial(repoId, () => startOne(repoId, o))
}
async function startOne(repoId: string, o: { why?: 'first' | 'again' | 'gap'; sha?: string; ticketId?: string | null }): Promise<StepsFile> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  notClearing(repoId)
  const f = readSteps(repoId)
  if (live(f.job?.agent_id)) return f // already on it
  if (repo.empty) throw new Error(`${repo.name} has nothing on ${repo.default_branch} to test yet.`)
  if (f.job?.worktree) await removeWorktree(repo.path, f.job.worktree)
  const sha = o.sha ?? await git(repo.path, ['rev-parse', mergeBase(repo).ref]), gap = await stepsGap(repo, sha), why = o.why ?? (f.steps ? 'again' : 'first')
  const name = `${STEPS_WORKTREE}${Date.now().toString(36)}`, wt = path.join(repo.path, '.claude', 'worktrees', name)
  await git(repo.path, ['worktree', 'add', '-q', '-b', `hq-teststeps/${name}`, wt, sha])
  await excludeHqFolders(repo.path)
  await seedPackages(repo.path, wt).catch(() => [])
  untell(repoId)
  let a: Agent
  try {
    a = await launchAgent({ role: 'launcher', repoId, model: model(), cwd: repo.path, displayName: `test steps ${repo.name}`, worktreeName: name,
      launchPrompt: prompt(repo, why, gap, f.steps, o.ticketId ? getTicket(o.ticketId)?.key ?? null : null), repoAllowlist: j<string[]>(repo.network_allowlist, []) }) // it tries installs
  } catch (e) { await removeWorktree(repo.path, wt); throw e }
  const next = update(repoId, (x) => ({ ...x, job: { agent_id: a.id, worktree: wt, saves: 0, state: 'working', started_at: Date.now(), sha, why, ticket_id: o.ticketId ?? null, gap: gap.key },
    ended: null }))
  emit({ agentId: a.id, source: 'system', kind: 'teststeps.helper_started', payload: { repo: repo.name, why } })
  return next
}

/** Calls made as a helper's job ends, however it ends: what waits for the steps goes on (auto mode's runs, a check the user asked for). */
const waiting = new Map<string, Set<() => void>>()
/** Resolves when this project's helper job is over (at once when there is none). `signal`: stop waiting then, too. */
export function stepsDone(repoId: string, signal?: AbortSignal): Promise<void> {
  if (!readSteps(repoId).job || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const set = waiting.get(repoId) ?? new Set<() => void>(); waiting.set(repoId, set)
    const done = (): void => { set.delete(done); signal?.removeEventListener('abort', done); resolve() }
    set.add(done); signal?.addEventListener('abort', done, { once: true })
  })
}
const checks = new Map<string, AbortController>() // HQ's check of a save under way, by project: ended with the job
/** The helper is done (or gone): stop it, end HQ's check of its last save, delete its worktree, and let go of what waited. `ended`: what the page says next. */
export async function finishSteps(repoId: string, ended: StepsFile['ended']): Promise<void> {
  const f = readSteps(repoId), repo = getRepo(repoId)
  checks.get(repoId)?.abort(); checks.delete(repoId)
  if (!f.job) return
  const gap = f.job.gap // a job that ended with no steps: its gap has been looked at, so it doesn't start another helper by itself
  update(repoId, (x) => ({ ...x, job: null, ended, ...(ended ? { looked: [...x.looked.filter((l) => l.gap !== gap), { gap, at: Date.now(), result: ended.state }].slice(-20) } : {}) }))
  if (live(f.job.agent_id)) await stopAgent(f.job.agent_id, 'test steps helper done').catch(() => {})
  if (repo) await removeWorktree(repo.path, f.job.worktree)
  emit({ agentId: f.job.agent_id, source: 'system', kind: 'teststeps.helper_done', payload: { repo: repo?.name ?? repoId, state: ended?.state ?? 'saved', note: ended?.note ?? null } })
  for (const go of [...(waiting.get(repoId) ?? [])]) go()
}
async function removeWorktree(repoPath: string, wt: string): Promise<void> {
  await killUnder(wt).catch(() => [])
  await git(repoPath, ['worktree', 'unlock', wt]).catch(() => {}) // Claude Code locks the worktree it runs in
  await git(repoPath, ['worktree', 'remove', '--force', wt]).catch(() => { fs.rmSync(wt, { recursive: true, force: true }) })
  await git(repoPath, ['worktree', 'prune']).catch(() => {})
  await git(repoPath, ['branch', '-D', `hq-teststeps/${path.basename(wt)}`]).catch(() => {})
}

/** HQ's check of test steps, for real: on commit `sha`, every part installs (network on) and passes (network off) in the test sandbox, each part runs at
 *  least one test where HQ can read a count, and every test file HQ can see is under a part or in left_out. Null when it passed, else what's wrong, in words
 *  the helper can act on. `words`: what each part did, for the helper and the user. */
export async function checkStepsRun(repo: Repo, steps: TestSteps, sha: string, signal: AbortSignal): Promise<{ problem: string | null; words: string; stopped?: boolean }> {
  const all = steps.parts.map((p) => ({ ...p, tests: false, engineers: true })) // every part runs here, whatever the commit holds
  const r = await testBase(repo.path, sha, `steps-${repo.id.slice(-6)}`, null, signal, { repoId: repo.id, ticketId: null, what: 'steps_check' }, { steps: { parts: all } })
  if (r.kind === 'stopped' || signal.aborted) return { problem: 'HQ\'s check was stopped', words: '', stopped: true }
  if (r.kind === 'error') return { problem: r.why, words: '' }
  if (r.kind === 'fail') return { problem: `\`${r.test}\` failed${r.hung ? ' (it ran out of time)' : ''}. Its output:\n${failReport(r, 3000)}`, words: '' }
  if (r.kind !== 'pass') return { problem: `HQ couldn't run the steps (${r.kind})`, words: '' }
  const none = (r.parts ?? []).find((p) => p.counts && p.counts.passed + p.counts.failed + p.counts.skipped === 0)
  if (none) return { problem: `\`${none.cmd}\` passed but ran no tests: its command has to run that folder's test suite`, words: '' }
  const files = await filesAt(repo.path, sha).catch(() => [] as string[]), set = new Set(files)
  const gaps = stepsSkip(files, { parts: all, left_out: steps.left_out }, (p) => set.has(p), (p) => { try { return fs.readFileSync(path.join(repo.path, p), 'utf8') } catch { return '' } })
  if (gaps.length) return { problem: `every part passed, but these test files are run by no part and aren't in left_out: ${gaps.map((g) => `${notRunWords(g)}, e.g. ${g.example}`).join('; ')}. `
    + 'Add a part for each, or list it in left_out with the reason', words: '' }
  const prints = new Map((r.names.parts ?? []).map((p) => [p.dir, p.prints]))
  const words = (r.parts ?? []).map((p) => `\`${p.cmd}\`: ${p.counts ? countWords(p.counts) : 'passed (HQ couldn\'t read a test count from its output)'}; `
    + (prints.get(p.dir) ? 'HQ can read each test\'s name' : 'HQ can\'t read each test\'s name from this output (fine when the runner has no such output)')).join('\n')
  return { problem: null, words }
}

type Result = { ok: boolean; text: string }
/** save_test_steps: checks the steps' shape at once, then for real in the background; the helper hears how that went as a message. */
export function saveTestSteps(agent: Agent, input: unknown): Result {
  const repoId = repoOfAgent(agent.id), repo = repoId ? getRepo(repoId) : undefined, f = repoId ? readSteps(repoId) : null
  if (!repoId || !repo || !f?.job) return { ok: false, text: 'HQ is not waiting for test steps from you. Stop here.' }
  if (f.job.state === 'checking') return { ok: false, text: 'HQ is still checking your last steps. End your turn; its message will come.' }
  const checked = checkSteps(input, f.job.worktree)
  if ('error' in checked) return { ok: false, text: `Not saved: ${checked.error}. Fix it and call save_test_steps again.` }
  const saves = f.job.saves + 1
  if (saves > STEPS_SAVES) {
    tell(repoId, `${repo.name}: Claude tried ${STEPS_SAVES} times and couldn't work out test steps that pass in HQ's sandbox. HQ tests it with what it had.`)
    setTimeout(() => { void finishSteps(repoId, { state: 'failed', note: `Claude tried ${STEPS_SAVES} times and couldn't get steps that pass in HQ's sandbox.`, at: Date.now() }) }, 1500)
    return { ok: false, text: `That was save ${saves}; HQ allows ${STEPS_SAVES}. HQ stops you now and tells the user.` }
  }
  update(repoId, (x) => ({ ...x, job: x.job ? { ...x.job, saves, state: 'checking' } : x.job }))
  emit({ agentId: agent.id, source: 'system', kind: 'teststeps.saved', payload: { repo: repo.name, saves, steps: checked.steps } })
  void checkDraft(repoId, agent.id, checked.steps)
  return { ok: true, text: 'Saved. HQ now runs the steps for real in its own sandbox: each part\'s install, then its tests. End your turn; the result comes to you as a message.' }
}
/** Did this agent's session run `cmd` (it ran, pass or fail: Claude Code didn't refuse it, and its sandbox could start it)? */
function ranInSession(agentId: string, cmd: string): boolean {
  const squash = (s: string): string => s.trim().replace(/\s+/g, ' '), want = squash(cmd); if (!want) return false
  return q<{ payload: string }>("SELECT payload FROM events WHERE agent_id = ? AND kind IN ('hook.PostToolUse:Bash', 'hook.PostToolUseFailure:Bash') AND payload LIKE '%\"ran\":%'", agentId)
    .some((e) => squash(j<{ ran?: string }>(e.payload, {}).ran ?? '').includes(want))
}
async function checkDraft(repoId: string, agentId: string, steps: TestSteps): Promise<void> {
  const repo0 = getRepo(repoId), job = readSteps(repoId).job; if (!repo0 || !job) return
  const stop = new AbortController(); checks.get(repoId)?.abort(); checks.set(repoId, stop)
  const c = await checkStepsRun(repo0, steps, job.sha, stop.signal).catch((e) => ({ problem: `HQ's check broke off: ${(e as Error).message}`, words: '' }))
  if (checks.get(repoId) === stop) checks.delete(repoId)
  const f = readSteps(repoId), repo = getRepo(repoId)
  if (!repo || f.job?.agent_id !== agentId) return // stopped or replaced meanwhile
  const helper = live(agentId)
  if (c.problem) {
    update(repoId, (x) => ({ ...x, job: x.job ? { ...x.job, state: 'working' } : x.job }))
    if (helper) sendMessage({ channel: 'dm', from: 'hq', to: agentId, reason: 'fyi', body: `HQ's check of your test steps failed (save ${f.job.saves} of ${STEPS_SAVES}): ${c.problem}\n\n`
      + 'Fix the steps and call save_test_steps again, or call report_cant_test_steps.' })
    return
  }
  const files = await filesAt(repo.path, f.job.sha).catch(() => [] as string[])
  // Which parts an engineer's session can run: one the helper ran in its own session (the same sandbox), and one HQ's rules build themselves, which
  // engineers ran before there were steps (a helper often doesn't try `npm test` again: seen on a real session, 2026-11-25). Any other is HQ's alone
  const rules = detectTests(f.job.worktree)?.test ?? '', known = new Set((testParts(rules) ?? (rules ? [{ dir: '.', run: rules }] : [])).map((p) => `${p.dir}\0${p.run}`))
  const saved: SavedSteps = { ...steps, parts: steps.parts.map((p) => ({ ...p, tests: hasTests(files, p.dir),
    engineers: ranInSession(agentId, p.test) || known.has(`${p.dir}\0${p.test}`) })) }
  update(repoId, (x) => ({ ...x, steps: saved, saved_at: Date.now(), by: 'Claude (test steps)', seen: false, checked: { sha: f.job!.sha, at: Date.now() } }))
  saveTestCmds() // the turn gate knows the new commands, also while HQ is down
  const left = saved.left_out.length ? ` Left out: ${saved.left_out.map((l) => `${l.path} (${l.why})`).join('; ')}.` : ''
  tell(repoId, `${repo.name}: Claude worked out how HQ tests it, and HQ checked the steps in its sandbox: \`${chain(saved.parts)}\`.${left} See them in the Auto box.`, true)
  emit({ agentId, source: 'system', kind: 'teststeps.checked', payload: { repo: repo.id, name: repo.name, cmd: chain(saved.parts), left_out: saved.left_out.length } })
  if (helper) sendMessage({ channel: 'dm', from: 'hq', to: agentId, reason: 'fyi', body: `HQ's check passed:\n${c.words}\nHQ saved your steps and ends your session now; do nothing else.` })
  update(repoId, (x) => ({ ...x, looked: [...x.looked.filter((l) => l.gap !== f.job!.gap), { gap: f.job!.gap, at: Date.now(), result: 'saved' as const }].slice(-20) }))
  setTimeout(() => { void finishSteps(repoId, null) }, 3000)
}

/** report_cant_test_steps: no test of this project can be run in HQ's sandbox (it needs a database server, an account). The user hears why. */
export function cantSteps(agent: Agent, reason: string): Result {
  const repoId = repoOfAgent(agent.id), repo = repoId ? getRepo(repoId) : undefined; if (!repoId || !repo) return { ok: false, text: 'HQ is not waiting on you any more.' }
  tell(repoId, `${repo.name}: Claude couldn't work out test steps HQ can run: ${reason} HQ tests it with what it had.`)
  setTimeout(() => { void finishSteps(repoId, { state: 'cant', note: reason, at: Date.now() }) }, 1500)
  return { ok: true, text: 'Told the user. HQ ends this session now.' }
}
/** The user stops the helper, or says they've seen the steps. */
export async function dismissSteps(repoId: string): Promise<StepsFile> {
  untell(repoId)
  if (readSteps(repoId).job) await finishSteps(repoId, { state: 'failed', note: 'Stopped before it finished.', at: Date.now() })
  return update(repoId, (x) => ({ ...x, seen: true }))
}
/** A helper that exited by itself or was lost. */
export function onStepsAgentGone(agentId: string | null): void {
  const repoId = agentId ? repoOfAgent(agentId) : null; if (!repoId) return
  void finishSteps(repoId, { state: 'failed', note: 'Claude stopped before it finished.', at: Date.now() })
}
/** On backend start: helpers that didn't survive the restart are finished (a check in flight was lost with the backend), and worktrees nobody owns go. */
export async function recoverStepsHelpers(repos: Repo[]): Promise<void> {
  for (const r of repos) {
    const f = readSteps(r.id)
    if (f.job && (!live(f.job.agent_id) || f.job.state === 'checking')) await finishSteps(r.id, { state: 'failed', note: 'HQ restarted while Claude was working it out.', at: Date.now() })
    const keep = readSteps(r.id).job?.worktree
    for (const w of await listWorktrees(r.path).catch(() => [])) if (path.basename(w.path).startsWith(STEPS_WORKTREE) && w.path !== keep) await removeWorktree(r.path, w.path)
  }
}

/** Before HQ tests commit `sha` of this project: are its test steps settled? `ready`: test with what there is (the user's command, saved steps, or the
 *  rules: nothing is left out, or a helper has already looked at what is). `working`: a helper is on it now (this call may have started it): wait for
 *  stepsDone, then ask again. Started at most once for the same gap; the user's "Work it out again" is what asks twice. */
export async function stepsReady(repo: Repo, sha: string, o: { ticketId?: string | null } = {}): Promise<'ready' | 'working'> {
  if (repo.test_cmd?.trim()) return 'ready'
  const f = readSteps(repo.id); if (f.job) return 'working'
  const gap = await stepsGap(repo, sha)
  if (!gap.key || f.looked.some((l) => l.gap === gap.key)) return 'ready'
  try { await startStepsHelper(repo.id, { why: f.steps ? 'gap' : 'first', sha, ticketId: o.ticketId ?? null }) } catch (e) {
    emit({ agentId: null, source: 'system', kind: 'teststeps.not_started', payload: { repo: repo.name, error: (e as Error).message } })
    return 'ready' // being cleared, or the launch failed: HQ tests with what it has
  }
  return readSteps(repo.id).job ? 'working' : 'ready'
}

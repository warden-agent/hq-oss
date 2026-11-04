// The Launch helper (Bug 37): a one-off Claude Code session that works out how to start a repo's app. HQ only knew a root
// `npm run dev`; every stack starts differently (a Python API + a Vite page, Go, …), and the user shouldn't have to work that
// out. The helper reads the repo in a throwaway worktree, tries it in its sandbox and calls save_launch with a recipe. The user
// OKs the commands once (they'll run outside the sandbox); HQ runs them for real on the main checkout and messages the helper
// what happened, until it calls launch_ok, report_cant_start, or runs out of saves. From then on HQ runs the recipe itself, with
// no tokens per launch; the helper comes back only when the user asks Claude to fix it. Spikes S1/S5, 2026-10-30.
import fs from 'node:fs'
import path from 'node:path'
import { emit } from './events.ts'
import { attention, resolveKind } from './attention.ts'
import { getFeature, getRepo, getTicket, type Repo, type Ticket } from './records.ts'
import { tryable } from './trydata.ts'
import { getAgent, launchAgent, liveAgents, stopAgent, type Agent } from './agents.ts'
import { modelFor } from './roles.ts'
import { git } from './reposync.ts'
import { ensureFresh } from './repos.ts'
import { mergeBase } from './conflicts.ts'
import { excludeHqFolders, listWorktrees, seedPackages } from './worktrees.ts'
import { checkRecipe, commandRecipe, detectCommand, sameCommands, type Recipe } from './apprun.ts'
import { PortTaken, previewSession, previewView, row, save, serial, startPreview, stopPreview } from './preview.ts'
import { killUnder, pgidOf } from './procs.ts'
import { sendMessage } from './delivery.ts'
import { q } from './db.ts'
import { j, sleep } from './util.ts'
import * as tmux from './tmux.ts'

/** Saves a helper gets before HQ gives up (a save that fails the recipe check doesn't count). */
export const MAX_SAVES = 4
const RUN_WAIT_MS = Number(process.env.HQ_LAUNCH_RUN_WAIT_S ?? 180) * 1000
/** Every helper notice is about the repo, not the agent (the agent is gone by the time the user reads most of them). */
const notice = (repoId: string) => `repo_launch:${repoId}`
/** The repo's helper notice; a new one takes the last one's place (attention.ts). */
const tellUser = (repoId: string, detail: string): void => { attention(notice(repoId), detail) }
const parse = (s: string | null): Recipe | null => { try { return s ? JSON.parse(s) as Recipe : null } catch { return null } }
const live = (agentId: string | null): Agent | undefined => { const a = agentId ? getAgent(agentId) : undefined; return a && a.status !== 'exited' ? a : undefined }
/** The repo whose preview this helper works on. */
const repoOf = (agentId: string): string | null => q<{ id: string }>('SELECT id FROM previews WHERE helper_agent_id = ?', agentId)[0]?.id ?? null

/** The finished ticket a helper works from (Bug 46), when it can be tried in this repo. */
function triedTicket(repoId: string, ticketId: string | null): (Ticket & { worktree_path: string }) | undefined {
  const t = ticketId ? getTicket(ticketId) : undefined
  return tryable(t) && getFeature(t.feature_id)?.repo_id === repoId ? t : undefined
}

function prompt(repo: Repo, why: 'first' | 'fix', saved: Recipe | null, output: string, tk?: Ticket & { worktree_path: string }): string {
  const lines = [`Project: ${repo.name}. Work out how to start its app and save it with save_launch.`]
  if (tk) lines.push('', `Your worktree has ticket ${tk.key}'s version ("${tk.title}"), which the user wants to try before it's merged. `
    + `Work out the steps from it; once it's merged, ${repo.default_branch} uses the same steps.`)
  if (why === 'fix') {
    lines.push('', 'The start steps HQ had stopped working. They were:', JSON.stringify(saved, null, 1))
    if (output.trim()) lines.push('', 'The app\'s last output:', output.trim())
    lines.push('', 'Find out why and save fixed steps.')
  }
  const npm = detectCommand(tk?.worktree_path ?? repo.path)
  if (npm && why === 'first') lines.push('', `Hint: the root package.json has a script for \`${npm}\`; that is often all it takes.`)
  return lines.join('\n')
}

/** Start a helper for this repo ("first": no recipe yet; "fix": the user asked Claude to fix one). One per repo at a time: the
 *  start runs in the repo's preview queue, so a second Launch while the first is still syncing and launching waits, then finds
 *  the helper already on it (Bug 41: two helpers started 2 s apart, and the untracked one's test server held the app's port).
 *  `ticket`: Try it on a repo with no steps yet (Bug 46). A new project's main is empty until its first merge, so the helper
 *  works from that finished ticket's branch, and its first run tries the ticket. Fixing steps while a ticket is tried does too. */
export function startHelper(repoId: string, why: 'first' | 'fix', ticket: string | null = null): Promise<ReturnType<typeof previewView>> {
  return serial(repoId, () => startOne(repoId, why, ticket))
}
async function startOne(repoId: string, why: 'first' | 'fix', ticket: string | null): Promise<ReturnType<typeof previewView>> {
  const repo0 = getRepo(repoId); if (!repo0) throw new Error('unknown repo')
  if (repo0.clearing_at) throw new Error(`${repo0.name} is being cleared; wait until it's done.`)
  const cur = row(repoId)
  const tk = triedTicket(repoId, ticket ?? (why === 'fix' ? cur?.ticket_id ?? null : null))
  if (live(cur?.helper_agent_id ?? null)) { if (tk) save(repoId, { helper_ticket_id: tk.id }); return previewView(repo0) } // already on it
  const repo = await ensureFresh(repoId)
  const output = why === 'fix' ? await tmux.capturePane(previewSession(repoId), 80) : ''
  if (cur?.helper_worktree) await removeWorktree(repo.path, cur.helper_worktree) // a "Not now" or a lost helper's
  const name = `launch-${Date.now().toString(36)}`, wt = path.join(repo.path, '.claude', 'worktrees', name)
  await git(repo.path, ['worktree', 'add', '-q', '-b', `hq-launch/${name}`, wt, tk?.branch ?? mergeBase(repo).name])
  await excludeHqFolders(repo.path)
  await seedPackages(repo.path, wt).catch(() => []) // installed npm packages, as engineers get them
  resolveKind(notice(repoId), null)
  let a: Agent
  try {
    a = await launchAgent({ role: 'launcher', repoId, model: modelFor('launcher'), cwd: repo.path, displayName: `launch ${repo.name}`, worktreeName: name,
      launchPrompt: prompt(repo, why, parse(cur?.recipe ?? null) ?? (cur?.command ? commandRecipe(cur.command, repo.path) : null), output, tk),
      repoAllowlist: j<string[]>(repo.network_allowlist, []) })
  } catch (e) { await removeWorktree(repo.path, wt); throw e }
  save(repoId, { helper_agent_id: a.id, helper_worktree: wt, helper_state: 'working', helper_note: null, helper_saves: 0, draft_recipe: null, helper_ticket_id: tk?.id ?? null })
  emit({ agentId: a.id, source: 'system', kind: 'launch.helper_started', payload: { repo: repo.name, why, ticket: tk?.key ?? null } })
  await sweepStrays(repo)
  return previewView(repo)
}

/** Launch (or Try it, with `ticket`) with nothing to run: steps waiting for the user's OK (after "Not now") are shown, and their
 *  first run tries that ticket; else a helper starts. */
export async function launchWithoutRecipe(repoId: string, ticket: string | null = null): Promise<ReturnType<typeof previewView>> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  const p = row(repoId)
  if (p?.draft_recipe && p.helper_state === 'needs_ok') { save(repoId, { helper_ticket_id: triedTicket(repoId, ticket)?.id ?? null }); return previewView(repo) }
  return startHelper(repoId, 'first', ticket)
}

/** The helper is done (or gone): stop it, stop its leftover test servers, delete its worktree. `state`/`note` are what the
 *  preview pane says next (null: nothing to say). */
export async function finish(repoId: string, state: string | null, note: string | null): Promise<void> {
  const p = row(repoId); const repo = getRepo(repoId); if (!p || !repo) return
  const ticket = state === 'needs_ok' ? {} : { helper_ticket_id: null } // steps still to OK keep their ticket
  save(repoId, { helper_agent_id: null, helper_worktree: null, helper_state: state, helper_note: note, ...ticket })
  if (live(p.helper_agent_id)) await stopAgent(p.helper_agent_id!, 'launch helper done').catch(() => {})
  if (p.helper_worktree) await removeWorktree(repo.path, p.helper_worktree)
  emit({ agentId: p.helper_agent_id, source: 'system', kind: 'launch.helper_done', payload: { repo: repo.name, state, note } })
}

/** HQ's own scratch worktree: nothing in it is the user's, so it's removed even with changes, along with what still runs there. */
async function removeWorktree(repoPath: string, wt: string): Promise<void> {
  await killUnder(wt).catch(() => [])
  await git(repoPath, ['worktree', 'unlock', wt]).catch(() => {})
  await git(repoPath, ['worktree', 'remove', '--force', wt]).catch(() => { fs.rmSync(wt, { recursive: true, force: true }) })
  await git(repoPath, ['worktree', 'prune']).catch(() => {})
  await git(repoPath, ['branch', '-D', `hq-launch/${path.basename(wt)}`]).catch(() => {})
}

type Result = { ok: true; text: string } | { ok: false; text: string }
/** save_launch: check the recipe, keep it as a draft for the user's OK (or run it at once when its commands are the ones they
 *  already OK'd), and tell the helper what happens next. */
export function saveLaunch(agent: Agent, input: unknown): Result {
  const repoId = repoOf(agent.id), p = repoId ? row(repoId) : undefined, repo = repoId ? getRepo(repoId) : undefined
  if (!repoId || !p || !repo) return { ok: false, text: 'HQ is not waiting for start steps from you any more. Stop here.' }
  if (p.helper_state === 'trying') return { ok: false, text: 'HQ is still running your last steps. End your turn; its message will come.' }
  const checked = checkRecipe(input, p.helper_worktree ?? repo.path) // the same tree as main: folders and lockfiles are checked there
  if ('error' in checked) return { ok: false, text: `Not saved: ${checked.error}. Fix it and call save_launch again.` }
  const saves = p.helper_saves + 1
  if (saves > MAX_SAVES) {
    tellUser(repoId, `${repo.name}: Claude tried ${MAX_SAVES} times and couldn't get the app to start. Its last notes: ${checked.recipe.notes || '(none)'}`)
    save(repoId, { draft_recipe: null }) // never ran: nothing to OK
    setTimeout(() => { void finish(repoId, 'failed', `Claude tried ${MAX_SAVES} times and couldn't get it to start.`) }, 1500)
    return { ok: false, text: `That was save ${saves}; HQ allows ${MAX_SAVES}. HQ stops you now and tells the user.` }
  }
  save(repoId, { draft_recipe: JSON.stringify(checked.recipe), helper_saves: saves })
  emit({ agentId: agent.id, source: 'system', kind: 'launch.saved', payload: { repo: repo.name, saves, recipe: checked.recipe } })
  if (sameCommands(parse(p.recipe), checked.recipe)) { // nothing new to OK (only the notes changed)
    void approve(repoId).catch(() => {})
    return { ok: true, text: 'Saved. These are the commands the user already OK\'d, so HQ runs them now. End your turn; HQ messages you the result.' }
  }
  save(repoId, { helper_state: 'needs_ok' })
  tellUser(repoId, `${repo.name}: Claude worked out how to start the app. Check its steps and OK them in the preview.`)
  return { ok: true, text: 'Saved. HQ is showing the user your commands for an OK. End your turn now; the result of the real run comes to you as a message.' }
}

/** The user OK'd the draft: it becomes the repo's recipe and HQ runs it. A helper still on it hears how it went. */
export async function approve(repoId: string): Promise<ReturnType<typeof previewView>> {
  const p = row(repoId), repo = getRepo(repoId); if (!p || !repo) throw new Error('unknown repo')
  if (!p.draft_recipe) throw new Error('No start steps are waiting for your OK.')
  resolveKind(notice(repoId), null)
  const helper = live(p.helper_agent_id)
  save(repoId, { recipe: p.draft_recipe, draft_recipe: null, helper_state: helper ? 'trying' : null, helper_note: null })
  emit({ agentId: null, source: 'ui', kind: 'launch.approved', payload: { repo: repo.name } })
  void tryRun(repoId).catch((e) => emit({ agentId: null, source: 'system', kind: 'preview.error', payload: { repo: repo.name, error: String(e) } }))
  return previewView(repo)
}

/** "Not now": the helper stops; its steps stay waiting for an OK (from ⚙ or the pane) without it. */
export async function dismiss(repoId: string): Promise<ReturnType<typeof previewView>> {
  const p = row(repoId), repo = getRepo(repoId); if (!p || !repo) throw new Error('unknown repo')
  resolveKind(notice(repoId), null)
  await finish(repoId, p.draft_recipe ? 'needs_ok' : null, null)
  return previewView(repo)
}

/** The real run: the helper's leftover test servers stopped first (its sandbox can't kill them, and they'd hold the ports), then
 *  the preview starts on main (or tries the helper's ticket, Bug 46) and HQ waits for it to answer, crash or time out. The helper
 *  gets the outcome and the output. */
async function tryRun(repoId: string): Promise<void> {
  const p = row(repoId)!, helper = live(p.helper_agent_id)
  if (p.helper_worktree && helper) {
    const pane = await tmux.panePid(helper.tmux_session), group = pane ? await pgidOf(pane) : null // the helper itself stays
    await killUnder(p.helper_worktree, group ? [group] : [])
  }
  const tk = triedTicket(repoId, p.helper_ticket_id), where = tk ? `${tk.key}'s version` : 'the user\'s checkout'
  let started: Awaited<ReturnType<typeof startPreview>>
  try { started = await startPreview(repoId, 'the first run of the start steps you OK\'d', { ticket: tk?.id ?? null }) } catch (e) {
    if (e instanceof PortTaken) { // the user's own server, not a bad recipe: no save is used up, and the helper is done
      if (helper) sendMessage({ channel: 'dm', from: 'hq', to: helper.id, reason: 'fyi', body: `HQ didn't run it: ${e.message} That's the user's to sort out, not your steps. Stop here.` })
      await finish(repoId, 'port_taken', e.message); return
    }
    return tell(repoId, helper, `HQ couldn't start it: ${(e as Error).message}`)
  }
  const end = Date.now() + RUN_WAIT_MS
  let cur = row(repoId)!
  while (cur.status === 'starting' && cur.started_at === started.started_at && Date.now() < end) { await sleep(1000); cur = row(repoId)! }
  if (cur.started_at !== started.started_at) return // restarted or stopped by someone else meanwhile: that run's outcome is theirs
  const out = (await tmux.capturePane(previewSession(repoId), 60)).trimEnd().split('\n').slice(-40).join('\n')
  if (cur.status === 'running') {
    return tell(repoId, helper, `Real run on ${where}: the page answered at ${cur.url}. Last output:\n${out}\n\n`
      + 'If this looks right, call launch_ok. If the output shows an error or a missing setting, fix the steps and call save_launch again.')
  }
  if (cur.status === 'starting') await stopPreview(repoId).catch(() => {})
  const what = cur.status === 'starting' ? `no page answered on port ${cur.port} within ${RUN_WAIT_MS / 60_000} minutes` : `it ${cur.detail ?? cur.status}`
  tell(repoId, helper, `Real run on ${where}: ${what}. Last output:\n${out}\n\nFix the steps and call save_launch again.`)
}
function tell(repoId: string, helper: Agent | undefined, body: string): void {
  if (!helper) return // OK'd from ⚙ after "Not now": the pane shows how it went
  save(repoId, { helper_state: 'working' })
  sendMessage({ channel: 'dm', from: 'hq', to: helper.id, reason: 'fyi', body })
}

/** launch_ok: the helper is happy with the real run. The app keeps running; the helper goes. */
export function launchOk(agent: Agent): Result {
  const repoId = repoOf(agent.id); if (!repoId) return { ok: false, text: 'HQ is not waiting on you any more. Stop here.' }
  const p = row(repoId)!
  if (p.helper_state === 'needs_ok' || p.draft_recipe) return { ok: false, text: 'Your last steps are still waiting for the user\'s OK. End your turn and wait.' }
  if (!p.recipe || p.status !== 'running') return { ok: false, text: 'HQ has no working run of your steps yet. Save them with save_launch and wait for HQ\'s message.' }
  setTimeout(() => { void finish(repoId, null, null) }, 1500) // let this answer reach the session first
  return { ok: true, text: 'Done. HQ ends this session now; do nothing else.' }
}

/** report_cant_start: the app can't run here (it needs Docker, a database server, a key). The user hears why, in its words. */
export function cantStart(agent: Agent, reason: string): Result {
  const repoId = repoOf(agent.id), repo = repoId ? getRepo(repoId) : undefined; if (!repoId || !repo) return { ok: false, text: 'HQ is not waiting on you any more.' }
  tellUser(repoId, `${repo.name}: Claude can't start the app: ${reason}`)
  save(repoId, { draft_recipe: null }) // whatever it saved before is moot now
  setTimeout(() => { void finish(repoId, 'cant_start', reason) }, 1500)
  return { ok: true, text: 'Told the user. HQ ends this session now.' }
}

/** A helper that exited by itself or was lost: the repo stops waiting on it. */
export function onAgentGone(agentId: string | null): void {
  const repoId = agentId ? repoOf(agentId) : null; if (!repoId) return
  const p = row(repoId)!
  void finish(repoId, p.draft_recipe ? 'needs_ok' : 'failed', p.draft_recipe ? null : 'Claude stopped before it finished.')
}

/** On backend start, after agents are recovered: helpers that didn't survive the restart are finished, and helper worktrees
 *  nobody owns (HQ stopped mid-job) are removed. */
export async function recoverHelpers(repos: Repo[]): Promise<void> {
  for (const p of q<{ id: string; helper_agent_id: string }>('SELECT id, helper_agent_id FROM previews WHERE helper_agent_id IS NOT NULL')) {
    if (!live(p.helper_agent_id)) await finish(p.id, row(p.id)?.draft_recipe ? 'needs_ok' : 'failed', 'HQ restarted while Claude was working it out.')
  }
  for (const repo of repos) await sweepStrays(repo)
}

/** Helpers HQ lost track of (Bug 41): a live launcher for this repo that isn't the one in its preview row is stopped, and every
 *  launch-* worktree that isn't the row's is removed along with the test servers still running in it. */
async function sweepStrays(repo: Repo): Promise<void> {
  const p = row(repo.id)
  for (const a of liveAgents().filter((x) => x.role === 'launcher' && x.cwd === repo.path && x.id !== p?.helper_agent_id)) {
    await stopAgent(a.id, 'stray launch helper').catch(() => {})
  }
  for (const w of await listWorktrees(repo.path).catch(() => [])) {
    const helperDir = path.dirname(w.path) === path.join(repo.path, '.claude', 'worktrees') && path.basename(w.path).startsWith('launch-')
    if (helperDir && w.path !== p?.helper_worktree) await removeWorktree(repo.path, w.path)
  }
}

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
import { getFeature, getRepo, getTicket, notClearing, type Repo, type Ticket } from './records.ts'
import { tryable } from './trydata.ts'
import { getAgent, launchAgent, liveAgents, stopAgent, type Agent } from './agents.ts'
import { modelFor } from './roles.ts'
import { git } from './reposync.ts'
import { ensureFresh } from './repos.ts'
import { mergeBase } from './conflicts.ts'
import { excludeHqFolders, listWorktrees, seedPackages } from './worktrees.ts'
import { checkRecipe, commandRecipe, detectCommand, PREVIEW_PORTS, refusedWords, sameCommands, strayPorts, type Recipe, type Refusal } from './apprun.ts'
import { chooseTestPorts, helperPorts, helperPortsHeld, PortTaken, previewSession, previewView, row, save, serial, startPreview, stopPreview,
  stoppedByStop, takeRestart } from './preview.ts'
import { killUnder, listenersUnder, pgidOf } from './procs.ts'
import { sendMessage } from './delivery.ts'
import { one, q } from './db.ts'
import { readSetup } from './testsetupstore.ts'
import { readSteps } from './teststepsstore.ts'
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

/** What the helper is told about the ports for its test runs (Bug 226). */
export const portsText = (ports: number[]): string => `Ports for your test runs: ${ports.join(', ')}, free ports in HQ's preview range `
  + `${PREVIEW_PORTS[0]}–${PREVIEW_PORTS.at(-1)}. $PORT is ${ports[0]} in your shell and $HQ_TRY_PORTS lists them all. Use only these for your test `
  + 'servers ("auto" parts): another port may belong to another app on this machine, and HQ stops a test server it finds on one.'

function prompt(repo: Repo, why: 'first' | 'fix', saved: Recipe | null, output: string, ports: number[], tk?: Ticket & { worktree_path: string },
  reason: Refusal | null = null): string {
  const lines = [`Project: ${repo.name}. Work out how to start its app and save it with save_launch.`, '', portsText(ports)]
  if (tk) lines.push('', `Your worktree has ticket ${tk.key}'s version ("${tk.title}"), which the user wants to try before it's merged. `
    + `Work out the steps from it; once it's merged, ${repo.default_branch} uses the same steps.`)
  if (why === 'fix') {
    lines.push('', reason ? `HQ won't run its start steps any more: ${reason.why}. They were:` : 'The start steps HQ had stopped working. They were:', JSON.stringify(saved, null, 1))
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
export function startHelper(repoId: string, why: 'first' | 'fix', ticket: string | null = null, reason: Refusal | null = null): Promise<ReturnType<typeof previewView>> {
  return serial(repoId, () => startOne(repoId, why, ticket, reason))
}
async function startOne(repoId: string, why: 'first' | 'fix', ticket: string | null, reason: Refusal | null): Promise<ReturnType<typeof previewView>> {
  const repo0 = getRepo(repoId); if (!repo0) throw new Error('unknown repo')
  notClearing(repoId)
  const cur = row(repoId)
  const tk = triedTicket(repoId, ticket ?? (why === 'fix' ? cur?.ticket_id ?? null : null))
  if (live(cur?.helper_agent_id ?? null)) { if (tk) save(repoId, { helper_ticket_id: tk.id }); return previewView(repo0) } // already on it
  const repo = await ensureFresh(repoId)
  const output = why === 'fix' && !reason ? await tmux.paneOutput(previewSession(repoId), 80) : '' // refused steps never ran: no output of theirs
  if (cur?.helper_worktree) await removeWorktree(repo.path, cur.helper_worktree) // a "Not now" or a lost helper's
  if (repo.empty && !tk) { // Bug 67: a helper would spend tokens finding that out. A ticket to try has files of its own, even on an empty main (Bug 46)
    resolveKind(notice(repoId), null)
    save(repoId, { helper_agent_id: null, helper_worktree: null, helper_state: 'empty', helper_note: null, helper_saves: 0, draft_recipe: null, helper_ticket_id: null,
      helper_ports: null })
    emit({ agentId: null, source: 'system', kind: 'launch.nothing_to_start', payload: { repo: repo.name } })
    return previewView(repo)
  }
  // Bug 226: ports for its test runs, before anything is made. Another repo's helper starting meanwhile (its own queue) mustn't get the same ones
  // Bug 363: never a port an app was given and hasn't bound yet, and chosen one at a time with the apps' ports
  const ports = await chooseTestPorts(() => [...helperPortsHeld(), ...picking], (got) => { for (const x of got) picking.add(x) })
  if (!ports.length) { // the pane says why (a refused Launch's answer isn't shown anywhere else)
    const msg = `${NO_PORTS} ${PREVIEW_PORTS[0]}–${PREVIEW_PORTS.at(-1)} to try ${repo.name}, and they are all in use. Stop a preview, then Launch again.`
    save(repoId, { detail: msg }); throw new Error(msg)
  }
  try { return await withPorts(repo, why, cur, output, tk, reason, ports) } finally { for (const x of ports) picking.delete(x) }
}
const NO_PORTS = 'Claude needs a free port in HQ\'s preview ports'
/** Ports given to a helper that is still starting (not in its preview row yet). */
const picking = new Set<number>()
async function withPorts(repo: Repo, why: 'first' | 'fix', cur: ReturnType<typeof row>, output: string, tk: (Ticket & { worktree_path: string }) | undefined,
  reason: Refusal | null, ports: number[]): Promise<ReturnType<typeof previewView>> {
  const repoId = repo.id
  const name = `launch-${Date.now().toString(36)}`, wt = path.join(repo.path, '.claude', 'worktrees', name)
  await git(repo.path, ['worktree', 'add', '-q', '-b', `hq-launch/${name}`, wt, tk?.branch ?? mergeBase(repo).name])
  await excludeHqFolders(repo.path)
  await seedPackages(repo.path, wt).catch(() => []) // installed npm packages, as engineers get them
  resolveKind(notice(repoId), null)
  let a: Agent
  try {
    a = await launchAgent({ role: 'launcher', repoId, model: modelFor('launcher'), cwd: repo.path, displayName: `launch ${repo.name}`, worktreeName: name,
      launchPrompt: prompt(repo, why, parse(cur?.recipe ?? null) ?? (cur?.command ? commandRecipe(cur.command, repo.path) : null), output, ports, tk, reason),
      repoAllowlist: j<string[]>(repo.network_allowlist, []), extraEnv: { PORT: String(ports[0]), HQ_TRY_PORTS: ports.join(' ') } })
  } catch (e) { await removeWorktree(repo.path, wt); throw e }
  const note = reason ? `HQ didn't run the start steps you OK'd: they ${refusedWords(reason.lock)}.` : null // Bugs 156, 238
  save(repoId, { helper_agent_id: a.id, helper_worktree: wt, helper_state: 'working', helper_note: note, helper_saves: 0, draft_recipe: null, helper_ticket_id: tk?.id ?? null,
    helper_ports: JSON.stringify(ports),
    ...(note || row(repoId)?.detail?.startsWith(NO_PORTS) ? { detail: null } : {}) }) // the note says it now; the refusal's "start it again" is done
  emit({ agentId: a.id, source: 'system', kind: 'launch.helper_started', payload: { repo: repo.name, why, ticket: tk?.key ?? null } })
  await sweepStrays(repo)
  return previewView(repo)
}

/** Launch (or Try it, with `ticket`) with nothing to run: steps waiting for the user's OK (after "Not now") are shown, and their
 *  first run tries that ticket; else a helper starts. `outdated`: HQ refused the OK'd steps (Bug 156), so the helper fixes them. */
export async function launchWithoutRecipe(repoId: string, ticket: string | null = null, outdated: Refusal | null = null): Promise<ReturnType<typeof previewView>> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  const p = row(repoId)
  if (p?.draft_recipe && p.helper_state === 'needs_ok') { save(repoId, { helper_ticket_id: triedTicket(repoId, ticket)?.id ?? null }); return previewView(repo) }
  return startHelper(repoId, outdated ? 'fix' : 'first', ticket, outdated)
}

/** The helper is done (or gone): stop it, stop its leftover test servers, delete its worktree. `state`/`note` are what the
 *  preview pane says next (null: nothing to say). `why`: for its Events tab, when the pane says nothing. */
export async function finish(repoId: string, state: string | null, note: string | null, why: 'app_stopped' | 'own_command' | null = null): Promise<void> {
  const p = row(repoId); const repo = getRepo(repoId); if (!p || !repo) return
  const ticket = state === 'needs_ok' ? {} : { helper_ticket_id: null } // steps still to OK keep their ticket
  save(repoId, { helper_agent_id: null, helper_worktree: null, helper_state: state, helper_note: note, helper_ports: null, ...ticket })
  if (live(p.helper_agent_id)) await stopAgent(p.helper_agent_id!, 'launch helper done').catch(() => {})
  if (p.helper_worktree) await removeWorktree(repo.path, p.helper_worktree)
  emit({ agentId: p.helper_agent_id, source: 'system', kind: 'launch.helper_done', payload: { repo: repo.name, state, note, ...(why ? { why } : {}) } })
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
 *  already OK'd and heldBack finds nothing against it), and tell the helper what happens next. */
export async function saveLaunch(agent: Agent, input: unknown): Promise<Result> {
  const gone = { ok: false, text: 'HQ is not waiting for start steps from you any more. Stop here.' } as const
  const repoId = repoOf(agent.id), p0 = repoId ? row(repoId) : undefined, repo = repoId ? getRepo(repoId) : undefined
  if (!repoId || !p0 || !repo) return gone
  if (p0.helper_state === 'trying') return { ok: false, text: 'HQ is still running your last steps. End your turn; its message will come.' }
  const checked = checkRecipe(input, p0.helper_worktree ?? repo.path) // the same tree as main: folders and lockfiles are checked there
  if ('error' in checked) return { ok: false, text: `Not saved: ${checked.error}. Fix it and call save_launch again.` }
  const stray = await strayTest(agent, p0, checked.recipe); if (stray) return { ok: false, text: stray }
  const p = row(repoId); if (!p || p.helper_agent_id !== agent.id || !getRepo(repoId)) return gone // stopped or removed meanwhile
  if (p.helper_state === 'trying') return { ok: false, text: 'HQ is still running your last steps. End your turn; its message will come.' }
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
    const why = heldBack(repoId)
    if (!why) {
      void approve(repoId).catch(() => {})
      return { ok: true, text: 'Saved. These are the commands the user already OK\'d, so HQ runs them now. End your turn; HQ messages you the result.' }
    }
    save(repoId, { helper_state: 'needs_ok', helper_note: `${HELD} ${why}.` })
    tellUser(repoId, `${repo.name}: ${HELD} ${why}. OK them in the preview to run them.`)
    return { ok: true, text: `Saved. These are the commands the user already OK'd, but HQ doesn't run them by itself now: ${why}. HQ asks the user to OK them `
      + 'again. End your turn; if they run them, HQ messages you the result.' }
  }
  save(repoId, { helper_state: 'needs_ok', helper_note: null })
  tellUser(repoId, `${repo.name}: Claude worked out how to start the app. Check its steps and OK them in the preview.`)
  return { ok: true, text: 'Saved. HQ is showing the user your commands for an OK. End your turn now; the result of the real run comes to you as a message.' }
}

/** What the user reads when a helper's save only repeats the steps they OK'd and HQ holds it for their OK (Bugs 300, 329). */
const HELD = 'Claude saved the steps you OK\'d again, unchanged. HQ didn\'t start the app by itself:'
/** Bugs 300, 329: when a helper saves the commands the user already OK'd, HQ runs them by itself only while that surprises no one: this app's run is
 *  still on or ended by itself (crashed: "Ask Claude to fix it"), and no other project's app is on (one app at a time, PR #25). A stopped app may
 *  have been stopped by the user after the OK, or for another app; the UI's own OK asks the one-app question first. Otherwise the steps wait for
 *  the user's OK like new ones (why, in words; null: run them now). The owner's call: stopping the other app instead would go here. */
export function heldBack(repoId: string): string | null {
  const other = q<{ id: string }>("SELECT id FROM previews WHERE id != ? AND status IN ('starting', 'running')", repoId).map((x) => getRepo(x.id)).find(Boolean)
  if (other) return `${other.name}'s app is running, and only one app runs at a time`
  if ((row(repoId)?.status ?? 'stopped') === 'stopped') return 'it is stopped'
  return null
}
/** Bugs 300, 329: a held draft only repeats the OK'd steps, so once its helper goes there is nothing new to OK: it is dropped and the steps on file
 *  stay (else the top bar would keep asking to OK them). True when it was. */
function dropRepeat(repoId: string): boolean {
  const p = row(repoId); if (!p?.draft_recipe || !sameCommands(parse(p.recipe), parse(p.draft_recipe))) return false
  save(repoId, { draft_recipe: null }); return true
}

/** Bug 226: a test server of the helper's on a port HQ didn't give it (nor one the recipe fixes) may have been another app answering, and holds a port
 *  another app may need. HQ stops its test servers and refuses the save, which doesn't count, saying why. Null: none found (or a helper from before
 *  ports were given). Only servers still running are seen: the prompt tells the helper not to stop them. */
async function strayTest(agent: Agent, p: NonNullable<ReturnType<typeof row>>, recipe: Recipe): Promise<string | null> {
  const given = helperPorts(p); if (!given.length || !p.helper_worktree) return null
  const pane = await tmux.panePid(agent.tmux_session), group = pane ? await pgidOf(pane) : null, spare = group ? [group] : [] // the helper itself
  const stray = strayPorts((await listenersUnder(p.helper_worktree, spare)).map((l) => l.port), given, recipe); if (!stray.length) return null
  await killUnder(p.helper_worktree, spare)
  emit({ agentId: agent.id, source: 'system', kind: 'launch.test_port', payload: { repo: getRepo(p.id)?.name ?? p.id, ports: stray, given } })
  const one = stray.length === 1
  return `Not saved: your test server${one ? '' : 's'} listened on port${one ? '' : 's'} ${stray.join(', ')}, which HQ didn't give you. Another app on this `
    + `machine may use ${one ? 'it' : 'them'}, so what answered there may not have been yours. HQ stopped your test servers. Try the app again on your `
    + `ports (${given.join(', ')}; $PORT is ${given[0]}, $HQ_TRY_PORTS lists them all), check it answers, then call save_launch again. This save didn't count. `
    + 'A port the project itself hard-wires is fine: give that part that port instead of "auto".'
}

/** The user OK'd the draft: it becomes the repo's recipe and HQ runs it. A helper still on it hears how it went. */
export async function approve(repoId: string): Promise<ReturnType<typeof previewView>> {
  const p = row(repoId), repo = getRepo(repoId); if (!p || !repo) throw new Error('unknown repo')
  if (!p.draft_recipe) throw new Error('No start steps are waiting for your OK.')
  resolveKind(notice(repoId), null)
  const helper = live(p.helper_agent_id)
  save(repoId, { recipe: p.draft_recipe, draft_recipe: null, helper_state: helper ? 'trying' : null, helper_note: null, helper_run: null }) // its run is to come
  emit({ agentId: null, source: 'ui', kind: 'launch.approved', payload: { repo: repo.name } })
  void tryRun(repoId).catch((e) => emit({ agentId: null, source: 'system', kind: 'preview.error', payload: { repo: repo.name, error: String(e) } }))
  return previewView(repo)
}

/** "Not now": the helper stops; its steps stay waiting for an OK (from ⚙ or the pane) without it. */
export async function dismiss(repoId: string): Promise<ReturnType<typeof previewView>> {
  const p = row(repoId), repo = getRepo(repoId); if (!p || !repo) throw new Error('unknown repo')
  resolveKind(notice(repoId), null)
  await finish(repoId, !dropRepeat(repoId) && p.draft_recipe ? 'needs_ok' : null, null)
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
  const tk = triedTicket(repoId, p.helper_ticket_id)
  let started: Awaited<ReturnType<typeof startPreview>>
  try { started = await startPreview(repoId, 'the first run of the start steps you OK\'d', { ticket: tk?.id ?? null, helperRun: true }) } catch (e) {
    if (e instanceof PortTaken) { // the user's own server, not a bad recipe: no save is used up, and the helper is done
      if (helper) sendMessage({ channel: 'dm', from: 'hq', to: helper.id, reason: 'fyi', body: `HQ didn't run it: ${e.message} That's the user's to sort out, not your steps. Stop here.` })
      await finish(repoId, 'port_taken', e.message); return
    }
    return tell(repoId, helper, `HQ couldn't start it: ${(e as Error).message}`)
  }
  return followRun(repoId, helper, started.started_at)
}
/** Waits for the run that started at `since` to answer, crash or time out (3 minutes from its start), and tells the helper how it went.
 *  Bug 361: a run started in its place meanwhile (Restart, Launch, Try it, a merge) runs the same OK'd steps, so its outcome is the helper's: HQ
 *  follows that one instead (the helper was never told, and stayed "trying" until Stop Claude). */
async function followRun(repoId: string, helper: Agent | undefined, since: number | null): Promise<void> {
  let cur = row(repoId), again = false; if (!cur) return
  const cmd0 = cur.command
  for (;;) {
    const end = (since ?? Date.now()) + RUN_WAIT_MS
    while (cur.status === 'starting' && cur.started_at === since && Date.now() < end) { await sleep(1000); cur = row(repoId); if (!cur) return } // removed from HQ
    if (since && stoppedByStop(repoId, since)) return stoppedRun(repoId, helper) // Bug 332: even if started again since
    if (cur.started_at === since) break
    if (!waiting(repoId, helper)) return // OK'd with no helper (the pane shows the new run), or the helper went meanwhile
    // The user set their own ⚙ command, and the app runs that now: nothing will show whether the steps work, so the helper goes, as after a Stop
    if (cur.command && cur.command !== cmd0) return finish(repoId, null, null, 'own_command') // (Bug 332), and the steps stay for ⚙ to go back to
    since = cur.started_at; again = true
    emit({ agentId: helper.id, source: 'system', kind: 'launch.run_restarted', payload: { repo: getRepo(repoId)?.name ?? repoId } })
  }
  const tk = cur.ticket_id ? getTicket(cur.ticket_id) : undefined, where = tk ? `${tk.key}'s version` : 'the user\'s checkout' // the run's own
  const first = again ? 'The app was started again during HQ\'s run of your steps (the user\'s Restart or Launch, or a merge), with the same steps. ' : ''
  const out = (await tmux.paneOutput(previewSession(repoId), 60)).split('\n').slice(-40).join('\n') // its last lines, not the dead pane's blank ones (Bug 302)
  if (cur.status === 'running') {
    if (helper && since) emit({ agentId: helper.id, source: 'system', kind: 'launch.run_answered', // Bugs 332, 360: what launch_ok may confirm
      payload: { repo: getRepo(repoId)?.name ?? repoId, since, recipe: cur.recipe, url: cur.url } })
    return tell(repoId, helper, `${first}Real run on ${where}: the page answered at ${cur.url}. Last output:\n${out}\n\n`
      + 'If this looks right, call launch_ok. If the output shows an error or a missing setting, fix the steps and call save_launch again.')
  }
  if (cur.status === 'starting') await stopPreview(repoId).catch(() => {})
  const what = cur.status === 'starting' ? `no page answered on port ${cur.port} within ${RUN_WAIT_MS / 60_000} minutes` : `it ${cur.detail ?? cur.status}`
  tell(repoId, helper, `${first}Real run on ${where}: ${what}. Last output:\n${out}\n\nFix the steps and call save_launch again.`)
}
/** Bug 332: a Stop ended HQ's first run of the OK'd steps before it answered (the user's Stop, or the one-app dialog's, or a Clear). The user's Stop
 *  wins: nothing showed the steps are wrong, so the helper isn't asked to fix them (it only saved the same ones again, and the OK card came back for
 *  nothing). It goes, as after launch_ok, with nothing to say in the pane, and the OK'd steps stay for the next Launch; if they fail then, the App
 *  tab's "Ask Claude to fix it" or ⚙ brings a helper back. */
async function stoppedRun(repoId: string, helper: Agent | undefined): Promise<void> {
  if (!helper || row(repoId)?.helper_agent_id !== helper.id || !live(helper.id)) return // as tell(): OK'd with no helper, or stopped meanwhile
  await finish(repoId, null, null, 'app_stopped')
}
/** Is this helper still the repo's, live, and waiting to hear how HQ's run of its OK'd steps went? */
const waiting = (repoId: string, helper: Agent | undefined): helper is Agent =>
  !!helper && row(repoId)?.helper_agent_id === helper.id && row(repoId)?.helper_state === 'trying' && !!live(helper.id)
/** Bugs 332, 360: the last run HQ told this helper answered ("call launch_ok") and the recipe it ran. From the events log, not memory: a backend
 *  restart after the answer (Bug 351 picks the run up again) left launch_ok refused once the user pressed Stop, and the helper saved the same steps again. */
function answered(agentId: string): { since: number; recipe: string | null } | undefined {
  const e = one<{ payload: string }>("SELECT payload FROM events WHERE agent_id = ? AND kind = 'launch.run_answered' ORDER BY id DESC LIMIT 1", agentId)
  try { const a = e ? JSON.parse(e.payload) as { since?: unknown; recipe?: unknown } : null
    return a && typeof a.since === 'number' ? { since: a.since, recipe: typeof a.recipe === 'string' ? a.recipe : null } : undefined } catch { return undefined }
}

function tell(repoId: string, helper: Agent | undefined, body: string): void {
  if (!getRepo(repoId)) return
  if (!helper) return // OK'd from ⚙ after "Not now": the pane shows how it went
  if (row(repoId)?.helper_agent_id !== helper.id || !live(helper.id)) return // stopped during the run (Bug 276): it isn't "working" again
  save(repoId, { helper_state: 'working' })
  sendMessage({ channel: 'dm', from: 'hq', to: helper.id, reason: 'fyi', body })
}

/** launch_ok: the helper is happy with the real run. The app keeps running; the helper goes. */
export function launchOk(agent: Agent): Result {
  const repoId = repoOf(agent.id); if (!repoId) return { ok: false, text: 'HQ is not waiting on you any more. Stop here.' }
  const p = row(repoId)!
  if (p.helper_state === 'needs_ok' || p.draft_recipe) return { ok: false, text: 'Your last steps are still waiting for the user\'s OK. End your turn and wait.' }
  // Bug 332: the page answered and HQ told the helper so, then a Stop ended that run: the user's Stop isn't the steps failing
  const a = answered(agent.id), stopped = !!a && a.recipe === p.recipe && stoppedByStop(repoId, a.since)
  if (!p.recipe || (p.status !== 'running' && !stopped)) return { ok: false, text: 'HQ has no working run of your steps yet. Save them with save_launch and wait for HQ\'s message.' }
  setTimeout(() => { void finish(repoId, null, null) }, 1500) // let this answer reach the session first
  return { ok: true, text: `Done.${p.status !== 'running' ? ' The user stopped the app after it answered; HQ keeps your steps.' : ''} HQ ends this session now; do nothing else.` }
}

/** report_cant_start: the app can't run here (it needs Docker, a database server, a key). The user hears why, in its words. */
export function cantStart(agent: Agent, reason: string): Result {
  const repoId = repoOf(agent.id), repo = repoId ? getRepo(repoId) : undefined; if (!repoId || !repo) return { ok: false, text: 'HQ is not waiting on you any more.' }
  tellUser(repoId, `${repo.name}: Claude can't start the app: ${reason}`)
  save(repoId, { draft_recipe: null }) // whatever it saved before is moot now
  setTimeout(() => { void finish(repoId, 'cant_start', reason) }, 1500)
  return { ok: true, text: 'Told the user. HQ ends this session now.' }
}

/** Bug 351: on backend start (after the start-up leftover look, before resumeRestarts), a live helper still waiting to hear how HQ's first run of its
 *  OK'd steps went: tryRun's wait was only in memory, so the helper was never told and the pane said "Running Claude's steps…" until Stop Claude.
 *  A run that hadn't started, or that the last backend was in the middle of starting, starts again; a Stop that ended it (the last backend's, or the
 *  one recoverPreviews finished) lets the helper go as Bug 332's does; else the run is followed again: still starting, it's watched until it answers,
 *  crashes or times out; answered or crashed, the helper hears so at once. */
export function resumeTries(): void {
  for (const p of q<{ id: string }>("SELECT id FROM previews WHERE helper_state = 'trying' AND helper_agent_id IS NOT NULL")) {
    const cur = row(p.id), helper = live(cur?.helper_agent_id ?? null), repo = getRepo(p.id); if (!cur || !helper || !repo) continue // recoverHelpers ended it
    const again = takeRestart(p.id) || !cur.helper_run // its run hadn't started, or the last backend was starting it
    emit({ agentId: helper.id, source: 'system', kind: 'launch.run_resumed', payload: { repo: repo.name, status: cur.status, again } })
    const fail = (e: unknown) => emit({ agentId: null, source: 'system', kind: 'preview.error', payload: { repo: repo.name, error: String(e) } })
    if (again) { void tryRun(p.id).catch(fail); continue }
    if (cur.status === 'stopped' && !cur.detail) { void stoppedRun(p.id, helper).catch(fail); continue } // a Stop's row says nothing more
    void followRun(p.id, helper, cur.started_at).catch(fail)
  }
}

/** A helper that exited by itself, was lost, or was stopped outside this file (Bug 276: its Agent tab's Stop): the repo stops
 *  waiting on it, its test ports go back and its worktree goes. `stoppedWhy`: the stop's reason, when it was stopped. finish()
 *  clears the row before it stops a helper itself, so those stops (and a stray's) don't come back here. */
export function onAgentGone(agentId: string | null, stoppedWhy: string | null = null): void {
  const repoId = agentId ? repoOf(agentId) : null; if (!repoId) return
  if (dropRepeat(repoId)) { void finish(repoId, null, null); return } // it only repeated the OK'd steps: nothing to wait for
  const p = row(repoId)!
  if (p.draft_recipe) { void finish(repoId, 'needs_ok', null); return } // its steps still wait for the user's OK, as after "Not now"
  // Bug 299 (the owner's call): the user's own Stop leaves no banner, as the pane's "Stop Claude" doesn't; only a helper that ended by itself says so
  if (stoppedWhy === 'user') { void finish(repoId, null, null); return }
  void finish(repoId, 'failed', 'Claude stopped before it finished.')
}

/** On backend start, after agents are recovered: helpers that didn't survive the restart are finished, and helper worktrees
 *  nobody owns (HQ stopped mid-job) are removed. */
export async function recoverHelpers(repos: Repo[]): Promise<void> {
  for (const p of q<{ id: string; helper_agent_id: string }>('SELECT id, helper_agent_id FROM previews WHERE helper_agent_id IS NOT NULL')) {
    if (!live(p.helper_agent_id) && dropRepeat(p.id)) await finish(p.id, null, null) // it only repeated the OK'd steps
    else if (!live(p.helper_agent_id)) await finish(p.id, row(p.id)?.draft_recipe ? 'needs_ok' : 'failed', 'HQ restarted while Claude was working it out.')
  }
  for (const repo of repos) await sweepStrays(repo)
}

/** Helpers HQ lost track of (Bug 41): a live launcher for this repo that isn't the one in its preview row is stopped, and every
 *  launch-* worktree that isn't the row's is removed along with the test servers still running in it. */
export async function sweepStrays(repo: Repo): Promise<void> {
  const p = row(repo.id), setup = readSetup(repo.id).job?.agent_id // the test setup helper has the same role, and its own job (testsetup.ts)
  const steps = readSteps(repo.id).job?.agent_id // and so has the test steps helper (teststeps.ts)
  for (const a of liveAgents().filter((x) => x.role === 'launcher' && x.cwd === repo.path && x.id !== p?.helper_agent_id && x.id !== setup && x.id !== steps)) {
    await stopAgent(a.id, 'stray launch helper').catch(() => {})
  }
  for (const w of await listWorktrees(repo.path).catch(() => [])) {
    const helperDir = path.dirname(w.path) === path.join(repo.path, '.claude', 'worktrees') && path.basename(w.path).startsWith('launch-')
    if (helperDir && w.path !== p?.helper_worktree) await removeWorktree(repo.path, w.path)
  }
}

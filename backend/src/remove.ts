// Remove from HQ (Bug 66): HQ forgets a project and leaves its folder exactly as it is. Unlike Clear, nothing here touches the user's work: no WIP commits, no worktrees
// removed, no branches changed. What's running stops at once with no handoff notes (HQ keeps the notes it already has, in its archive), then HQ's rows and its own folders
// for the project go. Adding the folder again later makes a new project. A removal cut short by a crash leaves rows that can simply be removed again.
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.ts'
import { q, run, tx } from './db.ts'
import { bus, emit, patch } from './events.ts'
import { attention } from './attention.ts'
import { agentDir, liveAgents, stopAgent, update } from './agents.ts'
import { autoSettled } from './auto.ts'
import { archive, deleteRepoRows, deleteRows, inList, startingNow, startingWhy, unfinished } from './clear.ts'
import { fallbackNote } from './freshstart.ts'
import { finish, sweepStrays } from './launchhelper.ts'
import { inMergeQueue } from './mergewatch.ts'
import { noteScope, readNote, saveNote } from './notes.ts'
import { row, stopPreview } from './preview.ts'
import { tpmWorkspace, writeProjectMd } from './projectmd.ts'
import { features, getRepo, removing, repoOfAgent, setTicket, tickets } from './records.ts'
import { syncDone } from './repos.ts'
import { sweepTestWorktrees } from './testrun.ts'
import { rememberGone, sweepNow } from './leftovers.ts'
import { sleep } from './util.ts'

const SETTLE_MS = Number(process.env.HQ_REMOVE_SETTLE_MS ?? 10_000)
const ofRepo = (repoId: string) => { const fids = new Set(features().filter((f) => f.repo_id === repoId).map((f) => f.id)); return tickets().filter((t) => fids.has(t.feature_id)) }

/** Every agent of the repo that still runs. Each one's fresh start is called off first, or the sweep would start a successor. HQ writes a note from its records only for
 *  unfinished work with none yet: a real note stays as it is. */
async function stopAll(repoId: string): Promise<void> {
  const tks = ofRepo(repoId)
  for (const a of liveAgents().filter((x) => repoOfAgent(x) === repoId)) {
    if (a.fresh_start_at) update(a.id, { fresh_start_at: null, fresh_start_then: null, fresh_start_msg: null })
    const scope = noteScope(a)
    if (scope && unfinished(a, tks) && !readNote(scope)) saveNote(a, fallbackNote(a, 'the project was removed from HQ'))
    await stopAgent(a.id, 'removed from HQ').catch(() => {})
  }
}

/** `landing`: the project the user ends up on, where the notice saying where the archive went shows. */
export async function removeRepo(repoId: string, landing: string | null = null): Promise<{ archive: string }> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  if (repo.clearing_at) throw new Error(`${repo.name} is being cleared; wait until it's done.`)
  if (removing.has(repoId)) throw new Error(`${repo.name} is already being removed.`)
  const busy = startingNow(repoId); if (busy.length) throw new Error(startingWhy(busy))
  removing.add(repoId)
  try {
    tx(() => { // first: a stop below frees a slot, and nothing of this repo may start in it
      run('UPDATE repos SET auto_mode = 0, auto_stopped_why = NULL, auto_waiting = NULL WHERE id = ?', repoId)
      for (const t of ofRepo(repoId).filter((x) => x.go_ahead)) setTicket(t.id, { go_ahead: 0 })
    })
    patch('repo', repoId, { auto_mode: 0, auto_stopped_why: null, auto_waiting: null })
    await stopPreview(repoId).catch(() => {}) // also waits for a start or stop already under way
    const p = row(repoId); if (p?.helper_agent_id || p?.helper_worktree) await finish(repoId, null, null).catch(() => {}) // only HQ's own scratch worktree goes
    await sweepStrays(repo).catch(() => {})
    await sweepTestWorktrees(repo.path).catch(() => {})
    await stopAll(repoId)
    // A merge, a test, an auto tick or a sync may still be on its way out. Bounded: a stuck one mustn't hold up a removal, and the late writers each check the repo is still there.
    await Promise.race([Promise.allSettled([inMergeQueue(repoId, async () => {}), autoSettled(), syncDone(repoId)]), sleep(SETTLE_MS)])
    await sweepTestWorktrees(repo.path).catch(() => {}); await stopAll(repoId)

    const fs0 = features().filter((f) => f.repo_id === repoId), F = fs0.map((f) => f.id), tks = ofRepo(repoId), T = tks.map((t) => t.id)
    const A = q<{ id: string }>(`SELECT id FROM agents WHERE repo_id = ? OR ${inList('feature_id', F)} OR ${inList('ticket_id', T)}`, repoId, ...F, ...T).map((r) => r.id) // Launch helpers too
    writeProjectMd(repoId)
    rememberGone(repoId); await sweepNow() // what its engineers left running in the worktrees (Bug 75); the folders themselves stay
    const dir = archive(repo, fs0, tks, new Map(), 'removed') // first: if this fails nothing is lost, and removing again works
    tx(() => { deleteRows(repoId, F, T, A); deleteRepoRows(repoId) })
    for (const a of A) fs.rmSync(agentDir(a), { recursive: true, force: true })
    for (const d of [path.dirname(tpmWorkspace(repoId)), path.join(PATHS.projects, repoId), path.join(PATHS.home, 'previews', repoId), ...F.map((f) => path.join(PATHS.workspaces, f))]) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    emit({ agentId: null, source: 'ui', kind: 'repo.removed', payload: { repo: repo.name, path: repo.path, archive: dir, features: F.length, tickets: T.length, agents: A.length } })
    attention(landing && getRepo(landing) ? `project_removed:${landing}` : 'project_removed',
      `Removed ${repo.name} from HQ. Its folder wasn't touched. HQ's notes on it are in ${dir.replace(process.env.HOME ?? '\0', '~')}.`)
    bus.emit('resnapshot') // every tab drops it at once (ui.ts)
    return { archive: dir }
  } finally { removing.delete(repoId) }
}

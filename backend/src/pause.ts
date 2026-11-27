// Bug 195: a paused role. HQ pauses a role when one of its agents switches models by itself (modelguard.ts): until the user presses Resume, nothing of
// that role may run on a model nobody chose. A pause used to hold back only the messages for the role's agents; one already at work went on working, and
// spending. Now a paused role's agents are stopped as well:
//  - a turn of its own that is at work gets Escape in its terminal (stopForPause), when the pause comes and whenever such a turn starts or takes a step
//    during it (hooks.ts). A helper's end or a run in the background starts one by itself, and Escape doesn't stop a helper (both seen on 2.1.322);
//  - every tool step of the agent or of a helper of its is refused meanwhile (PAUSE_NOTE), which is what ends a helper;
//  - its messages wait, as before (delivery.ts nextBatchFor, stepNotes), an urgent one too (ui.ts).
// Resume lets the messages go and tells each agent HQ stopped to carry on. Its turn was interrupted, so HQ types that into its terminal (Bug 110).
import { now, setSetting } from './db.ts'
import { emit, patch } from './events.ts'
import { getAgent, liveAgents, onDialog, update, type Agent } from './agents.ts'
import { openAttention, resolveAttention } from './attention.ts'
import { inTerminal, pausedRoles, sendMessage } from './delivery.ts'
import * as tmux from './tmux.ts'
import { paneAtWork, paneShowsDialog, plainScreen } from './screen.ts'
import { wakeAll } from './wake.ts'

/** A role's agents in a sentence: "engineers", "TPMs". */
export const roleWord = (role: string): string => role === 'tpm' ? 'TPMs' : role === 'launcher' ? 'Launch helpers' : `${role}s`
/** HQ holds this agent back because its role is paused. Not one that writes its handoff note (a fresh start, a Clear, a switch of projects): the user
 *  asked for its session to end, the note is how it ends, and stopping it there would leave the Clear waiting for a note that never comes. */
export const heldByPause = (a: Agent): boolean => a.status !== 'exited' && !a.fresh_start_at && pausedRoles().includes(a.role)
/** What a refused tool step says while the role is paused. The agent's own turn gets Escape as well; for a helper this is all there is. */
export const PAUSE_NOTE = "HQ: the user's HQ has paused you (every agent of your role), so this step was not run. Don't try it again and don't do anything else: "
  + 'end your turn now with one short line saying you were paused. HQ sends you a message when the pause is over, and you carry on from here then.'
const CARRY_ON = 'HQ: the pause is over, carry on. HQ stopped you in the middle of your work while your role was paused (the user has now pressed Resume). '
  + 'The step you were on was cut off and may be half done (a command, an edit, a helper): check where things stand first, then go on from there. '
  + 'Anything sent to you meanwhile comes with this message.'

const setPaused = (roles: string[]): void => { setSetting('paused_roles', roles); patch('setting', 'paused_roles', { value: roles }) } // the page shows it at once
/** Pauses a role: its agents' messages wait and whatever they are doing is stopped, until resumeRole. */
export function pauseRole(role: string, reason: string): void {
  const paused = pausedRoles(); if (!paused.includes(role)) setPaused([...paused, role])
  emit({ agentId: null, source: 'system', kind: 'role.paused', payload: { role, reason } })
  for (const a of liveAgents()) if (a.role === role) stopForPause(a.id, 'pause')
}
/** The user's Resume: the role's messages go again, each agent HQ stopped is told to carry on, and the notice that asked for the Resume is answered. */
export function resumeRole(role: string): void {
  setPaused(pausedRoles().filter((r) => r !== role))
  emit({ agentId: null, source: 'system', kind: 'role.resumed', payload: { role } })
  for (const a of liveAgents()) if (a.role === role && a.pause_stopped_at) tellCarryOn(a)
  for (const n of openAttention()) if (n.kind === 'model_fallback' && n.agent_id && getAgent(n.agent_id)?.role === role) resolveAttention(n.id)
  wakeAll()
}
/** One message, once, to an agent whose turn HQ cut short: only it has something to pick up again. An agent that sat idle through the pause gets none
 *  (it could do nothing with it), only the messages that waited for it. */
function tellCarryOn(a: Agent): void {
  update(a.id, { pause_stopped_at: null })
  sendMessage({ repoId: a.repo_id, featureId: a.feature_id, channel: 'dm', from: 'hq', to: a.id, reason: 'fyi', body: CARRY_ON })
  emit({ agentId: a.id, source: 'system', kind: 'agent.pause_over', payload: {} })
}
/** HQ refused a tool step of the agent's own for the pause (hooks.ts): its turn is being cut short, so it is owed the "carry on" at Resume, whether or
 *  not the Escape that follows finds anything left to stop. */
export function pauseRefused(a: Agent): void {
  if (!a.pause_stopped_at) update(a.id, { pause_stopped_at: now() })
  stopForPause(a.id, 'step')
}

const SETTLE_MS = Number(process.env.HQ_PAUSE_SETTLE_MS ?? 1500), LOOK_MS = 300, PROMPT_LOOKS = 8
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
type Why = 'pause' | 'prompt' | 'step'
/** Agents with a stop under way, each with the request that came meanwhile, if any (it runs next: the one under way may have looked too early). */
const queued = new Map<string, Why | null>()
/** How many agents have a stop under way (tests). */
export const stopsUnderWay = (): number => queued.size
/** Stops the turn a paused agent has at work: Escape in its terminal, as a person would press it. Only into a screen that shows a turn at work: an idle
 *  prompt has nothing to stop (and Escape there twice clears a line somebody typed), and on a menu or a dialog Escape would answer it (an agent waiting
 *  there spends nothing; once it is answered and the agent moves on, its next step brings HQ back here). `why`: the pause itself, a turn that started
 *  during it ('prompt': its screen may take a moment to show it, so HQ looks a few times), or a step of a turn that is still going ('step').
 *  One at a time per agent, in turn with whatever HQ types there (delivery.ts inTerminal), and the lock is kept until the interrupted turn has wound
 *  down: a second Escape on its heels could hit the prompt box. Nothing is sent once the pause is over or the agent has gone. */
export function stopForPause(agentId: string, why: Why): void {
  if (queued.has(agentId)) { if (why === 'prompt' || !queued.get(agentId)) queued.set(agentId, why); return }
  queued.set(agentId, null)
  inTerminal(agentId, () => stopNow(agentId, why)).catch((e) => emit({ agentId, source: 'system', kind: 'backend.error', payload: { server: 'pause', error: String(e) } }))
    .finally(() => { const next = queued.get(agentId); queued.delete(agentId); if (next) stopForPause(agentId, next) })
}
async function stopNow(agentId: string, why: Why): Promise<void> {
  for (let look = 0; look < (why === 'prompt' ? PROMPT_LOOKS : 1); look++) {
    if (look) await sleep(LOOK_MS)
    const was = getAgent(agentId); if (!was || !was.tmux_session || !heldByPause(was)) return // no terminal of its own: tmux would take "no name" for the current one
    const styled = await tmux.visiblePaneStyled(was.tmux_session)
    const a = getAgent(agentId); if (!a || !heldByPause(a)) return // read again: the look took a moment, and a Resume may have come
    if (onDialog(a) || a.status === 'plan_review' || paneShowsDialog(plainScreen(styled))) return
    if (!paneAtWork(styled)) continue
    await tmux.sendEscape(a.tmux_session)
    const now_ = getAgent(agentId); if (!now_ || now_.status === 'exited') return
    if (!now_.pause_stopped_at) update(agentId, { pause_stopped_at: now() })
    emit({ agentId, source: 'system', kind: 'agent.pause_stopped', payload: { why } })
    if (!heldByPause(now_)) tellCarryOn(getAgent(agentId)!) // resumed while the Escape was on its way: it is stopped all the same
    await sleep(SETTLE_MS); return
  }
}

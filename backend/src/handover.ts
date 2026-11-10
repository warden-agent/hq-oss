// The briefings HQ writes for new sessions: the project's TPM (Bug 52) and an engineer taking over a ticket, from HQ's records.
import { fixWords } from './conflicts.ts'
import { unmergedDeps } from './readiness.ts'
import type { Message } from './delivery.ts'
import type { Feature, Repo, Ticket } from './records.ts'

/** Where a ticket stands, in words, for a TPM taking over. */
function standing(t: Ticket, all: Ticket[]): string {
  const waits = unmergedDeps(t, all)
  switch (t.status) {
    case 'queued': return waits.length ? `waits for ${waits.join(', ')} to merge` : 'ready to start (the user starts it from HQ)'
    case 'planning': return 'an engineer is writing its plan'
    case 'plan_review': return "its plan waits for the user's review"
    case 'implementing': return 'an engineer is building it'
    case 'awaiting_answer': return 'its engineer waits for an answer'
    case 'escalated': return 'escalated to the user'
    case 'pr_ready': return t.pr_state === 'local' ? 'finished; waits for the user to merge it' : 'finished and pushed; its PR still needs opening'
    case 'pr_open': return `finished; PR #${t.pr_number} waits for the user's merge`
    case 'resolving': return `its engineer is ${fixWords(t.fixing, 'main').ing}`
    default: return t.status
  }
}
/** The launch prompt of the project's TPM (Bug 52), built from HQ's records, never from an old session. `previous`: the session
 *  it takes over from (a fresh start, a resume, a TPM that stopped), with its handoff note. `cleared`: the user just cleared the
 *  board. `message`: what the user just wrote, when that is what starts it. PROJECT.md and features/ have the rest. */
export function tpmPrompt(repo: Repo, o: { ws: string; previous: string | null; note?: string | null; board: { f: Feature; tickets: Ticket[] }[];
  messages: Message[]; message?: string | null; cleared?: boolean; context?: boolean; localOnly?: boolean }): string {
  const name = (f: Feature) => f.handle ? `${f.handle} ${f.title}` : f.title
  const board = o.board.map(({ f, tickets }) => `- ${name(f)}\n${tickets.map((t) => `  - ${t.key} (${t.size}) ${t.title}: ${standing(t, tickets)}${t.branch ? ` · branch ${t.branch}` : ''}`)
    .join('\n') || '  - no tickets yet'}`).join('\n')
  const talk = o.messages.map((m) => `- ${m.from_id === 'user' ? 'User' : 'TPM'}: ${m.body.length > 400 ? `${m.body.slice(0, 400)}…` : m.body}`).join('\n')
  const head = o.previous || o.note
    ? `You are taking over as the TPM of project "${repo.name}" (read-only copy at ${repo.path}; your workspace is ${o.ws}). The previous TPM session`
      + `${o.previous ? ` (${o.previous})` : ''} has ended; nothing from it carries over except what is written here, in PROJECT.md and in features/.`
    : `You are the TPM of project "${repo.name}" (read-only copy at ${repo.path}; your workspace is ${o.ws}).`
  const files = ' PROJECT.md in your workspace says what the project is, what has been built so far and what is on the board; features/ has each open'
    + ' feature\'s request, tickets, decisions and specs. HQ keeps both up to date.'
  const cleared = o.cleared ? '\n\nThe user just cleared the board: every ticket that was on it is gone (their code stays on their branches). They are not open'
    + ' work any more; don\'t bring them up as such. "Built so far" in PROJECT.md is what exists in the code.' : ''
  const extra = (o.context ? '\n\nCONTEXT.md in your workspace is what the user asked for when this project started; keep it in mind.' : '')
    + (repo.auto_mode ? '\n\nAuto mode is on for this project: follow the Auto mode rule in your instructions.' : '')
    + (o.localOnly ? `\n\nHQ can't push to ${repo.name}, so nothing in it goes to GitHub: no PRs; the user merges finished tickets into the local ${repo.default_branch} from HQ.` : '')
  const note = o.note ? `\n\nThe previous TPM's handoff note (HQ's ticket list above is the truth for statuses):\n${o.note}` : ''
  const ask = o.message
    ? `\n\nThe user's new message, verbatim:\n"""\n${o.message}\n"""\n\nAct on it. New work: start_feature, then create_ticket for each ticket (S/M/L, spec with acceptance criteria,`
      + ' expected_files, depends_on), set_merge_order, and tell the user the breakdown in a few lines; don\'t assign tickets unless they ask you to start now.'
      + ' A question or a change to existing work: answer it, or update the tickets it touches.'
    : o.previous || o.note ? '\n\nFirst read PROJECT.md and call list_tickets, then tell the user in two or three lines where things stand and what happens next.' : ''
  return `${head}${files}${cleared}${extra}\n\nOn the board now:\n${board || '- nothing'}${talk ? `\n\nLast messages between the user and the TPM, oldest first:\n${talk}` : ''}`
    + `${note}${ask}\n\nDo not create or re-split tickets that already exist. Use assign_ticket only when the user asks you to.`
}

/** What HQ read from git about a ticket's branch for the engineer taking over (each part already cut to size). */
export type GitFacts = { status: string; diffStat: string; log: string }
/** The launch prompt of an engineer taking over a ticket after a fresh start: the goal, the last engineer's note, what git
 *  shows, and the approved plan or HQ's instructions for what it went back for (conflicts or its tests, Bug 84). Not the update_handoff log: get_ticket has it if needed. */
export function engineerResumePrompt(t: Ticket, o: { feature: string; worktree: string; base: string; note: string | null; git: GitFacts; plan: string | null; fix: string | null }): string {
  const where = t.status === 'planning' ? 'Its plan was not written or not approved yet: finish exploring, write the plan and call ExitPlanMode.'
    : o.fix ? `It was ${fixWords(t.fixing, o.base).ing}; HQ's instructions for that are below.`
    : 'Its plan is approved (below) and the work is under way: carry on from where the last engineer stopped. Don\'t redo finished steps.'
  return `You are taking over ticket ${t.key} (${t.size}): ${t.title}
Feature: ${o.feature}
Branch: ${t.branch} (your worktree: ${o.worktree})

The previous engineer's session ended for a fresh start; nothing from it carries over except what is written here. ${where}
Git is the truth for what exists: if the note and git disagree, trust git.

## Spec
${t.spec ?? ''}

## The previous engineer's handoff note
${o.note ?? '(none)'}

## What git shows (against ${o.base})
Uncommitted changes:
${o.git.status || '(none)'}

Commits on this branch:
${o.git.log || '(none)'}

Changed files since ${o.base}:
${o.git.diffStat || '(none)'}
${o.plan ? `\n## Approved plan\n${o.plan}\n` : ''}${o.fix ? `\n## HQ's instructions\n${o.fix}\n` : ''}`
}

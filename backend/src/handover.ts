// The briefings HQ writes for new sessions: the project's TPM (Bug 52) and an engineer taking over a ticket, from HQ's records.
import { fixWords } from './conflicts.ts'
import { unmergedDeps } from './readiness.ts'
import type { Message } from './delivery.ts'
import { hqMoves, type Feature, type Repo, type Ticket } from './records.ts'
import { criteriaBlock, criteriaOf } from './criteria.ts'

/** Where a ticket stands, in words, for a TPM taking over. Bug 193: on auto, HQ starts, checks, tests and merges tickets (autoOnWords), so the words say
 *  so. Not a parked ticket, and nothing starts or merges while auto mode is stopped (plans are still checked): the user does, as the board's buttons say. */
function standing(t: Ticket, all: Ticket[], repo: Repo): string {
  const on = !!repo.auto_mode && !t.auto_parked_why, hq = hqMoves(repo, t), main = repo.default_branch // Bug 210: the project's own, say master
  const waits = unmergedDeps(t, all)
  const now = ((): string => {
    switch (t.status) {
      case 'queued': return waits.length ? `waits for ${waits.join(', ')} to merge` : t.go_ahead ? 'started: HQ starts an engineer on it when a slot frees up (Bug 127)'
        : hq ? 'ready; HQ starts it when your turn ends' : 'ready to start (the user starts it from HQ)'
      case 'planning': return 'an engineer is writing its plan'
      case 'plan_review': return on ? 'HQ checks its plan, then approves it or sends it back' : "its plan waits for the user's review"
      case 'implementing': return 'an engineer is building it'
      case 'awaiting_answer': return 'its engineer waits for an answer'
      case 'escalated': return 'escalated to the user'
      case 'pr_ready': return t.pr_state === 'local' ? `finished; ${hq ? `HQ tests it on ${main} and merges it` : 'waits for the user to merge it'}`
        : `finished and pushed; ${hq ? `HQ tests it on ${main}, opens its PR and merges it` : 'its PR still needs opening'}`
      case 'pr_open': return hq ? `finished; HQ tests PR #${t.pr_number} on ${main} and merges it` : `finished; PR #${t.pr_number} waits for the user's merge`
      case 'resolving': return `its engineer is ${fixWords(t.fixing, main).ing}`
      default: return t.status
    }
  })()
  return repo.auto_mode && t.auto_parked_why ? `${now} (auto mode parked it: ${t.auto_parked_why.replace(/\.$/, '')})` : now
}
/** What each mode means, for the TPM: its launch prompt (Bug 163) and HQ's notice when the user switches auto mode (auto.ts setAuto). `base`: the
 *  project's default branch, which HQ tests on and merges into (Bug 210: not always main). */
export const autoOnWords = (base: string): string => `HQ starts ready tickets when your turn ends, approves plans, tests finished tickets on ${base}, merges them`
  + ' and fixes conflicts'
export const AUTO_OFF_WORDS = 'the user starts tickets, approves plans and merges from HQ, and HQ runs no tests before a merge'
/** Bug 163: the mode either way, never only when it's on. A TPM started after the user turned auto off (with no TPM running to be told)
 *  had only its history, written while auto was on ("HQ ran the tests before each merge"), and repeated it. `history`: messages or a
 *  note from earlier sessions are in the prompt, which may come from the other mode. */
function autoLine(repo: Repo, history: boolean): string {
  return repo.auto_mode ? `Auto mode is on for this project: ${autoOnWords(repo.default_branch)}. Follow the Auto mode rule in your instructions.`
    + (repo.auto_stopped_why ? ` It is stopped right now (${repo.auto_stopped_why.replace(/\.$/, '')}): nothing starts or merges by itself until the user presses`
      + ' Resume, and meanwhile the user starts and merges tickets from HQ.' : '') // Bug 193: the board's lines say "the user" then
    + (history ? ' If earlier messages or the handoff note say the user starts or merges tickets, that was while auto mode was off.' : '')
    : `Auto mode is off for this project: ${AUTO_OFF_WORDS}. Don't tell the user HQ tested or merged anything by itself; each "merged" notice says what HQ ran.`
    + (history ? ' If earlier messages or the handoff note say HQ starts, tests or merges tickets by itself, that was while auto mode was on.' : '')
}
/** The launch prompt of the project's TPM (Bug 52), built from HQ's records, never from an old session. `previous`: the session
 *  it takes over from (a fresh start, a resume, a TPM that stopped), with its handoff note. `cleared`: the user just cleared the
 *  board. `message`: what the user just wrote, when that is what starts it. PROJECT.md and features/ have the rest. */
export function tpmPrompt(repo: Repo, o: { ws: string; previous: string | null; note?: string | null; board: { f: Feature; tickets: Ticket[] }[];
  messages: Message[]; message?: string | null; cleared?: boolean; context?: boolean; localOnly?: boolean }): string {
  const name = (f: Feature) => f.handle ? `${f.handle} ${f.title}` : f.title
  const board = o.board.map(({ f, tickets }) => `- ${name(f)}\n${tickets.map((t) => `  - ${t.key} (${t.size}) ${t.title}: ${standing(t, tickets, repo)}${t.branch ? ` · branch ${t.branch}` : ''}`)
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
    + `\n\n${autoLine(repo, o.messages.length > 0 || !!o.note)}`
    + (o.localOnly ? `\n\nHQ can't push to ${repo.name}, so nothing in it goes to GitHub: no PRs; ${repo.auto_mode ? 'HQ merges' : 'the user merges'} finished tickets into the local`
      + ` ${repo.default_branch}${repo.auto_mode ? '' : ' from HQ'}.` : '')
  const note = o.note ? `\n\nThe previous TPM's handoff note (HQ's ticket list above is the truth for statuses):\n${o.note}` : ''
  const ask = o.message
    ? `\n\nThe user's new message, verbatim:\n"""\n${o.message}\n"""\n\nAct on it. New work: start_feature, then create_ticket for each ticket (S/M/L, spec, criteria,`
      + ' expected_files, depends_on), set_merge_order, and tell the user the breakdown in a few lines; don\'t assign tickets unless they ask you to start now.'
      + ' Write criteria as your instructions say: checkable from outside, ui or backend, no file or function names, failure cases covered.'
      + (repo.auto_mode ? '' : ' Ask the user to read each ticket\'s criteria on its box before they start it.')
      + ' A question or a change to existing work: answer it, or update the tickets it touches.'
    : o.previous || o.note ? '\n\nFirst read PROJECT.md and call list_tickets, then tell the user in two or three lines where things stand and what happens next.' : ''
  return `${head}${files}${cleared}${extra}\n\nOn the board now:\n${board || '- nothing'}${talk ? `\n\nLast messages between the user and the TPM, oldest first:\n${talk}` : ''}`
    + `${note}${ask}\n\nDo not create or re-split tickets that already exist. Use assign_ticket only when the user asks you to.`
}

/** What HQ read from git about a ticket's branch for the engineer taking over (each part already cut to size). */
export type GitFacts = { status: string; diffStat: string; log: string }
/** Bug 184 (and 143): the branch got commits after the commit an open_pr handed over. `merged`: HQ merged that one into main meanwhile. `commits`: what is
 *  on the branch and not in main (or not handed over), one "sha subject" each. */
export type LateCommits = { merged: string | null; finished: string | null; commits: string[] }
export const lateWords = (l: LateCommits, base: string): string => {
  const list = l.commits.map((c) => `- ${c}`).join('\n')
  return (l.merged ? `HQ already merged the commit an earlier open_pr handed over (${l.merged.slice(0, 7)}) into ${base}, as it passed HQ's tests: that part of the `
    + `ticket is done, don't redo it. These commits came after it, while it merged, and aren't in ${base} yet:`
    : `The last open_pr handed over ${l.finished?.slice(0, 7) ?? 'an earlier commit'}, so HQ hasn't merged the ticket: these commits came after it:`)
    + `\n${list}\nCheck they finish what they started, run the tests, commit, then call open_pr again (with the same tests): HQ tests ${l.merged ? 'them' : 'it'} and `
    + `merges ${l.merged ? 'them' : 'it'}.`
}
/** The launch prompt of an engineer taking over a ticket after a fresh start: the goal, the last engineer's note, what git
 *  shows, and the approved plan or HQ's instructions for what it went back for (conflicts or its tests, Bug 84). Not the update_handoff log: get_ticket has it if needed. */
export function engineerResumePrompt(t: Ticket, o: { feature: string; worktree: string; base: string; note: string | null; git: GitFacts; plan: string | null; fix: string | null;
  late?: LateCommits | null }): string {
  const where = t.status === 'planning' ? 'Its plan was not written or not approved yet: finish exploring, write the plan and call ExitPlanMode.'
    : o.fix ? `It was ${fixWords(t.fixing, o.base).ing}; HQ's instructions for that are below.`
    : o.late ? `Its plan is approved (below) and it was finished once. ${lateWords(o.late, o.base)}`
    : 'Its plan is approved (below) and the work is under way: carry on from where the last engineer stopped. Don\'t redo finished steps.'
  return `You are taking over ticket ${t.key} (${t.size}): ${t.title}
Feature: ${o.feature}
Branch: ${t.branch} (your worktree: ${o.worktree})

The previous engineer's session ended for a fresh start; nothing from it carries over except what is written here. ${where}
Git is the truth for what exists: if the note and git disagree, trust git.

## Spec
${t.spec ?? ''}
${criteriaBlock(criteriaOf(t))}
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

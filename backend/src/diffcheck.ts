// The diff check: before auto mode merges a ticket that is worth a second look, a fresh reader (checker.ts) sees its acceptance criteria, its changes against
// main and what the test run printed, and nothing of the engineer's plan or reasoning. It answers: is a criterion not met, and is there a concrete bug?
// Only when triggered, so tokens go where judgment is needed: a size M or L ticket, or one that git or the plan check flagged (deleted or cut tests, files
// outside the plan, a criterion with no test, a plan that was sent back or never checked). A small clean ticket merges on its tests and HQ's look alone.
// The same rules as the plan check: at most three findings, each about a criterion or a concrete bug, and one send-back per ticket. A ticket is read once
// per commit its open_pr names (readAgain); a read that can't be had (the call fails) never holds the merge: the summary says nobody read it.
import { execFile } from 'node:child_process'
import { now } from './db.ts'
import { ask } from './checker.ts'
import { findingLines, type DiffCheck, type Finding, type PlanCheck } from './checks.ts'
import { criteriaLines, type Criterion, type Proof } from './criteria.ts'

/** Why a ticket's changes get a reader, in words for the user; none means it merges without one. */
export function whyRead(t: { size: string }, proof: Proof | null, plans: PlanCheck[]): string[] {
  const size = t.size.toUpperCase(), f = proof?.flags
  return [
    size === 'M' || size === 'L' ? `it is a size ${size} ticket` : '',
    f?.tests_deleted.length ? 'it deleted tests' : '', f?.tests_cut.length ? 'it took lines out of existing tests' : '', f?.outside.length ? 'it changed files outside the ones planned for it' : '',
    proof?.tests.some((e) => e.cant_test) ? 'one of its criteria has no test' : '',
    plans.some((c) => c.state === 'sent_back') ? 'its plan was sent back once' : plans.some((c) => c.state === 'unchecked') ? 'its plan was never checked' : '',
  ].filter(Boolean)
}

/** Bug 185: does a ticket get a reader at `head`, the commit its open_pr named, after `last`, its last read? Each commit open_pr names is read, all of its
 *  changes against main (as the first read): a later commit can break a criterion the first one met. Tested again at the same commit (main moved meanwhile),
 *  it isn't read again. A read that couldn't be had is tried again. A ticket sent back merges on its next pass without another read: one send-back each. */
export const readAgain = (last: DiffCheck | null, head: string): boolean => !last || last.state === 'unchecked' || (last.state === 'ok' && last.sha !== head)

export const DIFF_SYSTEM = `You are a second reader for a finished software ticket, just before it is merged. You see only the ticket's acceptance criteria, its changes
as a diff against the main branch, and what the test run printed. You do not see the plan, the rest of the code, or the engineer's reasoning. The tests passed.
Look for two things.

1. A criterion the changes do not meet: nothing in the diff does what it asks, or the code does something else.
2. A concrete bug in the changed code: a case you can name (an input, a state, an order of events) where this code does the wrong thing or crashes.

Rules:
- At most three findings, the most serious first.
- Each finding is about one criterion (give its id, like A2) or is "bug".
- A bug names the file, the case, and what goes wrong. If you cannot name the case, it is not a finding.
- Each says in one or two plain sentences what is wrong and what to change.
- Nothing about style, naming, structure, or how you would have built it. No "consider", no "could be more robust", no asking for more tests.
- The diff may be cut short, and code it doesn't show may handle what you are worried about: never report what you cannot see.
- If you are not sure something is a problem, it is not a finding.
- verdict is "send_back" only with at least one finding. Otherwise "ok", with no findings.`
const MAX_DIFF = 60_000, MAX_OUTPUT = 2000
/** Files whose diff tells a reader nothing and can be thousands of lines: lockfiles. They are named in the list of changed files, not shown. */
const NOT_SHOWN = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Cargo.lock', 'go.sum']
/** git with room for a big diff (HQ's usual helper stops at 1 MB of output). */
const git = (cwd: string, args: string[]): Promise<string> => new Promise((resolve, reject) =>
  execFile('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
    (err, out, errOut) => err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out)))
/** What a reader is shown of a branch's changes since it left `base`: every changed file with its line counts, then the diff, cut at a size a reader takes in
 *  at once (and said to be cut). */
export async function diffFor(repoPath: string, base: string, branch: string): Promise<string> {
  const fork = (await git(repoPath, ['merge-base', base, branch])).trim()
  const stat = (await git(repoPath, ['diff', '--stat=120', '--no-color', fork, branch])).trimEnd()
  const body = await git(repoPath, ['diff', '--no-color', '--no-ext-diff', fork, branch, '--', '.', ...NOT_SHOWN.map((f) => `:(exclude,glob)**/${f}`)])
  const cut = body.length > MAX_DIFF ? `${body.slice(0, body.lastIndexOf('\n', MAX_DIFF))}\n\n(The diff is cut here: ${body.length - MAX_DIFF} more characters are not shown.)` : body.trimEnd()
  return `Changed files:\n${stat}\n\n${cut}`
}
export function diffPrompt(o: { criteria: Criterion[]; diff: string; test: string; output: string }): string {
  const out = o.output.length > MAX_OUTPUT ? `…\n${o.output.slice(-MAX_OUTPUT)}` : o.output
  return `## Acceptance criteria\n${o.criteria.length ? criteriaLines(o.criteria) : '(This ticket has no list of criteria: look for bugs only.)'}\n\n`
    + `## The changes, as a diff against the main branch\n${o.diff}\n\n## What the test run printed (\`${o.test}\`, which passed)\n${out || '(nothing)'}\n`
}
/** What the engineer is told when its ticket goes back: the findings, as the reader wrote them. */
export const readReport = (findings: Finding[]): string => `What the reader found:\n${findingLines(findings)}`

/** Asks the reader about a ticket's changes, once. The record HQ keeps: nothing found, the findings that send it back, or why nobody could be asked.
 *  `stopped`: `signal` ended it (auto mode went off or stopped): nothing follows. */
export async function readDiff(o: { repoPath: string; base: string; branch: string; criteria: Criterion[]; why: string[]; test: string; output: string; signal: AbortSignal }):
  Promise<DiffCheck | 'stopped'> {
  let diff: string
  try { diff = await diffFor(o.repoPath, o.base, o.branch) } catch (e) {
    return { state: 'unchecked', at: now(), why: o.why, error: `HQ couldn't work out its changes (${(e as Error).message.split('\n')[0]})` }
  }
  if (o.signal.aborted) return 'stopped'
  const a = await ask({ system: DIFF_SYSTEM, prompt: diffPrompt({ criteria: o.criteria, diff, test: o.test, output: o.output }), ids: o.criteria.map((c) => c.id), other: 'bug', signal: o.signal })
  if (a.kind === 'stopped') return 'stopped'
  if (a.kind === 'error') return { state: 'unchecked', at: now(), why: o.why, error: `the reader couldn't be asked (${a.why})` }
  const cost = { at: now(), ms: a.ms, tokens: a.tokens, model: a.model }
  return a.findings.length ? { state: 'sent_back', why: o.why, findings: a.findings, ...cost } : { state: 'ok', why: o.why, ...cost }
}

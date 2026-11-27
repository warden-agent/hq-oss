// Bug 162: an engineer ran only its own test file before open_pr and wrote "Full suite is just that file". It never ran `npm test`, so it missed a
// failing test in the repo's other test file. With auto mode on, HQ runs the project's test command itself before a merge; with it off nothing
// did. So with auto off, open_pr needs to have seen the project's test command run on the ticket after its last file edit, and a before_pr
// handoff written after that run (it says what the run reported). The command is the one HQ's merge check runs (Bug 96): the saved one, or with
// none saved the one HQ finds in the worktree. No command HQ can find, or one Claude Code refuses for engineers (Bug 107): nothing to check.
// The runs are read from the events (hooks.ts marks each Bash call that ran the command), so a restart or a takeover doesn't lose them.
// Bug 194: a change made through Bash (`sed -i`, `git merge main`, a script) is no Edit/Write, so each run also keeps what the worktree's files
// held when it was over (worktreeState), and open_pr compares that with what they hold now.
// Bug 213: that state is taken when the whole Bash line is over, so `npm test && sed -i … && git commit` slipped through. Taking it before every
// run too would make any test that writes files look like a change. So only a line with a command after the test command that may change
// files (changerAfter: anything but reading, printing and committing what is there) has its state taken before it starts too (keepBefore, at
// its PreToolUse hook), and the run doesn't count at open_pr if the files changed during the line, or if HQ couldn't see them before it.
import { execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { one, run as sql } from './db.ts'
import type { Agent } from './agents.ts'
import { getFeature, getRepo, hqMoves, repoOfAgent, ticketForAgent, type Repo, type Ticket } from './records.ts'
import { afterTestCmd, bare, isRefusal, ranTestCmd, refusedTestCmd } from './refused.ts'
import { detectTests } from './testrun.ts'
import { chain, partsHere, stepsOf } from './teststepsstore.ts'
import { j } from './util.ts'

const squeezed = (s: string): string => s.trim().replace(/\s+/g, ' ')
const unquoted = (s: string): string => s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ' Q ') // `git commit -m "npm test"` runs no tests
/** The test command HQ runs for this ticket: the saved one, else the one it finds in the worktree. Null: none. */
export function suiteCmd(repo: Repo, worktree: string | null): string | null {
  if (repo.test_cmd?.trim()) return repo.test_cmd.trim()
  // Bug 411: the project's saved test steps, as far as an engineer's session can run them and as far as this worktree has their tests. HQ runs the rest itself
  const steps = worktree ? stepsOf(repo.id) : null
  if (steps) { const parts = partsHere(steps.parts.filter((p) => p.engineers), filesIn(worktree!)); if (parts.length) return chain(parts) }
  return worktree ? detectTests(worktree)?.test ?? null : null
}
/** A worktree's files as git sees them, the new ones not yet committed too. Asked for on every Bash call of an engineer's (the hooks), so kept for a second. */
const listed = new Map<string, { at: number; files: string[] }>()
function filesIn(wt: string): string[] {
  const kept = listed.get(wt); if (kept && Date.now() - kept.at < 1000) return kept.files
  let files: string[] = []
  try {
    files = execFileSync('git', ['--no-optional-locks', '-c', 'core.quotepath=off', 'ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: wt, encoding: 'utf8', maxBuffer: 256 << 20, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)
  } catch { /* no checkout to list: no part applies, and the rules decide */ }
  if (listed.size > 200) listed.clear()
  listed.set(wt, { at: Date.now(), files }); return files
}
/** Does this Bash line run the test command `cmd` (or try to, when Claude Code refused it)? Engineers add options, cut the output down and
 *  `cd` into their worktree first, so the line is taken apart as refused.ts does; a line that holds the command word for word also counts. */
export function runsSuite(line: string, cmd: string, worktree: string | null, refused = false): boolean {
  const esc = squeezed(cmd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // whole words: `npm tests` is another script
  if (new RegExp(`(?:^|[\\s;&|(])${esc}(?=$|[\\s;&|)])`).test(squeezed(unquoted(line)))) return true
  return refused ? refusedTestCmd(line, cmd, worktree) : ranTestCmd(line, cmd, worktree)
}
/** Bug 213: commands that can come after the test command in its own line and change no file the run saw: ones that read, print or cut the
 *  output down (`| tail`, `| tee log`), and git commands that only look or commit what is there. A commit hook that rewrites files isn't seen. */
const LEAVES = new RegExp(`^(?:echo|printf|tail|head|cat|less|grep|egrep|wc|sort|uniq|tee|true|false|sleep|exit|ls|pwd|cd|test|date|which`
  + '|git (?:status|diff|log|show|add|commit|push|branch|rev-parse|ls-files|fetch|remote))(?: |$)')
/** Bug 213: the first command after the test command in `line` that may change files, or null. Something worked out as it runs (`$( )`, a
 *  backtick) or a file written through the shell (`> f`) makes any command one that may. */
export function changerAfter(line: string, cmd: string): string | null {
  for (const c of afterTestCmd(line, cmd)) {
    const w = bare(unquoted(c))
    if (/`|\$\(/.test(c) || /[<>]/.test(w) || !LEAVES.test(w)) return c
  }
  return null
}
/** hooks.ts, for each engineer's Bash call that is over (PostToolUse, PostToolUseFailure): the test command it ran, kept on its event. A run
 *  that failed, was stopped or went to the background counts: the engineer saw what it said, or says in its handoff that it didn't finish. */
export function suiteRan(agent: Agent, command: string, error?: string): string | undefined {
  if (agent.role !== 'engineer' || !command) return undefined
  const t = ticketForAgent(agent), repo = getRepo(repoOfAgent(agent) ?? ''); if (!t || !repo) return undefined
  const cmd = suiteCmd(repo, t.worktree_path)
  return cmd && runsSuite(command, cmd, t.worktree_path, error !== undefined && isRefusal(error)) ? cmd : undefined
}
const gitOut = (cwd: string, args: string[], input?: string): Promise<string> => new Promise((resolve, reject) => { // no optional locks: the engineer's git goes on
  const p = execFile('git', ['--no-optional-locks', ...args], { cwd, maxBuffer: 64 << 20, timeout: 30_000 }, (e, out) => e ? reject(e) : resolve(out))
  if (input !== undefined) p.stdin?.end(input)
})
const hex = (algo: string, s: string): string => crypto.createHash(algo).update(s).digest('hex')
const LOOKS = 3 // Bug 429: how many times worktreeState reads HEAD's files and `git status` when HEAD moves during each read
/** Bug 194: what the worktree's files hold, as one hash: HEAD's files with what `git status` lists on top (untracked files too; ignored ones and
 *  HQ's plan folder not, see worktrees.ts). The same files give the same hash however they got there: reading files, or a commit that changes
 *  none, keeps it; `sed -i`, a merge or an Edit changes it. Writes nothing (no index, no objects). Null: git can't say (not a worktree).
 *  Bug 429: HEAD's files and `git status` are two reads, so a commit landing between them (the engineer's `git commit` the instant its test run
 *  is over) left the files it committed out of both, as a change. HEAD is read before and after, and the look starts again if it moved; a
 *  look HEAD never held still for reads as a change (open_pr asks for another run), never as none. */
export async function worktreeState(wt: string): Promise<string | null> {
  try {
    const top = (await gitOut(wt, ['rev-parse', '--show-toplevel'])).trim()
    const headNow = (): Promise<string> => gitOut(top, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']).then((s) => s.trim(), () => '') // '': no commit yet
    let files = new Map<string, string>(), listed: string[] = [], still = false
    for (let tries = 0; tries < LOOKS && !still; tries++) {
      const at = await headNow(); files = new Map()
      const head = at ? await gitOut(top, ['ls-tree', '-r', '-z', at]) : '' // no commit yet: nothing committed
      for (const e of head.split('\0')) { const tab = e.indexOf('\t'); if (tab > 0) files.set(e.slice(tab + 1), e.slice(0, tab).split(' ')[2]!) }
      listed = (await gitOut(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])).split('\0').filter(Boolean).map((e) => e.slice(3))
      still = await headNow() === at
    }
    // Still moving (commits back to back): a mixed look could even match a state kept earlier and hide a change, so it matches nothing
    if (!still) return `moving ${crypto.randomUUID()}`
    const toHash: string[] = []
    for (const f of listed) {
      const st = fs.lstatSync(path.join(top, f), { throwIfNoEntry: false })
      if (!st) files.delete(f)
      else if (st.isSymbolicLink()) { const to = fs.readlinkSync(path.join(top, f)); files.set(f, hex('sha1', `blob ${Buffer.byteLength(to)}\0${to}`)) } // as git hashes a link
      else if (st.isFile() && !f.includes('\n')) toHash.push(f)
      else files.set(f, `other ${st.size} ${st.mtimeMs}`) // a submodule, or a name hash-object can't take
    }
    const shas = toHash.length ? (await gitOut(top, ['hash-object', '--stdin-paths'], toHash.join('\n') + '\n')).trim().split('\n') : [] // no -w: nothing written
    toHash.forEach((f, i) => files.set(f, shas[i]!))
    return hex('sha256', [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, sha]) => `${f}\0${sha}`).join('\0'))
  } catch { return null }
}
/** Bug 213: how long a PreToolUse answer waits for the worktree's state before the line starts. Past it the line goes ahead, and HQ counts its
 *  state before as not seen. */
const BEFORE_MS = Number(process.env.HQ_SUITE_BEFORE_MS) || 10_000
/** Bug 213: hooks.ts, at the PreToolUse of a Bash line (its event `eventId` written) that runs the test command with a command after it that may
 *  change files (changerAfter): keep on that event (`before`) what the worktree holds now, before the line starts. Claude Code starts it when
 *  the hook answers, so the answer waits for this (resolves). Null: nothing to keep, answer at once. Not for a run in the background (keepState). */
export function keepBefore(agent: Agent, command: string, eventId: number, background: boolean): Promise<void> | null {
  const cmd = background ? undefined : suiteRan(agent, command), wt = ticketForAgent(agent)?.worktree_path
  if (!cmd || !wt || !changerAfter(command, cmd)) return null
  let late = false
  const took = worktreeState(wt).then((s) => { if (s && !late) sql(`UPDATE events SET payload = json_set(payload, '$.before', ?) WHERE id = ?`, s, eventId) }).catch(() => {})
  return Promise.race([took, new Promise<void>((r) => setTimeout(r, BEFORE_MS).unref())]).then(() => { late = true })
}
const taking = new Map<number, Promise<unknown>>() // event id of a run → its worktreeState, until it is kept on the event
/** hooks.ts, once the event of a run of the test command is written: keep on it (`tree`) what the worktree held when the run was over. Not for a
 *  run that went on in the background: it may still write files (open_pr then goes by Edit/Write alone, as before Bug 194).
 *  Bug 213: a line with a command after the test command that may change files also gets `late` (that command, and whether HQ saw the state
 *  before the line) when the files changed during the line or HQ didn't see them before it: open_pr then asks for a run on a line of its own. */
export function keepState(agent: Agent, eventId: number, command = '', use = ''): void {
  const wt = ticketForAgent(agent)?.worktree_path; if (!wt) return
  const cmd = suiteRan(agent, command), after = cmd ? changerAfter(command, cmd) : null
  taking.set(eventId, worktreeState(wt).then((s) => {
    if (!s) return
    const before = after && use ? one<{ b: string | null }>(`SELECT json_extract(payload, '$.before') AS b FROM events WHERE agent_id = ?
      AND kind = 'hook.PreToolUse:Bash' AND json_extract(payload, '$.use') = ? ORDER BY id DESC LIMIT 1`, agent.id, use)?.b ?? null : null
    const late = after && before !== s ? JSON.stringify({ cmd: after.slice(0, 120), seen: !!before }) : null
    sql(`UPDATE events SET payload = json_set(payload, '$.tree', ?, '$.late', json(?)) WHERE id = ?`, s, late, eventId)
  }).catch(() => {}).finally(() => taking.delete(eventId)))
}
const EDITS = "('hook.PostToolUse:Edit', 'hook.PostToolUse:Write', 'hook.PostToolUse:MultiEdit', 'hook.PostToolUse:NotebookEdit')"
/** open_pr's check. Null: it may go on. Otherwise why not, in words the engineer can act on. */
export async function suiteProblem(t: Ticket): Promise<string | null> {
  const repo = getRepo(getFeature(t.feature_id)?.repo_id ?? ''); if (!repo || hqMoves(repo, t)) return null // HQ runs it itself before its merge (not while auto is stopped or parked)
  const cmd = suiteCmd(repo, t.worktree_path); if (!cmd) return null
  if (j<{ cmd?: string } | null>(repo.test_cmd_refused, null)?.cmd === repo.test_cmd) return null // Claude Code refuses it for engineers: HQ already says so
  const last = (where: string, ...args: string[]): number => one<{ id: number | null }>(`SELECT MAX(e.id) AS id FROM events e JOIN agents a ON a.id = e.agent_id
    WHERE a.ticket_id = ? AND ${where}`, t.id, ...args)?.id ?? 0
  const ran = last(`e.kind IN ('hook.PostToolUse:Bash', 'hook.PostToolUseFailure:Bash') AND json_extract(e.payload, '$.suite') = ?`, cmd)
  await taking.get(ran) // the run's worktreeState, if it is still being taken
  const row = ran ? one<{ tree: string | null; late: string | null }>(`SELECT json_extract(payload, '$.tree') AS tree, json_extract(payload, '$.late') AS late
    FROM events WHERE id = ?`, ran) : undefined
  const kept = row?.tree ?? null, late = j<{ cmd: string; seen: boolean } | null>(row?.late ?? null, null)
  const now = kept && t.worktree_path ? await worktreeState(t.worktree_path) : null
  const edited = t.worktree_path ? last(`e.kind IN ${EDITS} AND instr(e.payload, ?) > 0 AND instr(e.payload, '/.hq-plans/') = 0`, t.worktree_path) : 0 // not its plan file
  const handoff = last(`e.kind = 'mcp.update_handoff' AND json_extract(e.payload, '$.args.kind') = 'before_pr'`)
  const run = `Run the project's test command, the whole suite and not only your own test files: ${cmd}`
  if (!ran) return `HQ hasn't seen this project's test command run on ${t.key}. ${run}. Then call update_handoff(kind: before_pr) saying what it reported `
    + '(how many passed and failed, and which failed), and call open_pr again. A failure your ticket doesn\'t cover isn\'t yours to fix: ask the TPM about it '
    + '(reason "question"), as for any problem outside your ticket.'
  if (late) return `Your last run of this project's test command had \`${late.cmd}\` after it in the same Bash line, and ${late.seen
    ? 'the files changed during that line' : "HQ couldn't see what the files held before that line"}, so HQ can't tell whether the tests saw what the `
    + `files hold now. ${run}, on a Bash line of its own (nothing after it but \`| tail\` and the like). Then call update_handoff(kind: before_pr) `
    + 'saying what it reported, and call open_pr again.'
  if (edited > ran || (now && now !== kept)) return `You changed files after the last run of this project's test command (with any tool: Edit, sed, `
    + `git merge...). ${run}. Then call update_handoff(kind: before_pr) saying what it reported, and call open_pr again.`
  if (handoff < ran) return `Your before_pr handoff came before your last run of the test command (${cmd}). Call update_handoff(kind: before_pr) saying what that `
    + 'run reported (how many passed and failed, and which failed), then call open_pr again.'
  return null
}

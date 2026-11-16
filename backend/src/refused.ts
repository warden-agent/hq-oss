// Bug 107: is a failed Bash call Claude Code refusing to run the project's own test command in an engineer's session? Every engineer works in
// a --worktree session, and Claude Code runs a line there only when it can tell beforehand that no part of it is a git command aimed outside
// that worktree. For some shapes it can't: on 2.1.322 git inside `$( )` and some here-documents, on 2.1.300 also node or python with an
// argument worked out as it runs. HQ's own test runs go through /bin/sh and never meet this, so a saved command can pass every merge-time
// test while no engineer can run it.
// Engineers never type the saved command exactly (0 of 20 in the live log, and the first real engineer of this fix): they add the test
// runner's time limit, cut the build's output down, put `timeout 540` in front, or run its second half alone. So the line is taken apart into
// its simple commands, and each has to be one of the test command's own or a plain one that Claude Code has no reason to refuse.
// Pure, so it's unit-tested (refused.test.ts); auto.ts sawTestCmd acts on it.
import path from 'node:path'

/** Claude Code's words when it won't run a command in a worktree session: the hook's `error` starts with them on 2.1.300 and on 2.1.322
 *  (all 101 in the live log on 2026-11-15, and a spike on 2.1.322). A command that ran and failed says "Exit code N" instead. */
export const isRefusal = (error: string): boolean => /^This session is isolated in the worktree\b/.test(error)

const squeezed = (s: string): string => s.trim().replace(/\s+/g, ' ')
/** The simple commands of a shell line: split at && || ; | & newlines and brackets, but never inside quotes, `$( )` or backticks. */
export function commands(line: string): string[] {
  const out: string[] = []; let cur = '', depth = 0, quote = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!, next = line[i + 1]
    if (quote) { cur += ch; if (ch === '\\' && quote === '"') cur += line[++i] ?? ''; else if (ch === quote) quote = ''; continue }
    if (ch === '\\') { cur += ch + (line[++i] ?? ''); continue }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue }
    if (ch === '$' && next === '(') { depth++; cur += '$('; i++; continue }
    if (depth) { depth += ch === '(' ? 1 : ch === ')' ? -1 : 0; cur += ch; continue }
    if ((ch === '>' && next === '&') || (ch === '&' && next === '>')) { cur += ch + next; i++; continue } // 2>&1, &>file: not the end of a command
    if ('&|;\n()'.includes(ch)) { out.push(cur); cur = ''; if ((ch === '&' || ch === '|') && next === ch) i++; continue }
    cur += ch
  }
  return [...out, cur].map(squeezed).filter(Boolean)
}
/** Output joined or thrown away: it changes nothing about what runs. */
const QUIET = / ?(?:2>&1|&>\/dev\/null|[12]?>\/dev\/null)/g
const bare = (c: string): string => squeezed(c.replace(QUIET, ' '))
const VALUE = String.raw`[\w.,:@/+-]*`
const SETS = new RegExp(`^[A-Za-z_]\\w*=${VALUE}$`), OPTION = new RegExp(`^--?[A-Za-z][\\w-]*(?:=${VALUE})?$`)
/** Programs that are never git in disguise, whatever their arguments: a package manager's script, and the tools that cut output down. */
const SAFE = /^(?:npm|pnpm|yarn|bun|echo|tail|head|cat|grep|wc|sort|true|sleep)(?: |$)/
/** A command Claude Code has no reason to refuse: a safe program with nothing worked out as it runs (`$?` aside), no file written or read
 *  through the shell, no here-document; or a `cd` into the engineer's own worktree. */
function plain(c: string, worktree: string | null): boolean {
  const words = c.split(' '); while (words.length > 1 && SETS.test(words[0]!)) words.shift()
  const rest = words.join(' ')
  if (/[<>`]|\$(?!\?)/.test(rest)) return false
  const cd = /^cd (?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(rest)
  return cd ? !!worktree && path.resolve(cd[1] ?? cd[2] ?? cd[3]!) === path.resolve(worktree) : SAFE.test(rest)
}
/** Is `c` the test command's own command `p`, give or take what engineers add: plain options (`--test-force-exit`, `--test-timeout=120000`),
 *  plain settings in front (`CI=1`), and `timeout 540`? */
function same(c: string[], p: string[]): boolean {
  let i = 0
  for (let k = 0; k < c.length; k++) {
    if (i < p.length && c[k] === p[i]) i++
    else if (c[k] === 'timeout' && /^\d+[smh]?$/.test(c[k + 1] ?? '')) k++
    else if (!OPTION.test(c[k]!) && !SETS.test(c[k]!)) return false
  }
  return i === p.length
}

/** What a shell line runs of the project's test command. Null: something else is in the line that Claude Code could have refused (a
 *  here-document, a git command, a file written somewhere), or none of it is the test command's. Otherwise:
 *  - `whole`: every command of the test command is in the line;
 *  - `hard`: how many of the test command's commands that aren't plain it runs, of `hardInCmd`. Those are the ones Claude Code may refuse. */
export function testCmdParts(line: string, testCmd: string, worktree: string | null): { whole: boolean; hard: number; hardInCmd: number } | null {
  const parts = commands(testCmd).map(bare).filter(Boolean), hard = parts.map((p) => !plain(p, worktree)), seen = new Set<number>()
  for (const c of commands(line).map(bare).filter(Boolean)) {
    const i = parts.findIndex((p) => same(c.split(' '), p.split(' ')))
    if (i >= 0) seen.add(i); else if (!plain(c, worktree)) return null
  }
  if (!seen.size) return null
  return { whole: seen.size === parts.length, hard: [...seen].filter((i) => hard[i]).length, hardInCmd: hard.filter(Boolean).length }
}
/** A line Claude Code refused: was it the test command it refused? Everything in the line is the test command's own or plain, so yes when
 *  the line holds a part of the command that Claude Code may refuse, or all of it. */
export const refusedTestCmd = (line: string, testCmd: string, worktree: string | null): boolean => {
  const m = testCmdParts(line, testCmd, worktree); return !!m && (m.hard > 0 || m.whole)
}
/** A line Claude Code ran: does that show engineers can run the test command? Yes when it held all of the command, or every part of it
 *  that Claude Code may refuse (Claude Code decides before anything runs, so a line that ran at all was let through whole). */
export const ranTestCmd = (line: string, testCmd: string, worktree: string | null): boolean => {
  const m = testCmdParts(line, testCmd, worktree); return !!m && (m.whole || (m.hardInCmd > 0 && m.hard === m.hardInCmd))
}

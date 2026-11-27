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
/** The simple commands of a shell line: split at && || ; | & newlines and brackets, but never inside quotes, `$( )` or backticks. Bug 404:
 *  with `(` and `)` kept as 1 and -1 where a bracket opens and closes, for `placed`. */
function pieces(line: string): (string | 1 | -1)[] {
  const out: (string | 1 | -1)[] = []; let cur = '', depth = 0, quote = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!, next = line[i + 1]
    if (quote) { cur += ch; if (ch === '\\' && quote === '"') cur += line[++i] ?? ''; else if (ch === quote) quote = ''; continue }
    if (ch === '\\') { cur += ch + (line[++i] ?? ''); continue }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue }
    if (ch === '$' && next === '(') { depth++; cur += '$('; i++; continue }
    if (depth) { depth += ch === '(' ? 1 : ch === ')' ? -1 : 0; cur += ch; continue }
    if ((ch === '>' && next === '&') || (ch === '&' && next === '>')) { cur += ch + next; i++; continue } // 2>&1, &>file: not the end of a command
    if ('&|;\n()'.includes(ch)) {
      out.push(squeezed(cur)); cur = ''; if (ch === '(' || ch === ')') out.push(ch === '(' ? 1 : -1)
      if ((ch === '&' || ch === '|') && next === ch) i++; continue
    }
    cur += ch
  }
  return [...out, squeezed(cur)].filter((c) => c !== '')
}
export const commands = (line: string): string[] => pieces(line).filter((c): c is string => typeof c === 'string')
/** Output joined or thrown away: it changes nothing about what runs. */
const QUIET = / ?(?:2>&1|&>\/dev\/null|[12]?>\/dev\/null)/g
export const bare = (c: string): string => squeezed(c.replace(QUIET, ' '))
const VALUE = String.raw`[\w.,:@/+-]*`
const SETS = new RegExp(`^[A-Za-z_]\\w*=${VALUE}$`), OPTION = new RegExp(`^--?[A-Za-z][\\w-]*(?:=${VALUE})?$`)
/** Programs that are never git in disguise, whatever their arguments: a package manager's script, and the tools that cut output down. */
const SAFE = /^(?:npm|pnpm|yarn|bun|echo|tail|head|cat|grep|wc|sort|true|sleep)(?: |$)/
const CD = /^cd (?:"([^"]+)"|'([^']+)'|(\S+))$/
/** A command Claude Code has no reason to refuse: a safe program with nothing worked out as it runs (`$?` aside), no file written or read
 *  through the shell, no here-document; or a `cd` into the engineer's own worktree. */
function plain(c: string, worktree: string | null): boolean {
  const words = c.split(' '); while (words.length > 1 && SETS.test(words[0]!)) words.shift()
  const rest = words.join(' ')
  if (/[<>`]|\$(?!\?)/.test(rest)) return false
  const cd = CD.exec(rest)
  return cd ? !!worktree && path.resolve(cd[1] ?? cd[2] ?? cd[3]!) === path.resolve(worktree) : SAFE.test(rest)
}
/** Is `c` the test command's own command `p`, give or take what engineers add: plain options (`--test-force-exit`, `--test-timeout=120000`),
 *  plain settings in front (`CI=1`), and `timeout 540`? */
export function same(c: string[], p: string[]): boolean {
  let i = 0
  for (let k = 0; k < c.length; k++) {
    if (i < p.length && c[k] === p[i]) i++
    else if (c[k] === 'timeout' && /^\d+[smh]?$/.test(c[k + 1] ?? '')) k++
    else if (!OPTION.test(c[k]!) && !SETS.test(c[k]!)) return false
  }
  return i === p.length
}

/** Bug 411: `cd backend`, `cd "backend"` and `cd 'backend'` go to the same folder. HQ writes the folders of a command it builds in quotes, engineers mostly
 *  type them without, and their run of the project's tests didn't count. Only a plain folder name: nothing the shell would work out as it runs. */
const cdBare = (c: string): string => c.replace(/^cd (?:"([^"\\$`]+)"|'([^'\\$`]+)')$/, (_m, a: string | undefined, b: string | undefined) => `cd ${a ?? b}`)
/** Bug 404: a command of a line (`c` bare, `raw` as typed) and the folder it runs in: the `cd`s before it as one string ('' where the line
 *  starts, or in the worktree itself), null somewhere HQ can't place. */
type Placed = { c: string; raw: string; dir: string | null; cd: boolean }
/** Bug 404: the commands of a line with their folders. A `cd` holds until the bracket it is in closes. It has a place when it goes into the worktree,
 *  or to one of the folders in `known` (the test command's own; any folder when null); any other `cd` puts what comes after it at `lost`. */
function placed(line: string, worktree: string | null, known: Set<string> | null, lost: string | null = null): Placed[] {
  const out: Placed[] = [], outer: (string | null)[] = []; let dir: string | null = ''
  for (const p of pieces(line)) {
    if (p === 1) { outer.push(dir); continue }
    if (p === -1) { if (outer.length) dir = outer.pop()!; continue }
    const c = bare(p), cd = /^cd(?: |$)/.test(c); if (!c) continue // `) 2>&1 | tail`: the 2>&1 is no command
    if (cd) {
      const to = cdBare(c)
      dir = plain(c, worktree) ? '' : dir !== null && CD.test(c) && (!known || known.has(to)) ? (dir ? `${dir}\n${to}` : to) : lost
    }
    out.push({ c, raw: p, dir, cd })
  }
  return out
}
/** What a shell line runs of the project's test command. Null: something else is in the line that Claude Code could have refused (a
 *  here-document, a git command, a file written somewhere, a `cd` somewhere else), or none of it is the test command's. Otherwise:
 *  - `whole`: every command of the test command is in the line;
 *  - `hard`: how many of the test command's commands that aren't plain it runs, of `hardInCmd`. Those are the ones Claude Code may refuse;
 *  - `need`: how many of the commands it runs that a run of the tests can't leave out, of `needInCmd`: the hard ones, and each one in a folder of its own
 *    (in a project split into folders, each folder's tests).
 *  Bug 404: a command counts only in the folder it runs in in the test command, and a `cd` is no command of it: `cd "web"` runs no tests, and
 *  Claude Code doesn't refuse a `cd` into the worktree's own folders. So `(cd "web" && echo hi)` is none of `(cd "web" && npm test)`. */
export function testCmdParts(line: string, testCmd: string, worktree: string | null):
  { whole: boolean; hard: number; hardInCmd: number; need: number; needInCmd: number } | null {
  const all = placed(testCmd, worktree, null), parts = all.filter((p) => !p.cd), known = new Set(all.filter((p) => p.cd).map((p) => cdBare(p.c)))
  const hard = parts.map((p) => !plain(p.c, worktree)), need = parts.map((p, i) => hard[i]! || p.dir !== ''), seen = new Set<number>()
  for (const x of placed(line, worktree, known)) {
    if (x.cd) { if (x.dir === null) return null; continue }
    const i = parts.findIndex((p) => p.dir === x.dir && same(x.c.split(' '), p.c.split(' ')))
    if (i >= 0) seen.add(i); else if (!plain(x.c, worktree)) return null
  }
  if (!seen.size) return null
  const count = (of: boolean[]): number => [...seen].filter((i) => of[i]).length
  return { whole: seen.size === parts.length, hard: count(hard), hardInCmd: hard.filter(Boolean).length, need: count(need), needInCmd: need.filter(Boolean).length }
}
/** A line Claude Code refused: was it the test command it refused? Everything in the line is the test command's own or plain, so yes when
 *  the line holds a part of the command that Claude Code may refuse, or all of it. */
export const refusedTestCmd = (line: string, testCmd: string, worktree: string | null): boolean => {
  const m = testCmdParts(line, testCmd, worktree); return !!m && (m.hard > 0 || m.whole)
}
/** A line Claude Code ran: does that show engineers can run the test command (Bug 107), and that the tests ran (Bug 162)? Yes when it held all of
 *  the command, or every part of it that Claude Code may refuse and every folder's tests (Claude Code decides before anything runs, so a line that
 *  ran at all was let through whole; a build before the tests may be left out). */
export const ranTestCmd = (line: string, testCmd: string, worktree: string | null): boolean => {
  const m = testCmdParts(line, testCmd, worktree); return !!m && (m.whole || (m.needInCmd > 0 && m.need === m.needInCmd))
}
/** Bug 213: the commands of a Bash line that come after its last command of the test command's (as `commands` splits it, pipes included), so
 *  `npm test && sed -i … && git commit` gives the sed and the commit. Empty: the line ends with the test command, or HQ can't place it.
 *  Bug 404: a command of the test command's counts in its own folder only, and its `cd`s are none (`(cd "web" && pnpm test)` has no `pnpm test`
 *  after the command: it holds none of it). No worktree here, so a `cd` to a folder that isn't the command's is taken as going back to the start. */
export function afterTestCmd(line: string, testCmd: string): string[] {
  const all = placed(testCmd, null, null), parts = all.filter((p) => !p.cd), known = new Set(all.filter((p) => p.cd).map((p) => cdBare(p.c)))
  const isPart = (x: Placed): boolean => !x.cd && parts.some((p) => p.dir === x.dir && (x.c === p.c || x.c.startsWith(`${p.c} `) || same(x.c.split(' '), p.c.split(' '))))
  const cs = placed(line, null, known, ''); let last = -1; cs.forEach((x, i) => { if (isPart(x)) last = i })
  return last < 0 ? [] : cs.slice(last + 1).map((x) => x.raw)
}

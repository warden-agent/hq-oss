// Fails when code in backend/, scripts/ or plugin/ runs tmux without naming its socket (`-S <path>` or `-L <name>`). A bare call goes to whatever
// server TMUX or TMUX_TMPDIR points at. For whoever works on HQ that is the tmux their live HQ runs in, and a bare `tmux kill-server` there ends
// it (Bugs 199, 226, 242, 259). The rule stood in CLAUDE.md and HQ's own calls still broke it: this is its check (Bug 295).
//
// What it reads, in tracked .ts/.tsx/.mjs/.js files there, comments left out:
//   call    a child-process call whose program is the word tmux: execFile('tmux', [...]), execFileSync, spawn, spawnSync (pty.spawn too). Its
//           arguments must be written out as a list that begins '-S' or '-L'. A list held in a variable can't be read here, so it fails: write
//           the socket out, or go through tmux.ts. `['-V']` alone passes: it asks the program its version and reaches no server.
//   shell   a tmux command in text a shell will run (`sh -c 'tmux kill-session -t x'`): the word tmux, then one of tmux's command names, with
//           no -S or -L between them.
// What it leaves alone: calls through HQ's own wrappers (tmux.ts, the harness's hq.tmux), whose one real call passes here; a test's stand-in
// tmux that hands its arguments on to the real one (`exec "$real" "$@"`); the word in prose and in comments.
// What it can't see: a call whose program name is held in a variable (`execFile(bin, …)`). The count below is the guard against losing sight.
//
// It fails as well when the number of `call`s is not the one in scripts/tmux-socket.baseline. Fewer means a call went, or that this script has
// stopped seeing them, and a check that sees nothing passes for ever. More means a new direct call: raise the number in the same commit.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CALL = /\b(execFileSync|execFile|spawnSync|spawn)\s*\(\s*(['"`])tmux\2/g
// tmux's commands. The second list are also plain English words ("a style tmux set on an earlier line"), so they count only when a flag or the
// end of the command follows.
const SURE = ['attach-session', 'capture-pane', 'capturep', 'detach-client', 'display-message', 'has-session', 'kill-pane', 'kill-server', 'kill-session',
  'kill-window', 'list-clients', 'list-panes', 'list-sessions', 'list-windows', 'ls', 'new-session', 'new-window', 'pipe-pane', 'rename-session',
  'resize-pane', 'resize-window', 'respawn-pane', 'run-shell', 'select-pane', 'send-keys', 'set-environment', 'set-hook', 'set-option', 'show-options',
  'source-file', 'split-window', 'start-server', 'switch-client', 'wait-for']
const WORDS = ['attach', 'display', 'has', 'new', 'send', 'set', 'show', 'start']
const FLAGS = String.raw`((?:[ \t]+-[A-Za-z0-9]+(?:[ \t]+(?!-)[^\s;|&]+)?)*)`
const SHELL = new RegExp(String.raw`(?<![\w./-])tmux${FLAGS}[ \t]+(?:(?:${SURE.join('|')})(?![\w-])|(?:${WORDS.join('|')})(?=[ \t]+-|[ \t]*(?:['"\`;|&)\n]|$)))`, 'g')

/** The text with its comments blanked and its strings kept, line for line (a string holds the program's name, and the shell text). */
export function withoutComments(text) {
  let out = '', quote = '', block = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1]
    if (block) { if (c === '*' && next === '/') { block = false; out += '  '; i++ } else out += c === '\n' ? '\n' : ' '; continue }
    if (quote) {
      if (c === '\\') { out += c + (next ?? ''); i++; continue }
      if (c === quote || (c === '\n' && quote !== '`')) quote = ''
      out += c; continue
    }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++ } out += i < text.length ? '\n' : ''; continue }
    if (c === '/' && next === '*') { block = true; out += '  '; i++; continue }
    if (c === "'" || c === '"' || c === '`') quote = c
    out += c
  }
  return out
}

/** Every place one file's text runs tmux: `{ line, kind: 'call' | 'shell', ok, why }`, line from 1. */
export function tmuxCalls(text) {
  const code = withoutComments(text), lineOf = (at) => code.slice(0, at).split('\n').length, found = []
  for (const m of code.matchAll(CALL)) {
    const rest = code.slice(m.index + m[0].length), list = /^\s*,\s*\[\s*([^\]]*)\]/.exec(rest)
    const first = list ? /^(['"`])(-[A-Za-z])\1/.exec(list[1].trim()) : null
    const version = !!list && /^(['"`])-V\1\s*$/.test(list[1].trim())
    const ok = version || (!!first && (first[2] === '-S' || first[2] === '-L'))
    const why = ok ? '' : list ? "its arguments don't begin '-S' or '-L'" : 'its arguments are not written out as a list, so the socket can\'t be seen'
    found.push({ line: lineOf(m.index), kind: 'call', ok, why })
  }
  for (const m of code.matchAll(SHELL)) {
    const ok = /(?:^|[ \t])-[SL](?:[ \t]|$)/.test(m[1])
    found.push({ line: lineOf(m.index), kind: 'shell', ok, why: ok ? '' : `"${m[0].trim().slice(0, 60)}" names no socket (-S or -L)` })
  }
  return found.sort((a, b) => a.line - b.line)
}

const root = path.resolve(import.meta.dirname, '..')
/** The files read: tracked code under backend/, scripts/ and plugin/. Not this script's own test: its examples of bare calls are meant to be there. */
export const codeFiles = () => execFileSync('git', ['ls-files', 'backend', 'scripts', 'plugin'], { cwd: root, encoding: 'utf8' }).split('\n')
  .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && f !== 'backend/src/tmuxsocket.test.ts')
/** The baseline file's one number: how many `call`s there are. */
export const readBaseline = (text) => Number(/^calls\s+(\d+)$/m.exec(text)?.[1] ?? NaN)
/** What the check says and whether it fails. `found`: every place, with its file. */
export function verdict(found, base) {
  const calls = found.filter((x) => x.kind === 'call').length, bad = found.filter((x) => !x.ok)
  const lines = [`tmux calls: ${calls} written out (baseline ${base}), ${found.length - calls} in shell text, ${bad.length} with no socket named`]
  const fails = bad.map((x) => `${x.f}:${x.line}  ${x.why}`)
  if (bad.length) fails.push('A bare tmux call can reach the live HQ\'s tmux. Name the socket (-S), or call through backend/src/tmux.ts.')
  if (!(calls >= base)) {
    fails.push(`${Number.isNaN(base) ? 'The baseline can\'t be read' : `${base - calls} fewer written-out calls than the baseline`}: if one was removed, lower "calls" in `
      + 'scripts/tmux-socket.baseline in the same commit. If none was, this script has stopped seeing them.')
  }
  if (calls > base) fails.push(`${calls - base} more written-out calls than the baseline: if the new one is meant, raise "calls" in scripts/tmux-socket.baseline in the same commit.`)
  return { lines, fails }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const found = codeFiles().flatMap((f) => tmuxCalls(fs.readFileSync(path.join(root, f), 'utf8')).map((x) => ({ ...x, f })))
  const v = verdict(found, readBaseline(fs.readFileSync(path.join(import.meta.dirname, 'tmux-socket.baseline'), 'utf8')))
  console.log(v.lines.join('\n'))
  if (process.argv.includes('--list')) for (const x of found) console.log(`  ${x.f}:${x.line}  ${x.kind}${x.ok ? '' : '  NO SOCKET'}`)
  if (v.fails.length) { console.error(`\n${v.fails.join('\n')}\n(node scripts/tmux-socket.mjs --list shows each place)`); process.exit(1) }
}

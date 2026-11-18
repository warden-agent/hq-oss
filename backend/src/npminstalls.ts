// The npm installs inside a recipe's shell command, and the folder each one runs in (Bug 191): a Launch helper can write
// `cd web && npm install`, `npm --prefix web ci` or `(cd web; npm i)`, not just `npm install`. The same for uv, yarn and pnpm
// installs (Bug 211): `cd server && uv sync`, `yarn --cwd web install`, `pnpm -C web i`. A small reading of the shell
// words, not a full shell: what it can't follow (`cd $DIR`, `cd ~`, an absolute path) comes back as an unknown folder.
import path from 'node:path'

/** One npm install found in a command. `dir`: the folder it runs in, relative to the command's own folder ('' for that
 *  folder), or null when HQ can't tell (`cd "$X"`, `cd /abs`, `cd -`). `ci`: npm ci (it follows a lockfile, never writes one). */
export type NpmInstall = { text: string; dir: string | null; ci: boolean; noLock: boolean }

/** npm's install and clean-install commands with their aliases (npm 11's `npm help install`, `npm help ci`). */
const INSTALL = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'install-test', 'it'])
const CI = new Set(['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install-ci-test', 'cit'])
/** npm options that take the next word as their value (so it isn't read as the command): the ones a recipe might use. */
const VALUED = new Set(['--prefix', '-C', '--loglevel', '--cache', '--registry', '--userconfig', '--workspace', '-w', '--omit', '--include', '--install-strategy'])
/** Words in front of a command that still run it: `env`, `command`, `exec`, `time`, `nohup`, shell keywords. */
const WRAPPERS = new Set(['env', 'command', 'exec', 'time', 'nohup', 'then', 'do', 'else', '!', '{'])

type Word = { text: string; plain: boolean } // plain: no unquoted $, `, ~ or glob in it (its text is what the shell passes)
type Token = Word | { op: string }

/** Words and operators (&& || ; | & newline ( )), with quotes and backslashes taken off the words. */
function tokens(cmd: string): Token[] {
  const out: Token[] = []; let w: Word | null = null
  const add = (ch: string, plain = true) => { w ??= { text: '', plain: true }; w.text += ch; if (!plain) w.plain = false }
  const end = () => { if (w) out.push(w); w = null }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (c === '\\') { add(cmd[++i] ?? ''); continue }
    if (c === "'") { const j = cmd.indexOf("'", i + 1), to = j < 0 ? cmd.length : j; add(''); w!.text += cmd.slice(i + 1, to); i = to; continue }
    if (c === '"') {
      add('')
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) { if (cmd[i] === '\\' && i + 1 < cmd.length) i++; add(cmd[i]!, cmd[i] !== '$' && cmd[i] !== '`') }
      continue
    }
    if (/\s/.test(c) && c !== '\n') { end(); continue }
    const two = cmd.slice(i, i + 2)
    if (two === '&>' || (c === '&' && /[<>]$/.test((w as Word | null)?.text ?? ''))) { add(c); continue } // a redirect (2>&1, &>log), not an operator
    if (two === '&&' || two === '||') { end(); out.push({ op: two }); i++; continue }
    if (';|&\n()'.includes(c)) { end(); out.push({ op: c }); continue }
    add(c, !/[$`*?[]/.test(c) && !(c === '~' && !w))
  }
  end(); return out
}

/** One simple command of a shell line: what runs (`head`, `args`), the VAR=value words in front of it, and the folder it runs in
 *  (relative to the line's own folder, null when HQ can't follow a `cd`). */
type Command = { head: Word; args: Word[]; env: Word[]; cwd: string | null }

/** Every simple command in `cmd`, in order. A `cd` applies to what follows it, inside its ( ) subshell only. */
function commands(cmd: string): Command[] {
  const found: Command[] = [], stack: (string | null)[] = []
  let cwd: string | null = '', words: Word[] = []
  const run = () => {
    let ws = words; words = []; const env: Word[] = []
    for (;;) { // VAR=value words, env, exec, ... in front of the command
      const w = ws[0]; if (!w) return
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) env.push(w); else if (!WRAPPERS.has(w.text)) break
      ws = ws.slice(1)
    }
    const [head, ...args] = ws as [Word, ...Word[]]
    if (head.text === 'cd' || head.text === 'pushd') {
      const to = args.find((a) => a.text !== '-L' && a.text !== '-P')
      cwd = cwd === null || !to || !to.plain || to.text === '-' || path.isAbsolute(to.text) ? null : path.join(cwd, to.text)
      return
    }
    if (head.text === 'popd') { cwd = null; return }
    found.push({ head, args, env, cwd })
  }
  for (const t of tokens(cmd)) {
    if ('text' in t) { words.push(t); continue }
    run()
    if (t.op === '(') stack.push(cwd)
    else if (t.op === ')') cwd = stack.length ? stack.pop()! : null
  }
  run()
  return found
}

/** A tool's command word (`npm`, `/opt/homebrew/bin/npm`), its subcommand (the first word that isn't an option or an
 *  option's value, null for none), its words up to `--`, and the folder it runs in once an option like `--prefix web` moves
 *  it ('' for the line's own folder, null when HQ can't tell: `--prefix "$DIR"`, an absolute path). */
function read(c: Command, tool: string, dirOpts: Set<string>, valued: Set<string>) {
  if (!c.head.plain || path.basename(c.head.text) !== tool) return null
  let sub: string | null = null, opt: string | null | undefined; const args: Word[] = []
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i]!, eq = /^(-[^=]+)=(.*)$/.exec(a.text)
    if (a.text === '--') break
    args.push(a)
    if (eq && dirOpts.has(eq[1]!)) { opt = a.plain ? eq[2]! : null; continue }
    if (dirOpts.has(a.text)) { const v = c.args[++i]; opt = v?.plain ? v.text : null; continue }
    if (valued.has(a.text)) { i++; continue }
    if (!a.text.startsWith('-') && sub === null) sub = a.text
  }
  const dir = c.cwd === null || opt === null ? null : opt === undefined ? c.cwd : path.isAbsolute(opt) ? null : path.join(c.cwd, opt)
  return { sub, args, dir: dir === '.' ? '' : dir, text: [c.head, ...c.args].map((w) => w.text).join(' ') }
}

const NPM_DIR = new Set(['--prefix', '-C'])

/** Every npm install in `cmd`, in order, with the folder it runs in. */
export function npmInstalls(cmd: string): NpmInstall[] {
  return commands(cmd).flatMap((c) => {
    const r = read(c, 'npm', NPM_DIR, VALUED); if (!r || r.sub === null || (!INSTALL.has(r.sub) && !CI.has(r.sub))) return []
    const noLock = r.args.some((a) => /^(--no-package-lock|--package-lock=false)$/.test(a.text))
    return [{ text: r.text, dir: r.dir, ci: CI.has(r.sub), noLock }]
  })
}

/** A uv, yarn or pnpm install found in a command (Bug 211). `lock`: the lockfile it would rewrite; `frozen`: it follows
 *  that lockfile instead (`--locked`, `--frozen-lockfile`, ...); `fix`: the command to use instead. `dir` as in NpmInstall.
 *  `noLock`: it writes no lockfile (`--pure-lockfile`, `--no-lockfile`, `uv run --no-sync`); `bare`: what to use instead when
 *  there is no lockfile, where a plain install would write one (Bug 239). `run`: a `uv run`, which installs (and writes a
 *  uv.lock where there is none) before it runs, but follows one that's there. */
export type LockedInstall = { text: string; dir: string | null; tool: 'uv' | 'yarn' | 'pnpm'; lock: string; frozen: boolean; noLock: boolean; run: boolean
  fix: string; bare: string }

const truthy = (env: Word[], names: string[]) => env.some((w) => { const [k, v] = w.text.split(/=(.*)/s); return names.includes(k!) && /^(1|true|yes)$/i.test(v ?? '') })
/** uv's way to install with no uv.lock and write none (checked on uv 0.12.9: `uv sync` has no option for it, and `uv sync
 *  --locked` fails without one). */
const UV_BARE = '`uv venv --allow-existing && uv pip install -r pyproject.toml` with install_when `pyproject.toml`, and `uv run --no-sync` to run it'
const UV = { tool: 'uv' as const, lock: 'uv.lock', frozen: ['--locked', '--frozen'], env: ['UV_LOCKED', 'UV_FROZEN'],
  dir: ['--directory', '--project'], valued: ['--cache-dir', '--python', '-p', '--color', '--config-file', '--index-url', '--extra-index-url'] }
/** Each tool: its lockfile, its install subcommands (null: no subcommand, `yarn` on its own), the options that follow the
 *  lockfile, the options that write none, the options that move it to another folder, and the options that take the next
 *  word as their value. */
const TOOLS = [
  { ...UV, subs: ['sync'], noLock: [], noLockEnv: [], fix: '`uv sync --locked`', bare: UV_BARE, run: false },
  { ...UV, subs: ['run'], noLock: ['--no-sync', '--no-project'], noLockEnv: ['UV_NO_SYNC'], fix: '`uv run --locked`', bare: '`uv run --no-sync` (install with '
    + '`uv venv --allow-existing && uv pip install -r pyproject.toml`)', run: true },
  { tool: 'yarn' as const, lock: 'yarn.lock', subs: [null, 'install'], frozen: ['--frozen-lockfile', '--immutable'], env: ['YARN_ENABLE_IMMUTABLE_INSTALLS'],
    noLock: ['--pure-lockfile', '--no-lockfile'], noLockEnv: [], fix: '`yarn install --frozen-lockfile` (or --immutable)',
    bare: '`yarn install --pure-lockfile` with install_when `package.json` (Yarn 1; Yarn 2 and later always write one)', run: false, dir: ['--cwd'],
    valued: ['--cache-folder', '--modules-folder', '--mutex', '--network-timeout', '--network-concurrency', '--registry', '--global-folder', '--link-folder', '--use-yarnrc'] },
  { tool: 'pnpm' as const, lock: 'pnpm-lock.yaml', subs: ['install', 'i'], frozen: ['--frozen-lockfile'], env: [], noLock: ['--no-lockfile', '--lockfile=false',
    '--config.lockfile=false'], noLockEnv: [], fix: '`pnpm install --frozen-lockfile`', bare: '`pnpm install --no-lockfile` with install_when `package.json`', run: false,
    dir: ['-C', '--dir'], valued: ['--filter', '-F', '--loglevel', '--reporter', '--store-dir', '--virtual-store-dir'] },
].map((t) => ({ ...t, dir: new Set(t.dir), valued: new Set(t.valued) }))
/** `yarn --version` and the like: no subcommand, but not an install. */
const NOT_INSTALL = new Set(['--version', '-v', '-V', '--help', '-h'])

/** Every uv, yarn or pnpm install in `cmd`, in order, with the folder it runs in: `cd server && uv sync` too, and `uv run`. */
export function lockedInstalls(cmd: string): LockedInstall[] {
  return commands(cmd).flatMap((c) => TOOLS.flatMap((t) => {
    const r = read(c, t.tool, t.dir, t.valued)
    if (!r || !(t.subs as (string | null)[]).includes(r.sub) || (r.sub === null && r.args.some((a) => NOT_INSTALL.has(a.text)))) return []
    const frozen = r.args.some((a) => t.frozen.includes(a.text)) || truthy(c.env, t.env)
    const noLock = r.args.some((a) => t.noLock.includes(a.text)) || truthy(c.env, t.noLockEnv)
    return [{ text: r.text, dir: r.dir, tool: t.tool, lock: t.lock, frozen, noLock, run: t.run, fix: t.fix, bare: t.bare }]
  }))
}

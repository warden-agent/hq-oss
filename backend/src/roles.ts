// Role definitions: models, permission mode, tools, settings generator. Mirrors the plan §2.3/§2.4 and the M0-validated spike settings.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PATHS, PORTS, DEFAULTS, ENGINEER_CACHE, GH_CONFIG_DIR, TURN_WAIT_S, HQ_AWAY_WAIT_S } from './config.ts'
import { getSetting } from './db.ts'
import { real, shq } from './util.ts'
import { BROWSER_TOOLS } from './uitesterrules.ts'
import { hostProblem } from './downloads.ts'

export type Role = 'tpm' | 'architect' | 'engineer' | 'launcher' | 'tester'
const HOME = os.homedir()
/** Bug 87: an agent's token goes in a header, never in the hook's URL. With HQ down, Claude Code prints a failed http hook's URL on the
 *  agent's screen ("HTTP 502 from <url>"), where the model reads it; it never prints the headers. */
const HOOK_URL = () => `http://127.0.0.1:${PORTS.hooks}/hooks`
export const TOKEN_HEADER = 'X-HQ-Token'
/** The SessionStart hook is a command (curl): the header comes from this file in the agent's folder, so the command holds no token either. */
export const HOOK_HEADER_FILE = 'hook-header'
export const hookHeaderLine = (token: string) => `${TOKEN_HEADER}: ${token}\n`
const hook = (token: string, timeout: number, extra: Record<string, unknown> = {}) => ({ type: 'http', url: HOOK_URL(), headers: { [TOKEN_HEADER]: token }, timeout, ...extra })

export const ENGINEER_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'LSP', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'Agent']
export const ENGINEER_DISALLOWED = ['EnterWorktree', 'ExitWorktree', 'WebFetch', 'WebSearch', 'SendMessage', 'ListAgents', 'AskUserQuestion', 'Monitor', 'Skill']
/** Where engineers may download packages from: npm, PyPI and crates.io (each index + files; Bug 71), and Go's module mirror and checksum database
 *  (Bug 415: the mirror serves the modules' zips itself, so `go mod download` needs no other host; real 2.1.322, 2026-11-26). Any other host is
 *  refused, and HQ tells the user which one (downloads.ts). On a Mac, Go also needs `sandbox_system_certs` (systemCerts below). */
export const PACKAGE_REGISTRIES = ['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org', 'index.crates.io', 'static.crates.io',
  'proxy.golang.org', 'sum.golang.org']
export { REGISTRY_WORDS } from './downloads.ts' // PACKAGE_REGISTRIES in a user's words (there, so the page can say them too)
/** Bugs 412, 415: whether agents' sandbox may use macOS's certificate checker (trustd). Claude Code's sandbox blocks it, and pip (24.2 and later) and Go
 *  check every download with it, so both fail there with "OSStatus -26276" (not the proxy's doing: it doesn't decrypt anything, and uv, npm and cargo,
 *  which carry their own list of certificates, download through it fine). The user's setting, off unless they turn it on: trustd fetches what a
 *  certificate names (its issuer, revocation lists) from any host, and a sandboxed command can hand it a certificate of its own. Linux has no trustd. */
export const systemCerts = (): boolean => process.platform === 'darwin' && getSetting('sandbox_system_certs', DEFAULTS.sandbox_system_certs) === 'on'
/** Bug 71: rustup puts `cargo` and `rustc` in ~/.cargo/bin and the toolchains in ~/.rustup, and an engineer's sandbox reads nothing in home
 *  (blockReadsOutsideWorkingDirectories), so its `cargo` was "operation not permitted". The sandbox may read those two folders and nothing
 *  else of home: not the rest of ~/.cargo (its credentials; crates download to the engineers' CARGO_HOME, cacheEnv). Both spellings of a
 *  linked folder, as the sandbox compares real paths (Bug 59). None when rustup isn't installed. */
export function rustReads(): string[] {
  const dirs = [path.join(process.env.CARGO_HOME || path.join(HOME, '.cargo'), 'bin'), process.env.RUSTUP_HOME || path.join(HOME, '.rustup')]
  return [...new Set(dirs.filter((d) => fs.existsSync(d)).flatMap((d) => [d, real(d)]))]
}
/** Places in home that hold credentials or HQ's and Claude's own files: nothing a sandboxed run does may read them (testrun.ts), and no folder
 *  that holds one is ever opened to an agent (toolReads). */
export const HOME_SECRETS = ['.claude', '.claude.json', '.ssh', '.aws', '.config/gh', '.config/gcloud', '.netrc', '.git-credentials', '.npmrc', '.pypirc',
  '.docker', '.kube', '.gnupg', '.cargo/credentials.toml', '.cargo/credentials']
/** Bug 413: the package tools and language runtimes an engineer runs, which their installers often put in home (uv in ~/.local/bin, Poetry
 *  in a venv under ~/Library or ~/.local/share, pnpm and Yarn from npm's global folder or Corepack, node from nvm). */
export const HOME_TOOLS = ['node', 'npm', 'npx', 'corepack', 'pnpm', 'yarn', 'bun', 'deno', 'uv', 'uvx', 'poetry', 'pdm', 'pipenv', 'hatch',
  'python', 'python3', 'pip', 'pip3', 'go']
/** Folders of home many programs share: never opened whole, only a tool's own folder inside them. */
const SHARED = ['', '.local', '.local/share', '.local/lib', '.local/state', '.config', '.cache', 'Library', 'Library/Application Support',
  'Library/Caches', 'Library/Preferences', 'bin', 'Documents', 'Desktop', 'Downloads']
/** Bug 413: an agent's sandbox reads nothing in home (blockReadsOutsideWorkingDirectories), so a package tool installed there was unseen
 *  (`which uv`: not found, and `sh -c uv` too) or couldn't run at all (Poetry, a script in its own venv). For each of HOME_TOOLS that HQ's
 *  PATH finds in home: the program (both spellings: the link on PATH and its real file) and the folder it belongs to, and nothing else of
 *  home: a node package's folder (npm's global pnpm and Yarn, Corepack's shims), else the folder holding a `bin` or `shims` folder (a venv,
 *  nvm's node, pyenv), and the Python a venv was made from when that is in home too. Never a folder many programs share (~/.local), nor
 *  one that holds a HOME_SECRETS place (~/.cargo): a lone program (uv in ~/.local/bin) is opened by itself. */
export function toolReads(PATH: string = process.env.PATH ?? '', home: string = HOME): string[] {
  const homes = [...new Set([home, real(home)])]
  const inHome = (p: string) => homes.some((h) => { const r = path.relative(h, p); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r) })
  const secrets = [...homes.flatMap((h) => HOME_SECRETS.map((s) => path.join(h, s))), PATHS.home, real(PATHS.home), GH_CONFIG_DIR]
  const shared = new Set(homes.flatMap((h) => SHARED.map((s) => path.join(h, s))))
  const within = (a: string, b: string) => a === b || a.startsWith(b + path.sep)
  const safe = (d: string) => inHome(d) && !shared.has(d) && !secrets.some((s) => within(s, d) || within(d, s))
  const reads: string[] = []
  const at = (p: string) => path.join(real(path.dirname(p)), path.basename(p)) // a link's own place by its real path
  const add = (p: string) => { for (const q of [p, at(p), real(p)]) if (inHome(q) && safe(q)) reads.push(q) }
  const ownFolder = (file: string): string | null => { // a node package, or the folder a bin/ or shims/ folder belongs to
    for (let d = path.dirname(file); inHome(d); d = path.dirname(d)) {
      const up = path.dirname(d)
      if (path.basename(up) === 'node_modules' || (path.basename(up).startsWith('@') && path.basename(path.dirname(up)) === 'node_modules')) return d
    }
    const d = path.dirname(file)
    return ['bin', 'shims'].includes(path.basename(d)) && safe(path.dirname(d)) ? path.dirname(d) : null
  }
  const dirs = PATH.split(path.delimiter).filter(Boolean)
  for (const tool of HOME_TOOLS) {
    const found = dirs.map((d) => path.join(d, tool)).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile() } catch { return false } })
    if (!found) continue
    const file = real(found)
    if (!inHome(found) && !inHome(file)) continue
    add(found); add(file)
    const own = ownFolder(file); if (!own) continue
    add(own)
    let base = '' // a venv's Python: `home = <its bin folder>` in pyvenv.cfg
    try { base = /^home\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(own, 'pyvenv.cfg'), 'utf8'))?.[1] ?? '' } catch { /* not a venv */ }
    if (path.basename(base) === 'bin') add(path.dirname(base)) // uv's own Pythons live in ~/.local/share/uv/python/<one>/bin
  }
  // A file in a folder that's opened anyway: once. Its folder by its real path (the sandbox compares those), but a link on PATH stays itself.
  const all = [...new Set(reads)]
  return all.filter((p) => !all.some((o) => o !== p && real(o) !== at(p) && within(at(p), real(o))))
}
/** Bug 423: config files that tools look for in the folder they run in and every folder above it until one counts: pytest's (a pyproject.toml,
 *  setup.cfg or tox.ini counts only with a pytest section), uv's settings and workspace search, ruff's. */
export const PARENT_CONFIGS = ['pyproject.toml', 'setup.cfg', 'tox.ini', 'pytest.ini', '.pytest.ini', 'pytest.toml', '.pytest.toml', 'setup.py', 'uv.toml',
  'ruff.toml', '.ruff.toml']
/** Bug 423: an agent's worktree sits in <repo>/.claude/worktrees/<name>, so those searches walk up out of it into the main checkout, which
 *  the sandbox refuses even to stat ("Operation not permitted"): uv stopped there, and so did pytest on Python 3.12 and 3.13 (pathlib's
 *  is_file raises on it), when the project's pyproject.toml has no pytest or uv section. The sandbox may read those few files of the main
 *  checkout and of the two folders in between, as they are now (a regular file, not a link, by both spellings), and nothing else there.
 *  No setting stops the searches at the worktree without changing which config the project gets: pytest's `--rootdir` doesn't end its
 *  search, only `-c <file>` does, and uv's `--no-config` drops the project's own [tool.uv] settings too. */
export function checkoutReads(repo: string | undefined): string[] {
  if (!repo) return []
  const dirs = [repo, path.join(repo, '.claude'), path.join(repo, '.claude', 'worktrees')]
  const file = (p: string) => { try { return fs.lstatSync(p).isFile() } catch { return false } }
  const found = dirs.flatMap((d) => PARENT_CONFIGS.map((n) => path.join(d, n))).filter(file)
  return [...new Set(found.flatMap((p) => [p, path.join(real(path.dirname(p)), path.basename(p))]))]
}
/** The Launch helper looks around and tries things in its sandbox; it never changes the project (launchhelper.ts). */
export const LAUNCHER_TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'ToolSearch']
export const LAUNCHER_DISALLOWED = ['Edit', 'Write', 'NotebookEdit', 'Agent', ...ENGINEER_DISALLOWED]
export const PLANNER_DISALLOWED = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Monitor', 'EnterWorktree', 'ExitWorktree', 'WebFetch', 'WebSearch', 'SendMessage', 'ListAgents', 'AskUserQuestion', 'Skill']
/** Bug 111: an agent's session stays in the folder HQ started it in. Claude Code's `/cd <path>` moves a session to another folder
 *  (typed into a TPM's or Architect's terminal it really does), and `Cd` is the permission rule for that command, not a tool. A deny
 *  rule `Cd` turns it off, but 2.1.322 then keeps "⚠ Deny rule Cd matches no tool · check for typos" on every agent's start screen:
 *  its check knows tool names only. An allow rule limits `/cd` to the folders it matches and gets no such check, and nothing can be
 *  a folder under /dev/null, so this one leaves nowhere to go. The rest of the path is for whoever tries: Claude Code answers "/cd is
 *  limited to directories matching <this>". Engineers and the Launch helper have no `/cd` at all (`--disable-slash-commands`); they
 *  get the rule too, in case that flag ever goes. Checked on the real 2.1.300 and 2.1.322, 2026-11-15. */
export const STAY_IN_FOLDER = 'Cd(//dev/null/hq-keeps-agents-in-their-own-folder)'

export function modelFor(role: Role, size?: string): string {
  const m = getSetting('models', DEFAULTS.models)
  if (role === 'tpm') return m.tpm
  if (role === 'architect') return m.architect
  if (role === 'launcher') return (m as Partial<typeof m>).launcher ?? m.engineer_s // saved before the helper existed: the S engineer's
  if (role === 'tester') return (m as Partial<typeof m>).tester ?? DEFAULTS.models.tester // saved before the tester existed
  return size === 'S' ? m.engineer_s : m.engineer_ml
}

const NODE = (): string => fs.existsSync(process.execPath) ? process.execPath : 'node'
const HOOKWAIT = path.join(import.meta.dirname, 'hookwait.mjs')
/** Bug 85: a PermissionRequest goes through hookwait.mjs, which waits for a backend that's down (a restart) instead of refusing. HQ's
 *  own answer may take up to `answerS` (the plan gate holds); the wait for HQ comes on top, and Claude Code's limit a little after that. */
function permissionHook(agentDir: string, answerS: number) {
  const limit = answerS + HQ_AWAY_WAIT_S
  const command = [NODE(), HOOKWAIT, `http://127.0.0.1:${PORTS.hooks}/hooks`, path.join(agentDir, 'token'), String(limit)].map(shq).join(' ')
  return { type: 'command', command, timeout: limit + 15 }
}

const TURNWAIT = path.join(import.meta.dirname, 'turnwait.mjs')
/** A build or test run can be held at this hook until its turn comes (heavy.ts). Bug 112: it goes through turnwait.mjs, which keeps asking a backend that's
 *  down (a restart) when the command is one that takes turns; called straight from Claude Code, a backend that was down meant "no answer", and every build
 *  and test run began at once. The script stops by itself after the longest wait for HQ plus the longest wait for a turn, and Claude Code's own limit comes
 *  a little after that. Past either, the command runs anyway (spike 2026-11-09: a hook that times out counts as no answer). */
function bashHook(agentDir: string, repoId: string | undefined) {
  const limit = HQ_AWAY_WAIT_S + TURN_WAIT_S + 45
  const args = [HOOK_URL(), path.join(agentDir, 'token'), String(HQ_AWAY_WAIT_S), String(limit), PATHS.testCmds, repoId ?? '']
  return { type: 'command', command: [NODE(), TURNWAIT, ...args].map(shq).join(' '), timeout: limit + 15 }
}

function hookGroup(token: string) { return [{ hooks: [hook(token, 10)] }] }

type SettingsOpts = { agentDir: string; repoId?: string; repoPath?: string; repoAllowlist?: string[]; editOverrides?: string[]; localOnly?: boolean }
export function buildSettings(role: Role, token: string, opts: SettingsOpts): Record<string, unknown> {
  const gateTimeout = getSetting('gate_timeout_s', DEFAULTS.gate_timeout_s)
  const sessionStartCmd = `curl -s -m 5 -X POST -H 'Content-Type: application/json' -H @${shq(path.join(opts.agentDir, HOOK_HEADER_FILE))} --data-binary @- ${HOOK_URL()}`
  const hooks: Record<string, unknown> = {
    SessionStart: [{ hooks: [{ type: 'command', command: sessionStartCmd, timeout: 10 }] }],
    UserPromptSubmit: hookGroup(token),
    PermissionRequest: [
      { matcher: 'ExitPlanMode', hooks: [permissionHook(opts.agentDir, gateTimeout)] },
      { matcher: '^(?!ExitPlanMode$).*', hooks: [permissionHook(opts.agentDir, 30)] },
    ],
    PreToolUse: hookGroup(token), PostToolUse: hookGroup(token), PostToolUseFailure: hookGroup(token),
    Stop: hookGroup(token), StopFailure: hookGroup(token), Notification: hookGroup(token),
    PreModelSwitch: hookGroup(token), PostModelSwitch: hookGroup(token), PreCompact: hookGroup(token), PostCompact: hookGroup(token),
    ConfigChange: hookGroup(token), SubagentStart: hookGroup(token), SubagentStop: hookGroup(token), TaskCreated: hookGroup(token), TaskCompleted: hookGroup(token),
    SessionEnd: [{ hooks: [hook(token, 5)] }],
  }
  const base: Record<string, unknown> = {
    permissions: { disableAutoMode: 'disable', disableBypassPermissionsMode: 'disable', allow: [STAY_IN_FOLDER] },
    switchModelsOnFlag: false,
    crossSessionInbound: 'refuse',
    hooks,
  }
  if (role !== 'engineer' && role !== 'launcher') return base // the Launch helper gets the engineer's sandbox, and runs no git writes
  hooks.PreToolUse = [{ matcher: 'Bash', hooks: [bashHook(opts.agentDir, opts.repoId)] }, { matcher: '^(?!Bash$).*', hooks: hookGroup(token)[0]!.hooks }]
  const overrides = new Set(opts.editOverrides ?? [])
  const deny = [
    'Read(~/.claude/**)', 'Read(~/.claude.json)', `Read(//${HOME}/.hq/**)`, 'Read(.env)', 'Read(.env.*)', 'Read(**/secrets/**)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)',
    'Edit(.claude/**)', 'Edit(**/.claude-plugin/**)', 'Edit(.mcp.json)', 'Edit(.git/**)', 'Edit(.githooks/**)',
    ...(overrides.has('.github/workflows/**') ? [] : ['Edit(.github/workflows/**)']),
    ...(overrides.has('CLAUDE.md') ? [] : ['Edit(**/CLAUDE.md)']),
    // The Bash(...) prefixes below are a convenience (they stop the obvious command), not a boundary: `env git push`, `git -C`
    // and friends get past them. What holds is the sandbox (no github.com on the network allowlist, ~/.hq and gh config unreadable,
    // the main repo's .git/config and .git/hooks unwritable: spike S1, 2026-10-25) and engineers holding no credentials.
    ...(role === 'launcher' ? ['Bash(git commit*)', 'Bash(git add*)'] : []),
    'Bash(claude *)', 'Bash(tmux *)', 'Bash(sudo *)', 'Bash(gh *)', 'Bash(git push*)', 'Bash(git config core.hooksPath*)', 'Bash(open *)', 'Bash(osascript *)',
  ]
  return {
    ...base,
    permissions: { ...(base.permissions as object), blockReadsOutsideWorkingDirectories: true, allow: [STAY_IN_FOLDER, 'mcp__hq__*'], deny },
    plansDirectory: '.hq-plans',
    // Every package cache sits in ENGINEER_CACHE, outside home: npm's (with the log npm writes on every run), Go's (spike S5), Rust's and
    // Python's. Spike 2026-10-31 (`-p` runs with these settings): `npm test` passed with and without npm_config_cache, so the old
    // "exit 255 in the spike HQ" isn't explained by the npm cache; with it set, nothing is written under ~/.npm at all.
    // Python venvs live in the worktree; uv uses the machine's Python, since downloading one needs github.com, which stays off HQ's
    // own list (spike 2026-10-29: uv sync + pytest pass in this sandbox). Bug 412: on a Mac, pip can't download here (systemCerts), uv can.
    env: { ...cacheEnv(), ...installCaches(usesPnpm(opts.repoPath)) }, // Bug 455: Yarn's, pnpm's and Bun's too
    sandbox: {
      enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true,
      // Bug 425: the project's own hosts as checked (only the user sets them, allowhosts.ts)
      network: { allowedDomains: ['127.0.0.1', 'localhost', '[::1]',
        ...(opts.localOnly ? [] : [...PACKAGE_REGISTRIES, ...(opts.repoAllowlist ?? []).filter((h) => !hostProblem(h))])],
        strictAllowlist: true, allowLocalBinding: true },
      ...(systemCerts() && !opts.localOnly ? { enableWeakerNetworkIsolation: true } : {}), // only the macOS certificate checker (trustd), nothing else
      // On a Linux with no keyring, gh keeps its token in a file in GH_CONFIG_DIR. HQ's own folder by its real path: that's what the sandbox compares (Bug 59).
      filesystem: { allowWrite: [ENGINEER_CACHE, ...pnpmLockDirs()], allowRead: [...new Set([...rustReads(), ...toolReads(), ...checkoutReads(opts.repoPath)])], // Bugs 71, 413, 423: rustup's, package
        // tools in home, the main checkout's config files
        denyRead: [`${HOME}/.claude`, `${HOME}/.claude.json`, real(PATHS.home), `${HOME}/.ssh`, `${HOME}/.aws`, `${HOME}/.config/gh`, GH_CONFIG_DIR] },
      credentials: { envVars: [{ name: 'HQ_AGENT_ID', mode: 'deny' }, { name: 'HQ_BACKEND', mode: 'deny' }, { name: 'ANTHROPIC_API_KEY', mode: 'deny' }, { name: 'GH_TOKEN', mode: 'deny' }, { name: 'GITHUB_TOKEN', mode: 'deny' }] },
    },
  }
}

/** Where package tools keep their caches, for anything that runs sandboxed (engineers, and auto mode's test runs). */
export const cacheEnv = (): Record<string, string> => ({
  npm_config_cache: path.join(ENGINEER_CACHE, 'npm'),
  GOCACHE: path.join(ENGINEER_CACHE, 'go-build'), GOMODCACHE: path.join(ENGINEER_CACHE, 'gomod'), GOPATH: path.join(ENGINEER_CACHE, 'gopath'),
  CARGO_HOME: path.join(ENGINEER_CACHE, 'cargo'), // where crates download to; cargo itself is still found on PATH (~/.cargo/bin, readable: rustReads), and rustup's toolchains stay put
  UV_CACHE_DIR: path.join(ENGINEER_CACHE, 'uv'), PIP_CACHE_DIR: path.join(ENGINEER_CACHE, 'pip'),
  UV_PYTHON_INSTALL_DIR: path.join(ENGINEER_CACHE, 'python'), UV_PYTHON_DOWNLOADS: 'never',
  // Bug 411: Poetry, Pipenv and PDM, when a project's test steps use them: their caches out of the home (a sandboxed run can't write there: Poetry's
  // install failed on `mkdir` in a real run, 2026-11-25), and the environments they make inside the project's folder, where the run can write and HQ's
  // throwaway checkout takes them with it
  POETRY_CACHE_DIR: path.join(ENGINEER_CACHE, 'poetry'), POETRY_VIRTUALENVS_IN_PROJECT: 'true', PIPENV_CACHE_DIR: path.join(ENGINEER_CACHE, 'pipenv'), PIPENV_VENV_IN_PROJECT: '1',
  PDM_CACHE_DIR: path.join(ENGINEER_CACHE, 'pdm'),
  // Bug 413: the pnpm and Yarn that Corepack downloads, kept with the other caches: its own folder is in home (~/.cache/node/corepack), where a
  // sandboxed run can neither read nor write. A registry named makes it fetch Yarn 2+ from npm's (allowed), not repo.yarnpkg.com (2.1.322, corepack 0.34)
  COREPACK_HOME: path.join(ENGINEER_CACHE, 'corepack'), COREPACK_NPM_REGISTRY: process.env.COREPACK_NPM_REGISTRY || 'https://registry.npmjs.org',
})
/** Bug 455: where an engineer's (and the Launch helper's) Yarn, pnpm and Bun keep what they download: the same folders as HQ's own installs (testrun.ts
 *  toolCaches), so a second ticket reuses the first one's downloads. Their own folders are in the home, which the sandbox can't write. Real engineers on
 *  2.1.322, 2026-11-27: pnpm 12 failed outright when a store was already in the home (ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK, "Operation not permitted"),
 *  and pnpm 10 made a store of its own in the worktree (`.pnpm-store/`, untracked, downloading everything again). pnpm 11 and 12 read
 *  pnpm_config_store_dir, pnpm 10 and older npm_config_store_dir only (Bug 450). npm 11 warns about that one on every command ("Unknown env config
 *  store-dir"), so it goes only to a project that uses pnpm (`pnpm`: usesPnpm). */
const PNPM_STORE = path.join(ENGINEER_CACHE, 'pnpm-store')
export const installCaches = (pnpm: boolean): Record<string, string> => ({
  YARN_CACHE_FOLDER: path.join(ENGINEER_CACHE, 'yarn'), YARN_GLOBAL_FOLDER: path.join(ENGINEER_CACHE, 'yarn-berry'),
  BUN_INSTALL_CACHE_DIR: path.join(ENGINEER_CACHE, 'bun'), pnpm_config_store_dir: PNPM_STORE, ...(pnpm ? { npm_config_store_dir: PNPM_STORE } : {}),
})
/** Bug 455: pnpm 12 keeps its lock files in these folders of /tmp, by that fixed name (not $TMPDIR, nor next to the store), shared by every pnpm 12 of the
 *  user, which is what makes two installs into one store safe. An agent's sandbox writes only its own temp folder there, so every install failed with
 *  ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK "Operation not permitted", whatever the store (real engineer on 2.1.322; pnpm 10 and 11 keep no locks
 *  there). By the real path, which the sandbox compares (Bug 59). */
export const pnpmLockDirs = (): string[] => ['pnpm-store-operation-locks', 'pnpm-dir-locks', 'pnpm-verify-deps-install-locks']
  .map((n) => path.join(real('/tmp'), `${n}-${process.getuid?.() ?? 0}`))
/** Whether the project in `repo` (the main checkout) uses pnpm: a pnpm-lock.yaml or pnpm-workspace.yaml, or a package.json whose `packageManager` is
 *  pnpm, in its top folder or a folder right inside it (a `web/` part). Not node_modules or hidden folders. */
export function usesPnpm(repo: string | undefined): boolean {
  if (!repo) return false
  const says = (dir: string): boolean => {
    if (['pnpm-lock.yaml', 'pnpm-workspace.yaml'].some((f) => fs.existsSync(path.join(dir, f)))) return true
    try { return /^pnpm@/.test(String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.packageManager ?? '')) } catch { return false }
  }
  if (says(repo)) return true
  let dirs: fs.Dirent[] = []
  try { dirs = fs.readdirSync(repo, { withFileTypes: true }) } catch { return false }
  return dirs.some((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && says(path.join(repo, d.name)))
}

const RELAY = path.join(import.meta.dirname, 'mcprelay.mjs')
/** An agent's "hq" MCP server: the relay (mcprelay.mjs), which Claude Code starts itself and which passes each call on to the backend.
 *  Bug 78: connected to the backend directly, an agent lost HQ's tools for good once the backend had been down for 15 s. The relay
 *  reads the agent's token from its file; the backend's own node runs it, or the one on PATH when that binary has since been replaced. */
export function buildMcp(tokenFile: string): Record<string, unknown> {
  return { mcpServers: { hq: { type: 'stdio', command: NODE(), args: [RELAY], env: { HQ_MCP_URL: `http://127.0.0.1:${PORTS.mcp}/mcp`, HQ_TOKEN_FILE: tokenFile } } } }
}

/** CLI flags per role (excluding the common ones the launcher adds). Engineers start in plan mode; one fixing a merge conflict on
 *  finished work starts in acceptEdits (no plan to review; spike 2026-10-26: no gate, and Bash git merge runs sandboxed). */
export function roleFlags(role: Role, opts: { worktreeName?: string; model: string; permissionMode?: 'plan' | 'acceptEdits' }): string[] {
  if (role === 'engineer') {
    return ['--worktree', opts.worktreeName!, '--restricted', '--tools', ENGINEER_TOOLS.join(','), '--setting-sources', 'user', '--disable-slash-commands',
      '--disallowedTools', ...ENGINEER_DISALLOWED, '--permission-mode', opts.permissionMode ?? 'plan', '--model', opts.model]
  }
  if (role === 'launcher') {
    return ['--worktree', opts.worktreeName!, '--restricted', '--tools', LAUNCHER_TOOLS.join(','), '--setting-sources', 'user', '--disable-slash-commands',
      '--disallowedTools', ...LAUNCHER_DISALLOWED, '--permission-mode', 'default', '--model', opts.model]
  }
  return ['--disallowedTools', ...PLANNER_DISALLOWED, '--permission-mode', 'default', '--model', opts.model]
}
/** The UI tester (uitester.ts) never sees code. Claude Code gives it a browser (Playwright MCP, as `browser`) and HQ's two scenario tools (`uitest`), and
 *  nothing else: no Bash, Read, Edit or Write (`--tools ''`), no MCP server but those two (`--strict-mcp-config`), and of the browser's tools only what a
 *  person does with a page. Running JavaScript in the page, uploading files, the network and console logs (HQ records those itself), other tabs: refused,
 *  which in 2.1.322 takes them off the tester's list altogether (spike 2026-11-17). Its browser runs in HQ's sandbox, which lets it reach the app's port and
 *  nothing else and can't read the project (testrun.ts browserProfile); it starts in an empty folder and is told only the app's address. */
export const TESTER_TOOLS = [...BROWSER_TOOLS.map((t) => `mcp__browser__browser_${t}`), 'mcp__uitest__start_scenario', 'mcp__uitest__finish_scenario']
export const TESTER_DENIED = ['evaluate', 'run_code_unsafe', 'file_upload', 'network_request', 'network_requests', 'console_messages', 'tabs', 'close', 'resize',
  'emulate_media', 'drag', 'drop', 'find', 'install', 'pdf_save', 'generate_locator', 'start_tracing', 'stop_tracing'].map((t) => `mcp__browser__browser_${t}`)
/** The tester's hooks: before and after each browser tool, Claude Code tells the tester's host (uitesthost.mjs, on `ctrl`), which stamps it on HQ's clock and
 *  refuses a step past the scenario's budget. A command hook, since the host isn't HQ's hooks server. Claude Code waits for each answer, so a step's record
 *  is complete before the next step begins. */
export function testerSettings(ctrl: number): Record<string, unknown> {
  const to = (what: string, timeout: number) => [{ matcher: '^mcp__browser__', hooks: [{ type: 'command', timeout,
    command: `curl -s -m ${timeout - 5} -X POST --data-binary @- http://127.0.0.1:${ctrl}/${what}` }] }]
  return { permissions: { disableBypassPermissionsMode: 'disable', disableAutoMode: 'disable', allow: TESTER_TOOLS, deny: TESTER_DENIED },
    hooks: { PreToolUse: to('pre', 15), PostToolUse: to('post', 65), PostToolUseFailure: to('post-failed', 15) } }
}
/** The tester's flags (Claude Code's `-p` call, checker.ts `call`, adds its own): the lockdown above, its MCP servers, its hooks. */
export function testerFlags(o: { model: string; mcp: Record<string, unknown>; ctrl: number }): string[] {
  return ['--model', o.model, '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: o.mcp }), '--allowedTools', TESTER_TOOLS.join(','),
    '--disallowedTools', ...TESTER_DENIED, '--settings', JSON.stringify(testerSettings(o.ctrl))]
}
export function rolePromptPath(role: Role): string { return path.join(PATHS.roles, `${role}.prompt.md`) }

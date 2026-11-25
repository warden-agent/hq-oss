// Role definitions: models, permission mode, tools, settings generator. Mirrors the plan §2.3/§2.4 and the M0-validated spike settings.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PATHS, PORTS, DEFAULTS, ENGINEER_CACHE, GH_CONFIG_DIR, TURN_WAIT_S, HQ_AWAY_WAIT_S } from './config.ts'
import { getSetting } from './db.ts'
import { real, shq } from './util.ts'
import { BROWSER_TOOLS } from './uitesterrules.ts'

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
/** Where engineers may download packages from: npm, PyPI and crates.io (each index + files; Bug 71). */
export const PACKAGE_REGISTRIES = ['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org', 'index.crates.io', 'static.crates.io']
/** Bug 71: rustup puts `cargo` and `rustc` in ~/.cargo/bin and the toolchains in ~/.rustup, and an engineer's sandbox reads nothing in home
 *  (blockReadsOutsideWorkingDirectories), so its `cargo` was "operation not permitted". The sandbox may read those two folders and nothing
 *  else of home: not the rest of ~/.cargo (its credentials; crates download to the engineers' CARGO_HOME, cacheEnv). Both spellings of a
 *  linked folder, as the sandbox compares real paths (Bug 59). None when rustup isn't installed. */
export function rustReads(): string[] {
  const dirs = [path.join(process.env.CARGO_HOME || path.join(HOME, '.cargo'), 'bin'), process.env.RUSTUP_HOME || path.join(HOME, '.rustup')]
  return [...new Set(dirs.filter((d) => fs.existsSync(d)).flatMap((d) => [d, real(d)]))]
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

type SettingsOpts = { agentDir: string; repoId?: string; repoAllowlist?: string[]; editOverrides?: string[]; localOnly?: boolean }
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
    // Python venvs live in the worktree; uv uses the machine's Python, since downloading one needs github.com, which stays off
    // the allowlist (spike 2026-10-29: uv sync + pytest pass in this sandbox).
    env: cacheEnv(),
    sandbox: {
      enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true,
      network: { allowedDomains: ['127.0.0.1', 'localhost', '[::1]', ...(opts.localOnly ? [] : [...PACKAGE_REGISTRIES, ...(opts.repoAllowlist ?? [])])],
        strictAllowlist: true, allowLocalBinding: true },
      // On a Linux with no keyring, gh keeps its token in a file in GH_CONFIG_DIR. HQ's own folder by its real path: that's what the sandbox compares (Bug 59).
      filesystem: { allowWrite: [ENGINEER_CACHE], allowRead: rustReads(), // Bug 71: rustup's cargo and toolchains
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
})

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

// Role definitions: models, permission mode, tools, settings generator. Mirrors the plan §2.3/§2.4 and the M0-validated spike settings.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PATHS, PORTS, DEFAULTS, ENGINEER_CACHE, GH_CONFIG_DIR, TURN_WAIT_S } from './config.ts'
import { getSetting } from './db.ts'
import { real } from './util.ts'

export type Role = 'tpm' | 'architect' | 'engineer' | 'launcher'
const HOME = os.homedir()
const HOOK = (token: string) => `http://127.0.0.1:${PORTS.hooks}/hooks/${token}`

export const ENGINEER_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'LSP', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'Agent']
export const ENGINEER_DISALLOWED = ['EnterWorktree', 'ExitWorktree', 'WebFetch', 'WebSearch', 'SendMessage', 'ListAgents', 'AskUserQuestion', 'Monitor', 'Skill']
/** Where engineers may download packages from: npm and PyPI (index + files). */
export const PACKAGE_REGISTRIES = ['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org']
/** The Launch helper looks around and tries things in its sandbox; it never changes the project (launchhelper.ts). */
export const LAUNCHER_TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'ToolSearch']
export const LAUNCHER_DISALLOWED = ['Edit', 'Write', 'NotebookEdit', 'Agent', ...ENGINEER_DISALLOWED]
export const PLANNER_DISALLOWED = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Monitor', 'EnterWorktree', 'ExitWorktree', 'WebFetch', 'WebSearch', 'SendMessage', 'ListAgents', 'AskUserQuestion', 'Skill']

export function modelFor(role: Role, size?: string): string {
  const m = getSetting('models', DEFAULTS.models)
  if (role === 'tpm') return m.tpm
  if (role === 'architect') return m.architect
  if (role === 'launcher') return (m as Partial<typeof m>).launcher ?? m.engineer_s // saved before the helper existed: the S engineer's
  return size === 'S' ? m.engineer_s : m.engineer_ml
}

function hookGroup(token: string, extra: Record<string, unknown> = {}) { return [{ hooks: [{ type: 'http', url: HOOK(token), timeout: 10, ...extra }] }] }

export function buildSettings(role: Role, token: string, opts: { agentDir: string; repoAllowlist?: string[]; editOverrides?: string[] }): Record<string, unknown> {
  const gateTimeout = getSetting('gate_timeout_s', DEFAULTS.gate_timeout_s)
  const sessionStartCmd = `curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary @- ${HOOK(token)}`
  const hooks: Record<string, unknown> = {
    SessionStart: [{ hooks: [{ type: 'command', command: sessionStartCmd, timeout: 10 }] }],
    UserPromptSubmit: hookGroup(token),
    PermissionRequest: [
      { matcher: 'ExitPlanMode', hooks: [{ type: 'http', url: HOOK(token), timeout: gateTimeout, onFailure: 'block' }] },
      { matcher: '^(?!ExitPlanMode$).*', hooks: [{ type: 'http', url: HOOK(token), timeout: 30, onFailure: 'block' }] },
    ],
    PreToolUse: hookGroup(token), PostToolUse: hookGroup(token), PostToolUseFailure: hookGroup(token),
    Stop: hookGroup(token), StopFailure: hookGroup(token), Notification: hookGroup(token),
    PreModelSwitch: hookGroup(token), PostModelSwitch: hookGroup(token), PreCompact: hookGroup(token), PostCompact: hookGroup(token),
    ConfigChange: hookGroup(token), SubagentStart: hookGroup(token), SubagentStop: hookGroup(token), TaskCreated: hookGroup(token), TaskCompleted: hookGroup(token),
    SessionEnd: [{ hooks: [{ type: 'http', url: HOOK(token), timeout: 5 }] }],
  }
  const base: Record<string, unknown> = {
    permissions: { disableAutoMode: 'disable', disableBypassPermissionsMode: 'disable', deny: ['Cd'] },
    switchModelsOnFlag: false,
    crossSessionInbound: 'refuse',
    hooks,
  }
  if (role !== 'engineer' && role !== 'launcher') return base // the Launch helper gets the engineer's sandbox, and runs no git writes
  // A build or test run can be held at this hook until its turn comes (heavy.ts), so a Bash command's hook gets longer than that wait. Past it, Claude Code runs
  // the command anyway (spike 2026-11-09: a hook that times out counts as no answer).
  hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'http', url: HOOK(token), timeout: TURN_WAIT_S + 60 }] }, { matcher: '^(?!Bash$).*', hooks: hookGroup(token)[0]!.hooks }]
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
    'Cd', 'Bash(claude *)', 'Bash(tmux *)', 'Bash(sudo *)', 'Bash(gh *)', 'Bash(git push*)', 'Bash(git config core.hooksPath*)', 'Bash(open *)', 'Bash(osascript *)',
  ]
  return {
    ...base,
    permissions: { ...(base.permissions as object), blockReadsOutsideWorkingDirectories: true, allow: ['mcp__hq__*'], deny },
    plansDirectory: '.hq-plans',
    // Every package cache sits in ENGINEER_CACHE, outside home: npm's (with the log npm writes on every run), Go's (spike S5), Rust's and
    // Python's. Spike 2026-10-31 (`-p` runs with these settings): `npm test` passed with and without npm_config_cache, so the old
    // "exit 255 in the spike HQ" isn't explained by the npm cache; with it set, nothing is written under ~/.npm at all.
    // Python venvs live in the worktree; uv uses the machine's Python, since downloading one needs github.com, which stays off
    // the allowlist (spike 2026-10-29: uv sync + pytest pass in this sandbox).
    env: cacheEnv(),
    sandbox: {
      enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true,
      network: { allowedDomains: ['127.0.0.1', 'localhost', '[::1]', ...PACKAGE_REGISTRIES, ...(opts.repoAllowlist ?? [])], strictAllowlist: true, allowLocalBinding: true },
      // On a Linux with no keyring, gh keeps its token in a file in GH_CONFIG_DIR. HQ's own folder by its real path: that's what the sandbox compares (Bug 59).
      filesystem: { allowWrite: [ENGINEER_CACHE], denyRead: [`${HOME}/.claude`, `${HOME}/.claude.json`, real(PATHS.home), `${HOME}/.ssh`, `${HOME}/.aws`, `${HOME}/.config/gh`,
        GH_CONFIG_DIR] },
      credentials: { envVars: [{ name: 'HQ_AGENT_ID', mode: 'deny' }, { name: 'HQ_BACKEND', mode: 'deny' }, { name: 'ANTHROPIC_API_KEY', mode: 'deny' }, { name: 'GH_TOKEN', mode: 'deny' }, { name: 'GITHUB_TOKEN', mode: 'deny' }] },
    },
  }
}

/** Where package tools keep their caches, for anything that runs sandboxed (engineers, and auto mode's test runs). */
export const cacheEnv = (): Record<string, string> => ({
  npm_config_cache: path.join(ENGINEER_CACHE, 'npm'),
  GOCACHE: path.join(ENGINEER_CACHE, 'go-build'), GOMODCACHE: path.join(ENGINEER_CACHE, 'gomod'), GOPATH: path.join(ENGINEER_CACHE, 'gopath'),
  CARGO_HOME: path.join(ENGINEER_CACHE, 'cargo'), // where crates download to; cargo itself is still found on PATH (~/.cargo/bin), and rustup's toolchains stay put
  UV_CACHE_DIR: path.join(ENGINEER_CACHE, 'uv'), PIP_CACHE_DIR: path.join(ENGINEER_CACHE, 'pip'),
  UV_PYTHON_INSTALL_DIR: path.join(ENGINEER_CACHE, 'python'), UV_PYTHON_DOWNLOADS: 'never',
})

const RELAY = path.join(import.meta.dirname, 'mcprelay.mjs')
/** An agent's "hq" MCP server: the relay (mcprelay.mjs), which Claude Code starts itself and which passes each call on to the backend.
 *  Bug 78: connected to the backend directly, an agent lost HQ's tools for good once the backend had been down for 15 s. The relay
 *  reads the agent's token from its file; the backend's own node runs it, or the one on PATH when that binary has since been replaced. */
export function buildMcp(tokenFile: string): Record<string, unknown> {
  const node = fs.existsSync(process.execPath) ? process.execPath : 'node'
  return { mcpServers: { hq: { type: 'stdio', command: node, args: [RELAY], env: { HQ_MCP_URL: `http://127.0.0.1:${PORTS.mcp}/mcp`, HQ_TOKEN_FILE: tokenFile } } } }
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
export function rolePromptPath(role: Role): string { return path.join(PATHS.roles, `${role}.prompt.md`) }

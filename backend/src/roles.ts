// Role definitions: models, permission mode, tools, settings generator. Mirrors the plan §2.3/§2.4 and the M0-validated spike settings.
import os from 'node:os'
import path from 'node:path'
import { PATHS, PORTS, DEFAULTS } from './config.ts'
import { getSetting } from './db.ts'

export type Role = 'tpm' | 'architect' | 'engineer'
const HOME = os.homedir()
const HOOK = (token: string) => `http://127.0.0.1:${PORTS.hooks}/hooks/${token}`

export const ENGINEER_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'LSP', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'Agent']
export const ENGINEER_DISALLOWED = ['EnterWorktree', 'ExitWorktree', 'WebFetch', 'WebSearch', 'SendMessage', 'ListAgents', 'AskUserQuestion', 'Monitor', 'Skill']
export const PLANNER_DISALLOWED = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Monitor', 'EnterWorktree', 'ExitWorktree', 'WebFetch', 'WebSearch', 'SendMessage', 'ListAgents', 'AskUserQuestion', 'Skill']

export function modelFor(role: Role, size?: string): string {
  const m = getSetting('models', DEFAULTS.models)
  if (role === 'tpm') return m.tpm
  if (role === 'architect') return m.architect
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
  if (role !== 'engineer') return base
  const overrides = new Set(opts.editOverrides ?? [])
  const deny = [
    'Read(~/.claude/**)', 'Read(~/.claude.json)', `Read(//${HOME}/.hq/**)`, 'Read(.env)', 'Read(.env.*)', 'Read(**/secrets/**)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)',
    'Edit(.claude/**)', 'Edit(**/.claude-plugin/**)', 'Edit(.mcp.json)', 'Edit(.git/**)', 'Edit(.githooks/**)',
    ...(overrides.has('.github/workflows/**') ? [] : ['Edit(.github/workflows/**)']),
    ...(overrides.has('CLAUDE.md') ? [] : ['Edit(**/CLAUDE.md)']),
    // The Bash(...) prefixes below are a convenience (they stop the obvious command), not a boundary: `env git push`, `git -C`
    // and friends get past them. What holds is the sandbox (no github.com on the network allowlist, ~/.hq and gh config unreadable,
    // the main repo's .git/config and .git/hooks unwritable: spike S1, 2026-10-25) and engineers holding no credentials.
    'Cd', 'Bash(claude *)', 'Bash(tmux *)', 'Bash(sudo *)', 'Bash(gh *)', 'Bash(git push*)', 'Bash(git config core.hooksPath*)', 'Bash(open *)', 'Bash(osascript *)',
  ]
  return {
    ...base,
    permissions: { ...(base.permissions as object), blockReadsOutsideWorkingDirectories: true, allow: ['mcp__hq__*'], deny },
    plansDirectory: '.hq-plans',
    sandbox: {
      enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true,
      network: { allowedDomains: ['127.0.0.1', 'localhost', '[::1]', 'registry.npmjs.org', 'registry.yarnpkg.com', ...(opts.repoAllowlist ?? [])], strictAllowlist: true, allowLocalBinding: true },
      filesystem: { denyRead: [`${HOME}/.claude`, `${HOME}/.claude.json`, PATHS.home, `${HOME}/.ssh`, `${HOME}/.aws`, `${HOME}/.config/gh`] },
      credentials: { envVars: [{ name: 'HQ_AGENT_ID', mode: 'deny' }, { name: 'HQ_BACKEND', mode: 'deny' }, { name: 'ANTHROPIC_API_KEY', mode: 'deny' }, { name: 'GH_TOKEN', mode: 'deny' }, { name: 'GITHUB_TOKEN', mode: 'deny' }] },
    },
  }
}

export function buildMcp(token: string): Record<string, unknown> {
  return { mcpServers: { hq: { type: 'http', url: `http://127.0.0.1:${PORTS.mcp}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }
}

/** CLI flags per role (excluding the common ones the launcher adds). Engineers start in plan mode; one fixing a merge conflict on
 *  finished work starts in acceptEdits (no plan to review; spike 2026-10-26: no gate, and Bash git merge runs sandboxed). */
export function roleFlags(role: Role, opts: { worktreeName?: string; model: string; permissionMode?: 'plan' | 'acceptEdits' }): string[] {
  if (role === 'engineer') {
    return ['--worktree', opts.worktreeName!, '--restricted', '--tools', ENGINEER_TOOLS.join(','), '--setting-sources', 'user', '--disable-slash-commands',
      '--disallowedTools', ...ENGINEER_DISALLOWED, '--permission-mode', opts.permissionMode ?? 'plan', '--model', opts.model]
  }
  return ['--disallowedTools', ...PLANNER_DISALLOWED, '--permission-mode', 'default', '--model', opts.model]
}
export function rolePromptPath(role: Role): string { return path.join(PATHS.roles, `${role}.prompt.md`) }

// HQ backend configuration: paths, ports, defaults. State lives under ~/.hq.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'

export const HQ_HOME = process.env.HQ_HOME ?? path.join(os.homedir(), '.hq')
export const PATHS = {
  home: HQ_HOME,
  db: path.join(HQ_HOME, 'hq.sqlite'),
  agents: path.join(HQ_HOME, 'agents'),          // per-agent dirs: settings.json, mcp.json, token, launch.sh, plans/
  workspaces: path.join(HQ_HOME, 'workspaces'),  // materialized per-role read views
  roles: path.join(HQ_HOME, 'roles'),            // role prompt files
  logs: path.join(HQ_HOME, 'logs'),
  bin: path.join(HQ_HOME, 'bin'),
  plugin: path.join(HQ_HOME, 'plugin'),          // the hq mod (copied from the repo at setup)
  uiToken: path.join(HQ_HOME, 'ui-token'),
}
for (const p of [PATHS.home, PATHS.agents, PATHS.workspaces, PATHS.roles, PATHS.logs, PATHS.bin]) fs.mkdirSync(p, { recursive: true })

export const PORTS = {
  ui: Number(process.env.HQ_UI_PORT ?? 4780),      // REST + WebSocket + static UI
  hooks: Number(process.env.HQ_HOOKS_PORT ?? 4781), // http hooks ingress
  mcp: Number(process.env.HQ_MCP_PORT ?? 4782),     // HTTP MCP server "hq"
}
export const BIND = '127.0.0.1'
// GitHub identity the backend uses for clone/fetch (gh's credential helper reads this account's config dir).
export const GITHUB_ACCOUNT = process.env.HQ_GITHUB_ACCOUNT ?? 'warden-agent'
export const GH_CONFIG_DIR = process.env.HQ_GH_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'gh-warden-bot')
export const PINNED_VERSION = process.env.HQ_CLAUDE_VERSION ?? '2.1.300'
export const CLAUDE_BIN = process.env.HQ_CLAUDE_BIN ?? path.join(PATHS.bin, `claude-${PINNED_VERSION}`)

// Default tunables; persisted/overridable through the `settings` table.
export const DEFAULTS = {
  concurrency_cap: 2,
  revision_cap: 2,
  gate_timeout_s: 1800,
  gate_answer_margin_s: 60,
  stuck_working_min: 10,
  stuck_idle_min: 45,
  rotation_context_tokens: 300_000,
  pause_five_hour_pct: 80,
  pause_seven_day_pct: 90,
  dm_per_hour: 6,
  dm_per_peer_min: 5,
  events_retention_days: 30,
  models: { tpm: 'opus', architect: 'opus', engineer_s: 'sonnet', engineer_ml: 'opusplan' },
  takeover_lock_s: 120,
  batch_receive_s: 30, // a batch the mod hasn't reported getting by then is handed out again
  opusplan_switch_window_s: 15,
}

const ROLES = ['tpm', 'architect', 'engineer']
/** Why `value` can't be stored as setting `key`, or null. The settings API takes only these, so a typo can't break launches. */
export function validSetting(key: string, value: unknown): string | null {
  if (key === 'paused_roles') return Array.isArray(value) && value.every((r) => ROLES.includes(r)) ? null : `paused_roles must be a list of ${ROLES.join(', ')}`
  if (!Object.hasOwn(DEFAULTS, key)) return `unknown setting '${key}'`
  const def = DEFAULTS[key as keyof typeof DEFAULTS]
  if (typeof def === 'number') {
    if (key === 'concurrency_cap' || key === 'revision_cap') return Number.isInteger(value) && (value as number) >= 1 ? null : `${key} must be a whole number of at least 1`
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? null : `${key} must be a number of at least 0`
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${key} must be an object like ${JSON.stringify(def)}`
  for (const k of Object.keys(def)) { const v = (value as Record<string, unknown>)[k]; if (typeof v !== 'string' || !v.trim()) return `${key}.${k} must be a model name` }
  return null
}

export function newToken(): string { return randomBytes(24).toString('base64url') }
export function uiToken(): string {
  try { return fs.readFileSync(PATHS.uiToken, 'utf8').trim() } catch { const t = newToken(); fs.writeFileSync(PATHS.uiToken, t, { mode: 0o600 }); return t }
}

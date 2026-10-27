// Agent lifecycle: create (token, generated settings/mcp/launch script), launch in tmux, stop, recover.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PATHS, PORTS, CLAUDE_BIN, newToken } from './config.ts'
import { db, one, q, run, now } from './db.ts'
import { emit, patch } from './events.ts'
import { id, sha, shq } from './util.ts'
import * as tmux from './tmux.ts'
import { buildMcp, buildSettings, roleFlags, rolePromptPath, type Role } from './roles.ts'
import { ensureTrusted } from './trust.ts'

export type Agent = {
  id: string; role: Role; feature_id: string | null; ticket_id: string | null; review_request_id: string | null; model_alias: string; model_live: string | null
  claude_session_id: string | null; transcript_path: string | null; tmux_session: string; cwd: string; token_hash: string; token_revoked_at: number | null
  status: string; in_plan_mode: number; last_event_at: number | null; takeover_locked_until: number | null; mod_seen_at: number | null; last_gate_allow_at: number | null
  paused_reason: string | null; started_at: number; ended_at: number | null; exit_code: number | null; launch_prompt: string | null; display_name: string | null
}
export const agentDir = (agentId: string): string => path.join(PATHS.agents, agentId)
export const tmuxName = (agentId: string): string => `hq-${agentId}`
export function getAgent(agentId: string): Agent | undefined { return one<Agent>('SELECT * FROM agents WHERE id = ?', agentId) }
export function agentByToken(token: string): Agent | undefined {
  const a = one<Agent>('SELECT * FROM agents WHERE token_hash = ?', sha(token)); if (!a || a.token_revoked_at) return undefined; return a
}
export function agentBySession(sessionId: string): Agent | undefined { return one<Agent>('SELECT * FROM agents WHERE claude_session_id = ?', sessionId) }
export function liveAgents(): Agent[] { return q<Agent>("SELECT * FROM agents WHERE status != 'exited' ORDER BY started_at") }
/** Writes agent columns (a key that isn't one is a type error, not a failed UPDATE at runtime). */
export function update(agentId: string, fields: Partial<Omit<Agent, 'id'>>): void {
  const keys = Object.keys(fields) as (keyof typeof fields)[]; if (!keys.length) return
  run(`UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k] as never), agentId)
  patch('agent', agentId, fields)
}

export type LaunchSpec = {
  role: Role; featureId?: string; ticketId?: string; reviewRequestId?: string; model: string; cwd: string; displayName: string
  launchPrompt: string; worktreeName?: string; permissionMode?: 'plan' | 'acceptEdits'
  extraEnv?: Record<string, string>; extraFlags?: string[]; repoAllowlist?: string[]; editOverrides?: string[]; size?: string
}

export async function launchAgent(spec: LaunchSpec): Promise<Agent> {
  const agentId = id(spec.role === 'engineer' ? 'eng' : spec.role === 'architect' ? 'arch' : 'tpm')
  const token = newToken()
  const dir = agentDir(agentId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'token'), token, { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(buildSettings(spec.role, token, { agentDir: dir, repoAllowlist: spec.repoAllowlist, editOverrides: spec.editOverrides }), null, 2), { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(buildMcp(token), null, 2), { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'prompt.md'), spec.launchPrompt)
  const sessionId = randomUUID()
  const env: Record<string, string> = { HQ_AGENT_ID: agentId, HQ_BACKEND: `http://127.0.0.1:${PORTS.hooks}`, HQ_TOKEN_FILE: path.join(dir, 'token'), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', ...(spec.extraEnv ?? {}) }
  const flags = ['--session-id', sessionId, '--name', spec.displayName, '--settings', path.join(dir, 'settings.json'), '--strict-mcp-config', '--mcp-config', path.join(dir, 'mcp.json'),
    '--plugin-dir', PATHS.plugin, '--append-system-prompt-file', rolePromptPath(spec.role),
    ...roleFlags(spec.role, { worktreeName: spec.worktreeName, model: spec.model, permissionMode: spec.permissionMode }), ...(spec.extraFlags ?? [])]
  const script = ['#!/bin/bash', ...Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`), `cd ${shq(spec.cwd)}`, `exec ${shq(CLAUDE_BIN)} ${flags.map(shq).join(' ')}`].join('\n') + '\n'
  const scriptPath = path.join(dir, 'launch.sh'); fs.writeFileSync(scriptPath, script, { mode: 0o700 })
  const t = now()
  run(`INSERT INTO agents(id, role, feature_id, ticket_id, review_request_id, model_alias, claude_session_id, tmux_session, cwd, token_hash, status, in_plan_mode, started_at, launch_prompt, display_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, agentId, spec.role, spec.featureId ?? null, spec.ticketId ?? null, spec.reviewRequestId ?? null, spec.model, sessionId, tmuxName(agentId), spec.cwd, sha(token), 'launching',
       spec.role === 'engineer' && spec.permissionMode !== 'acceptEdits' ? 1 : 0, t, spec.launchPrompt, spec.displayName)
  run('INSERT INTO sessions(id, agent_id, claude_session_id, started_at) VALUES (?,?,?,?)', id('ses'), agentId, sessionId, t)
  run('INSERT INTO batches(id, agent_id, text, created_at, method) VALUES (?,?,?,?,?)', id('B'), agentId, spec.launchPrompt, t, 'launch')
  try {
    await ensureTrusted(spec.cwd)
    await tmux.newSession(tmuxName(agentId), `bash ${shq(scriptPath)}; echo HQ-AGENT-EXITED; sleep 86400`, { cwd: spec.cwd })
  } catch (e) {
    lost(agentId, { launch: String(e) }); throw e // a launch that never started doesn't count against the parallel limit
  }
  const tk = newToken(); fs.writeFileSync(path.join(dir, 'tmux-token'), tk, { mode: 0o600 })
  await tmux.setHook(tmuxName(agentId), 'client-attached', `curl -s -m 2 -X POST http://127.0.0.1:${PORTS.hooks}/tmux/${agentId}/${tk}/attached`)
  await tmux.setHook(tmuxName(agentId), 'client-detached', `curl -s -m 2 -X POST http://127.0.0.1:${PORTS.hooks}/tmux/${agentId}/${tk}/detached`)
  emit({ agentId, source: 'system', kind: 'agent.launched', payload: { role: spec.role, model: spec.model, cwd: spec.cwd, sessionId } })
  const a = getAgent(agentId)!; patch('agent', agentId, a as unknown as Record<string, unknown>); return a
}

export async function stopAgent(agentId: string, reason = 'stopped'): Promise<void> {
  const a = getAgent(agentId); if (!a) return
  await tmux.killSession(a.tmux_session)
  update(agentId, { status: 'exited', ended_at: now() }); revokeToken(agentId)
  run('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE agent_id = ? AND ended_at IS NULL', now(), reason, agentId)
  emit({ agentId, source: 'system', kind: 'agent.stopped', payload: { reason } })
}
/** An agent whose process is gone without HQ stopping it: exited, token revoked, and `agent.lost` for whoever cleans up. */
export function lost(agentId: string, payload: Record<string, unknown> = {}): void {
  update(agentId, { status: 'exited', ended_at: now() }); revokeToken(agentId); emit({ agentId, source: 'system', kind: 'agent.lost', payload })
}
export function revokeToken(agentId: string): void { update(agentId, { token_revoked_at: now() }); try { fs.rmSync(path.join(agentDir(agentId), 'token')) } catch {} }
export function tmuxToken(agentId: string): string | null { try { return fs.readFileSync(path.join(agentDir(agentId), 'tmux-token'), 'utf8').trim() } catch { return null } }

/** On startup: reconcile DB agents with live tmux sessions. */
export async function recoverAgents(): Promise<void> {
  for (const a of liveAgents()) {
    const alive = await tmux.hasSession(a.tmux_session)
    const dead = alive ? await tmux.paneDead(a.tmux_session) : true
    if (!alive || dead) lost(a.id, { alive, dead })
    else {
      // A "until they detach" hold with nobody attached is left over (e.g. from the old rule that counted HQ's own view): clear it.
      if ((a.takeover_locked_until ?? 0) > now() + 86_400_000 && !(await tmux.clientPids(a.tmux_session)).length) update(a.id, { takeover_locked_until: 0 })
      emit({ agentId: a.id, source: 'system', kind: 'agent.recovered', payload: {} })
    }
  }
}
export function allAgents(): Agent[] { return q<Agent>('SELECT * FROM agents ORDER BY started_at DESC LIMIT 200') }
export { db }

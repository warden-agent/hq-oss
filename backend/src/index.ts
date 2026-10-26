import fs from 'node:fs'
import path from 'node:path'
import { PATHS, PORTS, CLAUDE_BIN, uiToken } from './config.ts'
import { migrate } from './db.ts'
import { recoverAgents } from './agents.ts'
import { startHooksServer } from './hooks.ts'
import { startMcpServer } from './mcp.ts'
import { startUiServer } from './ui.ts'
import { startStuckLoop } from './stuck.ts'
import { startMergeWatcher } from './mergewatch.ts'
import { sweepWorktrees } from './slots.ts'
import { startListeners } from './listeners.ts'
import { recoverPreviews } from './preview.ts'
import { emit } from './events.ts'
import { attention } from './attention.ts'
import { startRetention } from './retention.ts'
import { ensureTrusted } from './trust.ts'

/** The repo's role prompts and mod are what agents get: copied into HQ's home on every start when they differ (new agents
 *  pick them up; running ones keep what they started with). Extra files already in the plugin folder are left alone. */
function ensureAssets(): void {
  const repoPlugin = path.resolve(import.meta.dirname, '../../plugin'); const repoRoles = path.resolve(import.meta.dirname, '../roles')
  const changed: string[] = []
  const sync = (src: string, dst: string) => {
    const s = fs.readFileSync(src); if (fs.existsSync(dst) && fs.readFileSync(dst).equals(s)) return
    fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, s); changed.push(path.relative(PATHS.home, dst))
  }
  if (fs.existsSync(repoPlugin)) {
    for (const f of fs.readdirSync(repoPlugin, { recursive: true, withFileTypes: true })) {
      if (f.isFile()) { const src = path.join(f.parentPath, f.name); sync(src, path.join(PATHS.plugin, path.relative(repoPlugin, src))) }
    }
  }
  for (const f of ['tpm', 'engineer', 'architect']) { const src = path.join(repoRoles, `${f}.prompt.md`); if (fs.existsSync(src)) sync(src, path.join(PATHS.roles, `${f}.prompt.md`)) }
  if (changed.length) emit({ agentId: null, source: 'system', kind: 'assets.updated', payload: { files: changed } })
  if (!fs.existsSync(CLAUDE_BIN)) { console.error(`Pinned Claude Code binary missing: ${CLAUDE_BIN}`); process.exit(1) }
}
async function main(): Promise<void> {
  migrate(); ensureAssets()
  // Every TPM workspace is a plain folder under this one, so trusting it once means TPM launches never write ~/.claude.json.
  try { await ensureTrusted(PATHS.workspaces) } catch (e) { emit({ agentId: null, source: 'system', kind: 'trust.error', payload: { error: String(e) } }) }
  await recoverAgents()
  await sweepWorktrees().catch((e) => emit({ agentId: null, source: 'system', kind: 'worktree.sweep.error', payload: { error: String(e) } }))
  await recoverPreviews() // before the merge watcher: its first check can restart a preview
  startListeners()
  startHooksServer(); startMcpServer(); startUiServer(); startStuckLoop(); startMergeWatcher(); startRetention()
  emit({ agentId: null, source: 'system', kind: 'backend.started', payload: { ports: PORTS } })
  console.log(`HQ backend up. UI: http://127.0.0.1:${PORTS.ui}/?token=${uiToken()}  hooks :${PORTS.hooks}  mcp :${PORTS.mcp}  state ${PATHS.home}`)
}
// HQ keeps running (nothing would restart it), but the user sees that something went wrong: one ⚠ item until they tick it off.
const crashed = (what: string) => (e: unknown) => {
  console.error(`[${what}]`, e)
  try {
    emit({ agentId: null, source: 'system', kind: 'backend.error', payload: { error: String(e) } })
    attention('backend_error', `HQ hit an unexpected error (${what}): ${String(e).slice(0, 200)}. It kept running; the backend log has the details.`)
  } catch {}
}
process.on('unhandledRejection', crashed('unhandledRejection'))
process.on('uncaughtException', crashed('uncaughtException'))
main().catch((e) => { console.error(e); process.exit(1) })

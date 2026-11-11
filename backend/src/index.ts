import fs from 'node:fs'
import path from 'node:path'
import { PATHS, PORTS, uiToken } from './config.ts'
import { migrate } from './db.ts'
import { recoverAgents, liveAgents } from './agents.ts'
import { tellIfHqWasAway } from './delivery.ts'
import { startHooksServer } from './hooks.ts'
import { startMcpServer } from './mcp.ts'
import { startUiServer } from './ui.ts'
import { startStuckLoop } from './stuck.ts'
import { startBgRuns } from './bgruns.ts'
import { startMergeWatcher } from './mergewatch.ts'
import { sweepWorktrees } from './slots.ts'
import { startListeners } from './listeners.ts'
import { recoverPreviews } from './preview.ts'
import { recoverHelpers } from './launchhelper.ts'
import { repos } from './records.ts'
import { emit } from './events.ts'
import { attention } from './attention.ts'
import { startRetention } from './retention.ts'
import { startFreshStartLoop } from './freshstart.ts'
import { ensureTrusted } from './trust.ts'
import { startAutoLoop } from './auto.ts'
import { killTestRuns, sweepRunTmp, sweepTestWorktrees } from './testrun.ts'
import { startLeftoverSweeps, sweepAgentTmp, sweepNow } from './leftovers.ts'
import { checkClaude, claudeInfo, ensureClaude, startClaudeCheck } from './claudecheck.ts'

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
  for (const f of ['tpm', 'engineer', 'architect', 'launcher']) { const src = path.join(repoRoles, `${f}.prompt.md`); if (fs.existsSync(src)) sync(src, path.join(PATHS.roles, `${f}.prompt.md`)) }
  if (changed.length) emit({ agentId: null, source: 'system', kind: 'assets.updated', payload: { files: changed } })
}
async function main(): Promise<void> {
  migrate(); ensureAssets()
  try { await ensureClaude() } catch (e) { console.error((e as Error).message); process.exit(1) } // no agent could start
  // Bug 97: which Claude Code the agents run, and whether HQ was checked on it, before the page or a launch can ask. A look that fails stops nothing
  await checkClaude().catch((e) => emit({ agentId: null, source: 'system', kind: 'claude.check_error', payload: { error: String(e) } }))
  // Every TPM workspace is a plain folder under this one, so trusting it once means TPM launches never write ~/.claude.json.
  try { await ensureTrusted(PATHS.workspaces) } catch (e) { emit({ agentId: null, source: 'system', kind: 'trust.error', payload: { error: String(e) } }) }
  await recoverAgents()
  for (const a of liveAgents()) tellIfHqWasAway(a) // Bug 85: told to wait for HQ while it was down; an idle agent sends no hook to remind HQ
  await sweepWorktrees().catch((e) => emit({ agentId: null, source: 'system', kind: 'worktree.sweep.error', payload: { error: String(e) } }))
  for (const r of repos()) await sweepTestWorktrees(r.path).catch(() => {}) // a test run the last backend didn't finish
  try { // and its temp files (Bug 81)
    const tmps = sweepRunTmp(); if (tmps.length) emit({ agentId: null, source: 'system', kind: 'testrun.tmp_swept', payload: { folders: tmps } })
  } catch { /* the next start */ }
  await recoverPreviews() // before the merge watcher: its first check can restart a preview
  await recoverHelpers(repos()).catch((e) => console.error('launch helper recovery failed', e))
  startBgRuns() // before the first sweep and any hook: it reads back what agents wait on in the background (Bug 96)
  await sweepNow() // what agents' commands left running while HQ was down (Bug 75)
  await sweepAgentTmp() // and the temp folders of agents that ended meanwhile (Bug 81)
  startListeners()
  startHooksServer(); startMcpServer(); startUiServer(); startStuckLoop(); startMergeWatcher(); startRetention(); startFreshStartLoop(); startAutoLoop()
  startLeftoverSweeps()
  startClaudeCheck()
  emit({ agentId: null, source: 'system', kind: 'backend.started', payload: { ports: PORTS, claude: claudeInfo() } })
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
// tmux kill-session hangs up, a test HQ's stop() sends SIGTERM, Ctrl-C SIGINT. Agents and previews run on in tmux and a restart picks them up; test runs don't (Bug 69).
for (const [sig, code] of [['SIGTERM', 143], ['SIGHUP', 129], ['SIGINT', 130]] as const) process.once(sig, () => { killTestRuns(); process.exit(code) })
main().catch((e) => { console.error(e); process.exit(1) })

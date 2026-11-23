import fs from 'node:fs'
import path from 'node:path'
import { PATHS, PORTS, uiToken } from './config.ts'
import { migrate } from './db.ts'
import { recoverAgents, liveAgents } from './agents.ts'
import { tellIfHqWasAway, typeCutShort } from './delivery.ts'
import { lookAtTurnsAtStart, rebuildHelpers, rebuildTurns, startHooksServer } from './hooks.ts'
import { startMcpServer } from './mcp.ts'
import { startUiServer } from './ui.ts'
import { startStuckLoop } from './stuck.ts'
import { lookAtStart } from './dialogclear.ts'
import { startBgRuns } from './bgruns.ts'
import { startMergeWatcher } from './mergewatch.ts'
import { slotBasesNow, sweepWorktrees } from './slots.ts'
import { startListeners } from './listeners.ts'
import { recoverPreviews, resumeRestarts } from './preview.ts'
import { recoverHelpers, resumeTries } from './launchhelper.ts'
import { recoverSetupHelpers } from './testsetup.ts'
import { repos } from './records.ts'
import { emit } from './events.ts'
import { attention } from './attention.ts'
import { startRetention } from './retention.ts'
import { startFreshStartLoop } from './freshstart.ts'
import { ensureTrusted } from './trust.ts'
import { startAutoLoop } from './auto.ts'
import { killTestRuns, sweepRunTmp, sweepTestWorktrees } from './testrun.ts'
import { killChecks } from './checker.ts'
import { sweepUiTmp } from './uitester.ts'
import { plugIn } from './loopinputs.ts'
import { realParts } from './loopparts.ts'
import { forgetChecking } from './plancheck.ts'
import { endLeftChecks, watchChecks } from './hqcheck.ts'
import { readBackCommands, startLeftoverSweeps, sweepAgentTmp, sweepNow } from './leftovers.ts'
import { checkClaude, claudeInfo, ensureClaude, startClaudeCheck } from './claudecheck.ts'
import { saveTestCmds } from './heavy.ts'
import { listeningOrStop, stopIfPortsTaken } from './ports.ts'
import { prepareSocket, socket } from './tmux.ts'

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
  await stopIfPortsTaken() // Bug 118: a port taken stops HQ here, before it touches the database, agents or leftovers
  try { prepareSocket() } catch (e) { console.error((e as Error).message); process.exit(1) } // Bug 242: never the default tmux server by mistake
  try { slotBasesNow() } catch (e) { console.error(`HQ can't start: ${(e as Error).message}`); process.exit(1) } // Bug 259: engineers' port window
  migrate(); ensureAssets()
  plugIn(realParts) // the findings loop reads the real recordings, test setup and UI tester run: before the auto loop can end a run
  forgetChecking() // a plan check under way when the backend last stopped went with it
  endLeftChecks(); watchChecks() // a ticket check under way went with the last backend too (its button says so); from now on, what ends one by itself
  saveTestCmds() // Bug 112: for commands saved before this file existed, and projects removed since it was written
  try { await ensureClaude() } catch (e) { console.error((e as Error).message); process.exit(1) } // no agent could start
  // Bug 97: which Claude Code the agents run, and whether HQ was checked on it, before the page or a launch can ask. A look that fails stops nothing
  await checkClaude().catch((e) => emit({ agentId: null, source: 'system', kind: 'claude.check_error', payload: { error: String(e) } }))
  // Every TPM workspace is a plain folder under this one, so trusting it once means TPM launches never write ~/.claude.json.
  try { await ensureTrusted(PATHS.workspaces) } catch (e) { emit({ agentId: null, source: 'system', kind: 'trust.error', payload: { error: String(e) } }) }
  await recoverAgents()
  for (const a of liveAgents()) tellIfHqWasAway(a) // Bug 85: told to wait for HQ while it was down; an idle agent sends no hook to remind HQ
  lookAtStart() // Bug 217: a dialog that ended while HQ was down sent its sign to no one
  await sweepWorktrees().catch((e) => emit({ agentId: null, source: 'system', kind: 'worktree.sweep.error', payload: { error: String(e) } }))
  for (const r of repos()) await sweepTestWorktrees(r.path).catch(() => {}) // a test run the last backend didn't finish
  try { // and its temp files (Bug 81)
    const tmps = [...sweepRunTmp(), ...sweepUiTmp()]; if (tmps.length) emit({ agentId: null, source: 'system', kind: 'testrun.tmp_swept', payload: { folders: tmps } })
  } catch { /* the next start */ }
  await recoverPreviews() // before the merge watcher: its first check can restart a preview
  await recoverHelpers(repos()).catch((e) => console.error('launch helper recovery failed', e))
  await recoverSetupHelpers(repos()).catch((e) => console.error('test setup helper recovery failed', e))
  startBgRuns() // before the first sweep and any hook: it reads back what agents wait on in the background (Bug 96)
  rebuildHelpers() // and the helpers they started in the background, after it: a helper's line comes first (Bug 232)
  rebuildTurns() // Bug 281: each agent's last turn start, prompt and Stop, so a quick Escape on a turn from before the restart still ends it
  // Bug 268: a turn that ended while HQ was down; after the helpers and runs, which keep an agent working
  lookAtTurnsAtStart().catch((e) => emit({ agentId: null, source: 'system', kind: 'turn.look_error', payload: { error: String(e) } }))
  readBackCommands() // what agents' commands are still running, so the sweep spares what they started (Bug 145)
  await sweepNow() // what agents' commands left running while HQ was down (Bug 75)
  await sweepAgentTmp() // and the temp folders of agents that ended meanwhile (Bug 81)
  resumeTries() // Bug 351: a Launch helper's first run of its OK'd steps, picked up again or started again (before resumeRestarts: it may take one)
  resumeRestarts() // an app the last backend was restarting starts again, now that the look is done (Bug 215)
  startListeners()
  await listeningOrStop({ hooks: startHooksServer(), mcp: startMcpServer(), ui: startUiServer() }) // never half-started (Bug 118)
  // Bug 296: an urgent message or a fresh start's request the last backend was typing when it went down. Once the servers listen: the prompt it
  // types starts a turn, whose hooks must reach HQ (typed before, they failed with ECONNREFUSED on the screen). In the background: an Escape waits 1.5 s
  void typeCutShort().catch((e) => emit({ agentId: null, source: 'system', kind: 'backend.error', payload: { server: 'typing', error: String(e) } }))
  startStuckLoop(); startMergeWatcher(); startRetention(); startFreshStartLoop(); startAutoLoop()
  startLeftoverSweeps()
  startClaudeCheck()
  emit({ agentId: null, source: 'system', kind: 'backend.started', payload: { ports: PORTS, claude: claudeInfo(), tmux: socket() } })
  console.log(`HQ backend up. UI: http://127.0.0.1:${PORTS.ui}/?token=${uiToken()}  hooks :${PORTS.hooks}  mcp :${PORTS.mcp}  state ${PATHS.home}`)
  console.log(`tmux socket ${socket()}`)
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
for (const [sig, code] of [['SIGTERM', 143], ['SIGHUP', 129], ['SIGINT', 130]] as const) process.once(sig, () => { killTestRuns(); killChecks(); process.exit(code) })
main().catch((e) => { console.error(e); process.exit(1) })

// Pre-accept Claude Code's workspace trust dialog for a directory (projects[dir].hasTrustDialogAccepted in ~/.claude.json).
// Live Claude sessions write that file too: under a proper-lockfile lock (a `~/.claude.json.lock` directory) and re-reading
// it under the lock (checked on 2.1.300). HQ takes the same lock and re-reads under it, so neither side drops the other's keys.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emit } from './events.ts'
import { sleep } from './util.ts'

type Projects = Record<string, Record<string, unknown>>
const cfgPath = () => path.join(os.homedir(), '.claude.json')
const STALE_MS = 10_000 // proper-lockfile's default: a live holder refreshes its lock well within this, so an older one is a dead holder's

/** Trusted as Claude Code sees it: the folder itself, or (checked on 2.1.300) a trusted folder above it, but not past a git
 *  repo's root, since a repo inside a trusted folder still asks. */
export function isTrusted(projects: Projects, dir: string): boolean {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (projects[d]?.hasTrustDialogAccepted === true) return true
    if (fs.existsSync(path.join(d, '.git')) || path.dirname(d) === d) return false
  }
}
const readProjects = (): Projects => (JSON.parse(fs.readFileSync(cfgPath(), 'utf8')).projects ?? {}) as Projects

/** Run `fn` holding Claude Code's own lock on ~/.claude.json. Waiting for the lock doesn't block the backend; `fn` itself is
 *  synchronous so the lock is held for milliseconds. Rejects if a live holder keeps it longer than `waitMs`. */
export async function withConfigLock<T>(fn: () => T, waitMs = 5000): Promise<T> {
  const lock = cfgPath() + '.lock'; const until = Date.now() + waitMs
  for (;;) {
    try { fs.mkdirSync(lock); break } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let age = 0; try { age = Date.now() - fs.statSync(lock).mtimeMs } catch { continue } // released meanwhile: try again
      if (age > STALE_MS) { try { fs.rmdirSync(lock) } catch { /* someone else took it over */ } continue }
      if (Date.now() > until) throw new Error(`~/.claude.json is locked by another Claude Code process (${lock})`)
      await sleep(50)
    }
  }
  try { return fn() } finally { try { fs.rmdirSync(lock) } catch { /* already gone */ } }
}

/** Make sure Claude Code won't show its trust dialog in `dir`. Writes ~/.claude.json only when it isn't trusted yet; throws
 *  when it can't, because an agent launched into the dialog would sit there unseen. */
export async function ensureTrusted(dir: string, waitMs = 5000): Promise<void> {
  dir = path.resolve(dir)
  try { if (isTrusted(readProjects(), dir)) return } catch (e) { throw new Error(`can't read ~/.claude.json to trust ${dir}: ${(e as Error).message}`) }
  await withConfigLock(() => {
    const file = cfgPath(); const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> // re-read under the lock
    const projects = (cfg.projects ??= {}) as Projects
    if (isTrusted(projects, dir)) return
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const backup = path.join(os.homedir(), '.claude', 'backups', `.claude.json.hq-${day}`) // one per day, not one per write
    if (!fs.existsSync(backup)) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(file, backup) }
    const entry = projects[dir]
    projects[dir] = {
      allowedTools: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false, ...(entry ?? {}), hasTrustDialogAccepted: true,
    }
    const tmp = `${file}.hq-${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: fs.statSync(file).mode & 0o777 }); fs.renameSync(tmp, file)
    emit({ agentId: null, source: 'system', kind: 'trust.granted', payload: { dir } })
  }, waitMs)
}

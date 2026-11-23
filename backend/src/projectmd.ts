// What HQ keeps written down for the project's TPM (Bug 52), in its workspace: PROJECT.md (what the project is, what has been
// built, what's on the board now, the project's decisions), CONTEXT.md (the first request), and one file per feature under
// features/ (its request, tickets, decisions and specs). HQ writes them from its records, so a new TPM session (a fresh start,
// a resume, after a Clear) knows the project without a long handoff note. "Built so far" outlives a Clear (doc repo:<id>/built).
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.ts'
import { one, q, run, now } from './db.ts'
import { bus, type Patch } from './events.ts'
import { features, getFeature, getRepo, getTicket, tickets, type Feature } from './records.ts'
import { criteriaOf, criteriaMd } from './criteria.ts'

/** The project TPM's workspace: its cwd, where PROJECT.md and features/ live. */
export const tpmWorkspace = (repoId: string): string => path.join(PATHS.workspaces, `repo-${repoId}`, 'tpm')
const featureFile = (f: Feature): string => path.join(tpmWorkspace(f.repo_id), 'features', `${f.handle ?? f.id}.md`)
/** "F-2 dark mode", or the title alone for a feature without a handle. */
export const featureName = (f: Pick<Feature, 'handle' | 'title'>): string => f.handle ? `${f.handle} ${f.title}` : f.title

/** Every ticket of the feature (at least one, not counting cancelled ones) is merged: its TPM has nothing left to coordinate. */
export const featureDone = (fid: string): boolean => { const all = tickets(fid).filter((t) => t.status !== 'cancelled'); return all.length > 0 && all.every((t) => t.status === 'merged') }
/** Where a feature stands, in its board box's words (frontend/src/board.ts featureView), not its stored status word: that stays
 *  "planning" until it's cancelled, done or not (Bug 222). FEATURE.md and the Clear archive's SUMMARY.md say this (Bug 250). */
export const featureState = (f: Feature): string => {
  const all = tickets(f.id).filter((t) => t.status !== 'cancelled'), merged = all.filter((t) => t.status === 'merged').length
  if (f.status === 'cancelled') return merged ? `cancelled · ${merged} merged before that` : 'cancelled' // not "done": nothing more goes in (Bug 250)
  return featureDone(f.id) ? `✓ done · all ${all.length} merged` : all.length ? `${merged}/${all.length} merged` : 'no tickets yet'
}
/** Writes `text` to `file` only when it differs from what's there: a rewrite that changes nothing costs no disk write (Bug 269). */
function put(file: string, text: string): void {
  try { if (fs.readFileSync(file, 'utf8') === text) return } catch { /* not there yet */ }
  fs.writeFileSync(file, text)
}
/** One feature's file: the request, its tickets, the decisions recorded with write_feature, and every ticket's spec. Also
 *  brings PROJECT.md up to date. Returns the file. */
export function writeFeatureMd(f: Feature): string {
  const tk = tickets(f.id), decisions = q<{ key: string; text: string }>('SELECT key, text FROM docs WHERE scope = ? ORDER BY updated_at', `feature:${f.id}`)
  // Bug 288: with no tickets, say so (a cancelled feature that never had any), not an empty table
  const none = f.status === 'cancelled' ? 'None: it was cancelled before it had any.' : 'None yet.'
  const md = `---\nfeature: ${f.handle ?? ''} ${f.slug}\nrepo: ${getRepo(f.repo_id)?.name}\nstatus: ${featureState(f)}\nmerge_order: ${f.merge_order}\n---\n`
    + `## Request (verbatim)\n\n${f.request_text}\n\n## Tickets\n\n`
    + (tk.length ? '| Key | Size | Status | Depends on | Expected files | Title |\n|---|---|---|---|---|---|\n'
      + `${tk.map((x) => `| ${x.key} | ${x.size} | ${x.status} | ${x.deps} | ${x.expected_files} | ${x.title} |`).join('\n')}\n` : `${none}\n`)
    + (decisions.length ? `\n## Decisions\n\n${decisions.map((d) => `### ${d.key}\n${d.text}`).join('\n\n')}\n` : '')
    + (tk.length ? `\n## Ticket specs\n\n${tk.map((x) => `### ${x.key}: ${x.title}\n${x.spec ?? ''}${criteriaNote(x)}`).join('\n\n')}\n` : '')
  const file = featureFile(f); fs.mkdirSync(path.dirname(file), { recursive: true }); put(file, md)
  writeProjectMd(f.repo_id)
  return file
}
/** What a ticket's row in FEATURE.md and PROJECT.md shows (its key never changes). */
const SHOWN = ['status', 'title', 'size', 'deps', 'expected_files', 'spec', 'criteria']
/** Bug 269: the one place a ticket's change reaches its feature's file. Every ticket update goes through setTicket (records.ts) or createTicket,
 *  and both send a `ticket` patch, so a change to anything the file shows (an engineer starting, a plan approved, a PR opened, a merge, a cancel)
 *  rewrites it, and only then: the patches that come with hooks (go_ahead, handoff times, proof) don't, and put() skips a rewrite that changes nothing. */
bus.on('patch', (p: Patch) => {
  if (p.entity !== 'ticket' || !p.patch || !SHOWN.some((k) => k in p.patch!)) return
  const t = getTicket(p.id), f = t && getFeature(t.feature_id); if (!f || !getRepo(f.repo_id)) return // gone, or removed from HQ: no folder to bring back
  try { writeFeatureMd(f) } catch (e) { console.error(`[projectmd] ${f.handle ?? f.id}.md not rewritten: ${(e as Error).message}`) } // a ticket's update still goes through
})
const criteriaNote = (t: { criteria: string }): string => criteriaMd(criteriaOf(t))
/** Removes a feature's file (its feature was cleared off the board). */
export function dropFeatureMd(f: Feature): void { fs.rmSync(featureFile(f), { force: true }) }

/** Merged work of these features, one line each: what "Built so far" lists (and keeps after a Clear). */
export function builtLines(fs0: Feature[]): string[] {
  return fs0.flatMap((f) => {
    const done = tickets(f.id).filter((t) => t.status === 'merged'); if (!done.length) return []
    return [`- ${featureName(f)}: ${done.map((t) => `${t.key} ${t.title}`).join('; ')}`]
  })
}
/** Work that left the board in a Clear, kept for "Built so far". */
export const keptBuilt = (repoId: string): string => one<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key = 'built'", `repo:${repoId}`)?.text ?? ''
export function keepBuilt(repoId: string, lines: string[]): void {
  if (!lines.length) return
  const text = [keptBuilt(repoId).trimEnd(), ...lines].filter(Boolean).join('\n')
  run("INSERT INTO docs(scope, key, text, updated_at) VALUES (?, 'built', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at", `repo:${repoId}`, text, now())
}

/** PROJECT.md (and CONTEXT.md) in the TPM's workspace, from HQ's records. Returns the workspace. */
export function writeProjectMd(repoId: string): string {
  const ws = tpmWorkspace(repoId), repo = getRepo(repoId); if (!repo) return ws // removed from HQ: no folder to bring back
  fs.mkdirSync(ws, { recursive: true })
  const mine = features().filter((f) => f.repo_id === repoId && f.status !== 'cancelled').reverse() // oldest first
  const open = mine.filter((f) => { const tk = tickets(f.id).filter((t) => t.status !== 'cancelled'); return !tk.length || tk.some((t) => t.status !== 'merged') })
  const built = [keptBuilt(repoId).trimEnd(), ...builtLines(mine)].filter(Boolean).join('\n')
  const decisions = q<{ key: string; text: string }>("SELECT key, text FROM docs WHERE scope = ? AND key != 'built' ORDER BY updated_at", `repo:${repoId}`)
  const ctx = repo.context_doc_path && fs.existsSync(repo.context_doc_path) ? fs.readFileSync(repo.context_doc_path, 'utf8') : null
  if (ctx) put(path.join(ws, 'CONTEXT.md'), ctx)
  const board = open.map((f) => {
    const tk = tickets(f.id).filter((t) => t.status !== 'cancelled')
    return `### ${featureName(f)} (features/${f.handle ?? f.id}.md)\n\n${f.request_text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`
      + (tk.length ? tk.map((t) => `- ${t.key} (${t.size}) ${t.title}: ${t.status}`).join('\n') : '- no tickets yet')
  }).join('\n\n')
  const md = `# ${repo.name}: project notes (kept by HQ)\n\nHQ rewrites this file whenever the board changes; don't edit it. Your own notes go in `
    + `write_feature (decisions) and, when HQ asks, write_handoff_note.\n\n`
    + `## What this project is\n\n${ctx ? 'See CONTEXT.md: what the user asked for when the project started.' : 'No first request on record.'}`
    + ' FEATURE-MAP.md, once there is one, says what is on each screen of the app, in a user\'s words: write screen criteria in those words.\n\n'
    + `## Built so far\n\n${built || 'Nothing merged yet.'}\n\n## On the board now\n\n${board || 'Nothing: every feature is merged or the board is empty.'}\n`
    + (decisions.length ? `\n## Project decisions\n\n${decisions.map((d) => `### ${d.key}\n${d.text}`).join('\n\n')}\n` : '')
  put(path.join(ws, 'PROJECT.md'), md)
  return ws
}
/** Every feature file of the project and PROJECT.md, from HQ's records: a new TPM session reads them, so a file written before an
 *  HQ that kept them up to date (Bug 269) is brought up to date first. Returns the workspace. */
export function writeRepoMd(repoId: string): string {
  for (const f of features().filter((x) => x.repo_id === repoId)) writeFeatureMd(f)
  return writeProjectMd(repoId)
}
/** The feature a ticket's or feature's update belongs to, rewritten (its file and PROJECT.md). */
export function rewriteFor(featureId: string): void { const f = getFeature(featureId); if (f) writeFeatureMd(f) }

// Where HQ keeps each project's feature map (featuremap.ts): in its own records, never in the user's repo, so it can't conflict with a merge, and copied to
// FEATURE-MAP.md in the TPM's workspace for the TPM to read. An engineer's change waits with its ticket and goes into the map when the ticket merges,
// whoever merges it (mergewatch.ts markMerged). The map stays through a Clear (the app is still what it was) and goes with Remove.
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS } from './config.ts'
import { criteriaOf } from './criteria.ts'
import { getSetting, one, run, now } from './db.ts'
import { patch } from './events.ts'
import { applyChange, applyEdits, changeWords, mapProblem, mapText, parseMap, type Change, type Edit, type Screen } from './featuremap.ts'
import { tpmWorkspace } from './projectmd.ts'
import { getRepo, tickets, features, type Ticket } from './records.ts'

const scope = (repoId: string): string => `map:${repoId}`
const doc = (s: string, key: string): string | null => one<{ text: string }>('SELECT text FROM docs WHERE scope = ? AND key = ?', s, key)?.text ?? null
const putDoc = (s: string, key: string, text: string): void => {
  run('INSERT INTO docs(scope, key, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at', s, key, text, now())
}
/** Who wrote the map last and when: a ticket's merge, the first-map session, or an undo. */
export type MapBy = { at: number; by: string }
/** The project's feature map as text; '' while it has none. Part 4's tester reads it through this. */
export const currentMap = (repoId: string): string => doc(scope(repoId), 'current') ?? ''
/** The map's screens. A map HQ kept is always one parseMap takes; anything else reads as none. */
export const mapOf = (repoId: string): Screen[] => { const p = parseMap(currentMap(repoId)); return 'map' in p ? p.map : [] }
const byOf = (repoId: string): MapBy | null => { try { return JSON.parse(doc(scope(repoId), 'by') ?? 'null') as MapBy | null } catch { return null } }

/** Saves the map, copies it to the TPM's workspace, and tells the page. `by`: who changed it, in a few words. */
export function saveMap(repoId: string, map: Screen[], by: string): void {
  putDoc(scope(repoId), 'current', mapText(map)); putDoc(scope(repoId), 'by', JSON.stringify({ at: now(), by } satisfies MapBy))
  writeMapMd(repoId); showMap(repoId)
}
/** FEATURE-MAP.md for the TPM: what the app's screens have on them, in the words its screen criteria should use. */
export function writeMapMd(repoId: string): void {
  if (!getRepo(repoId)) return
  const ws = tpmWorkspace(repoId), text = currentMap(repoId); fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'FEATURE-MAP.md'), `# Feature map (kept by HQ)\n\nWhat is on each screen of the app and what each control does, in a user's words. `
    + 'Engineers change it as they finish tickets; HQ applies each change when its ticket merges. Don\'t edit this file. Write screen criteria in these words.\n\n'
    + (text || 'No map yet.\n'))
}

/** A ticket's map change, waiting for its merge. `unchanged`: its engineer said nothing a user sees changed. `applied_at`: in the map since its merge;
 *  `before`: the map as it was just before, for an undo. */
export type Pending = { change: Change; unchanged?: boolean; at: number; applied_at?: number; before?: string }
export function pendingMapChange(ticketId: string): Pending | null {
  const edit = (e: Edit): boolean => !!e && typeof e.screen === 'string' && Array.isArray(e.add) && Array.isArray(e.remove) // anything else is no edit of HQ's
  try { const p = JSON.parse(doc(`ticket:${ticketId}`, 'feature_map') ?? 'null') as Pending | null; return p && Array.isArray(p.change) ? { ...p, change: p.change.filter(edit) } : null }
  catch { return null }
}
const putPending = (t: Pick<Ticket, 'id'>, p: Pending): void => putDoc(`ticket:${t.id}`, 'feature_map', JSON.stringify(p))

/** Does finishing this ticket need a word about the map (a change, or "nothing a user sees changed")? A ticket with screen criteria does, unless HQ opened
 *  it itself (to repair main's tests) or testing is turned off (the map is for the tester, and nothing reads it then). */
export const mapWanted = (t: Ticket): boolean => getSetting('tester', DEFAULTS.tester) !== 'off' && !t.repairs_main && criteriaOf(t).some((c) => c.kind === 'ui')
/** The map as an engineer reads it in get_ticket: the map, and its own change so far. '' for a ticket the map doesn't concern. */
export function mapForEngineer(t: Ticket, repoId: string): string {
  if (!mapWanted(t)) return ''
  const p = pendingMapChange(t.id), cur = currentMap(repoId)
  const next = p?.change.length ? applyEdits(mapOf(repoId), p.change) : null
  const mine = next && 'map' in next ? `\n\nWith your change so far (${changeWords(p!.change)}), which goes in when ${t.key} merges, it will read:\n\n${mapText(next.map)}`
    : p?.unchanged ? '\n\nYou said nothing a user sees changes.' : ''
  return `\n## Feature map\nWhat a user finds on each screen, in a user's words: the tester's only picture of the app. As you finish, call update_feature_map with `
    + 'the lines to add and to remove on each screen you changed, or call open_pr with feature_map_unchanged: true if nothing a user sees changed. The map now:\n\n'
    + `${cur || '(No map yet: the screens you add start it.)\n'}${mine}\n`
}
/** update_feature_map: the edits go with the ticket, after any it gave before, checked against the map as it is now with all of them in. The map as it will
 *  be once the ticket merges, or what's wrong (nothing kept then). */
export function recordChange(t: Ticket, repoId: string, edits: Edit[]): { map: string } | { error: string } {
  const cur = mapOf(repoId), prev = pendingMapChange(t.id)
  if (prev?.applied_at) return { error: `${t.key} has merged: its change is in the map already.` }
  const before = applyEdits(cur, prev?.change ?? []), next = applyEdits('map' in before ? before.map : cur, edits, true); if ('error' in next) return next
  const bad = mapProblem(next.map, mapText(cur).length); if (bad) return { error: bad }
  putPending(t, { change: [...(prev?.change ?? []), ...edits], at: now() }); showMap(repoId)
  return { map: mapText(next.map) }
}
/** open_pr's feature_map_unchanged: nothing a user sees changed. A change it gave earlier stays (it would only be said by mistake then). */
export function markUnchanged(t: Ticket, repoId: string): void {
  const prev = pendingMapChange(t.id); if (prev?.change.length || prev?.applied_at) return
  putPending(t, { change: [], unchanged: true, at: now() }); showMap(repoId)
}
/** A ticket merged: its change goes into the map. Once: the watcher and Merge can both see the same merge. A map this makes longer than the cap is kept
 *  (the engineer has gone; nobody could shorten it now), and the next change to it has to shorten it. */
export function applyMapOnMerge(t: Ticket, repoId: string): void {
  const p = pendingMapChange(t.id); if (!p || p.applied_at || !p.change.length) return
  const before = currentMap(repoId), next = applyChange(mapOf(repoId), p.change)
  putPending(t, { ...p, applied_at: now(), before })
  saveMap(repoId, next, `${t.key} merged (${changeWords(p.change)})`)
}
/** An auto run was undone (auto.ts undoRun): its tickets' work left main, so their map changes leave the map. The map goes back to what it was before the
 *  first of them changed it; a map nobody's merge changed is left alone. */
export function undoMapChanges(repoId: string, ts: Ticket[]): void {
  const applied = ts.map((t) => pendingMapChange(t.id)).filter((p): p is Pending & { applied_at: number; before: string } => !!p?.applied_at && p.before !== undefined)
  if (!applied.length) return
  const first = applied.sort((a, b) => a.applied_at - b.applied_at)[0]!, p = parseMap(first.before)
  saveMap(repoId, 'map' in p ? p.map : [], 'the auto run that changed it was undone')
}

/** The page's view of a project's map: the text, who wrote it last, each change waiting on an unmerged ticket, and the first-map session's state. */
export type MapView = { id: string; text: string; by: MapBy | null; pending: { ticket: string; key: string; screens: string; unchanged: boolean }[]; first: FirstView | null }
/** The first-map session (firstmap.ts): running since when, or how its last try ended. */
export type FirstView = { running: true; since: number } | { running: false; at: number; ok: boolean; why: string | null }
let firstOf: (repoId: string) => FirstView | null = () => null
/** firstmap.ts says how its session is doing (it imports this module, so it registers itself rather than being imported here). */
export const firstMapState = (fn: (repoId: string) => FirstView | null): void => { firstOf = fn }
export function mapView(repoId: string): MapView {
  const fids = new Set(features().filter((f) => f.repo_id === repoId).map((f) => f.id))
  const pending = tickets().filter((t) => fids.has(t.feature_id) && t.status !== 'merged' && t.status !== 'cancelled').flatMap((t) => {
    const p = pendingMapChange(t.id); return p && !p.applied_at && (p.change.length || p.unchanged) ? [{ ticket: t.id, key: t.key, screens: changeWords(p.change), unchanged: !!p.unchanged }] : []
  })
  return { id: repoId, text: currentMap(repoId), by: byOf(repoId), pending, first: firstOf(repoId) }
}
export const showMap = (repoId: string): void => patch('map', repoId, { ...mapView(repoId) })
/** Every project's map view, for the page's snapshot. */
export const mapViews = (repoIds: string[]): MapView[] => repoIds.map(mapView)
/** Remove from HQ: the map goes with the project (Clear keeps it). */
export function dropMap(repoId: string): void { run('DELETE FROM docs WHERE scope = ?', scope(repoId)) }

// The first feature map of a project that has none yet (an app built before HQ kept maps): a one-time session clicks through the running app and writes it.
// Code-blind and locked down like the tester (tester.ts): one headless Claude Code call whose only tools are HQ's browser tools (testermcp.mjs, mode 'map'),
// which run inside HQ's test sandbox in a throwaway checkout of main, with localhost only and none of the user's credentials. The map is checked with HQ's
// rules (featuremap.ts) by the tools themselves, so a refused one goes back to the agent while it can still look. The user starts it (the Map dialog);
// a new project needs none, since its map grows with each merge.
import fs from 'node:fs'
import path from 'node:path'
import { attention, openAttention, resolveAttention } from './attention.ts'
import { PATHS } from './config.ts'
import { call, PLAIN } from './checker.ts'
import { mergeBase } from './conflicts.ts'
import { one, run, now } from './db.ts'
import { emit } from './events.ts'
import { mapProblem, mapText, parseMap, type Screen } from './featuremap.ts'
import { firstMapState, mapOf, saveMap, showMap, type FirstView } from './mapstore.ts'
import { row as previewRow, runnableRecipe } from './preview.ts'
import { getRepo, notClearing } from './records.ts'
import { git } from './repos.ts'
import { lookHow, prepareApp, type LookPlan } from './smoke.ts'
import { serverCommand, testerModel } from './tester.ts'
import { inCheckout, ownTmp, runSandboxed } from './testrun.ts'

const RULES = path.join(import.meta.dirname, 'featuremap.ts')
/** Actions the session gets (each open, click or type), how much of a page it reads at once, and how long it may take in all. */
export const MAP_ACTIONS = Number(process.env.HQ_MAP_ACTIONS) || 40
const PAGE_MAX = 6000, TIMEOUT_MS = (Number(process.env.HQ_MAP_TIMEOUT_S) || 900) * 1000
const TOOLS = ['open', 'click', 'type', 'write_map'].map((t) => `mcp__browse__${t}`).join(',')

export const MAPPER_SYSTEM = `You write the feature map of a web app: a short map, in a user's words, of what is on each screen and what each control does. It is
the only picture of the app a tester will have. You can't see the app's code; you see the app only through the browse tools (open a page, click, type), each
of which answers with the page as text.

How:
- Start at "/". Visit every screen once: each tab, each page a menu or link reaches, each dialog a main button opens. Don't try every item in a list.
- Find out what a control does from its label and, where that isn't clear, by trying it once. Don't delete things or fill in long forms.
- You have a fixed number of actions (each open, click or type is one). Spend them on screens you haven't seen.

Write the map in markdown, nothing else in it:
## Reading (tab)
- "Add item" box + Add: puts an item on the list
- ✓ next to an item: marks it read (stays on the list, crossed out)
- "Fill from wishlist": adds the missing books from the wishlist

Rules for the map:
- One "## " heading per screen, saying what kind it is: (tab), (page), (dialog). Then one "- " line per control or group of controls: what it is, then what it does.
- A user's words only: labels as the screen shows them, in quotes. No file names, web addresses, code words or how it's built.
- Say what each control is for, never whether it worked: the map is a picture of the app, not a test of it. Finding problems is someone else's job.
- Short: under 5000 characters in all. Group small controls ("✎ and 🗑 on each row: edit or remove it").

When you have seen every screen, or have a few actions left, call write_map once with the map. If HQ says what to fix, fix it and call write_map again.
Then stop.`
const mapperPrompt = (cap: number, today: string): string => `Write the feature map of this app. Its start page is "/". You have ${cap} actions. Today is ${today}.\n`

/** Sessions running now, by project: in memory, like the run itself (a backend that stops takes the session with it). */
const running = new Map<string, { ctrl: AbortController; since: number }>()
const lastDoc = (repoId: string): FirstView | null => {
  try { return JSON.parse(one<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key = 'first_try'", `map:${repoId}`)?.text ?? 'null') as FirstView | null } catch { return null }
}
firstMapState((repoId) => { const r = running.get(repoId); return r ? { running: true, since: r.since } : lastDoc(repoId) })
function ended(repoId: string, ok: boolean, why: string | null): void {
  const v: FirstView = { running: false, at: now(), ok, why }
  run("INSERT INTO docs(scope, key, text, updated_at) VALUES (?, 'first_try', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
    `map:${repoId}`, JSON.stringify(v), now())
}

/** What HQ starts the app with for the session: the steps the preview runs (the user's own command, or the ones they OK'd), or why there are none. */
function plan(repoId: string): LookPlan | string {
  const repo = getRepo(repoId)!, recipe = runnableRecipe(previewRow(repoId), repo.path)
  return recipe ? { recipe, repoPath: repo.path, how: lookHow(recipe) } : 'HQ has no start steps for this app yet: press Launch app once, then try again.'
}
/** Starts the session for a project with no map. Refused, with why, when it has one, a session is running, HQ can't start the app, or the project is being
 *  cleared or removed (Bug 333: the session starts the app the Clear stopped). */
export function startFirstMap(repoId: string): { started: true } {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown project')
  notClearing(repoId)
  if (mapOf(repoId).length) throw new Error('This project has a feature map already; engineers keep it up to date as their tickets merge.')
  if (running.has(repoId)) throw new Error('HQ is already writing this project\'s first map.')
  const p = plan(repoId); if (typeof p === 'string') throw new Error(p)
  const ctrl = new AbortController(); running.set(repoId, { ctrl, since: now() }); showMap(repoId)
  for (const a of openAttention().filter((x) => x.kind === `map_failed:${repoId}`)) resolveAttention(a.id) // the last try's alert: this one answers it
  emit({ agentId: null, source: 'ui', kind: 'map.first_started', payload: { repo: repoId } })
  void writeFirst(repoId, p, ctrl.signal).then((r) => {
    if (r === 'stopped') return
    ended(repoId, r.ok, r.ok ? null : r.why)
    emit({ agentId: null, source: 'system', kind: 'map.first_ended', payload: { repo: repoId, ok: r.ok, why: r.ok ? null : r.why, ...(r.ok ? { chars: r.chars, ms: r.ms, tokens: r.tokens } : {}) } })
    if (!r.ok) attention(`map_failed:${repoId}`, `HQ couldn't write ${getRepo(repoId)?.name ?? 'the project'}'s feature map: ${r.why}. Try again from the Map button.`, {})
  }).catch((e) => ended(repoId, false, `HQ hit an error (${(e as Error).message.split('\n')[0]})`))
    .finally(() => { if (running.get(repoId)?.ctrl === ctrl) running.delete(repoId); if (getRepo(repoId)) showMap(repoId) })
  return { started: true }
}
/** Remove or Clear: a session running for the project ends now, keeping nothing. */
export function stopFirstMap(repoId: string): void { running.get(repoId)?.ctrl.abort() }

type Out = { started: boolean | null; why: string | null; actions: { tool: string; ok: boolean }[]; report: { map?: string } | null; refused?: number }
type Wrote = { ok: true; chars: number; ms: number; tokens: number } | { ok: false; why: string } | 'stopped'
async function writeFirst(repoId: string, p: LookPlan, stop: AbortSignal): Promise<Wrote> {
  const repo = getRepo(repoId)!, sha = await git(repo.path, 'rev-parse', '--verify', '--quiet', `${mergeBase(repo).ref}^{commit}`).catch(() => '')
  if (!sha) return { ok: false, why: `HQ couldn't find ${repo.default_branch} in the project` }
  const r = await inCheckout(repo.path, sha, 'map', null, { repoId, ticketId: null, what: 'map' }, async (wt, signal0): Promise<Wrote> => {
    const signal = AbortSignal.any([signal0, stop])
    const cant = await prepareApp(wt, p, { signal, run: runSandboxed })
    if (cant?.kind === 'stopped' || signal.aborted) return 'stopped'
    if (cant) return { ok: false, why: cant.kind === 'no_start' ? `the app couldn't be started (${cant.why})` : cant.why }
    const out = path.join(wt, '.hq-tester.json'), own = ownTmp()
    try {
      const more = { mode: 'map', rules: RULES, cap: MAP_ACTIONS, pageMax: PAGE_MAX }
      const servers = { mcpServers: { browse: { type: 'stdio', ...serverCommand(wt, p, out, own.tmp, more) } } }
      const c = await call({ args: ['--model', testerModel(), '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify(servers), '--allowedTools', TOOLS, ...PLAIN,
        '--system-prompt', MAPPER_SYSTEM], prompt: mapperPrompt(MAP_ACTIONS, new Date().toISOString().slice(0, 10)), signal, timeoutMs: TIMEOUT_MS, env: { HQ_TESTER_OUT: out } })
      if (c.kind === 'stopped' || stop.aborted) return 'stopped'
      let seen: Out | null = null; try { seen = JSON.parse(fs.readFileSync(out, 'utf8')) as Out } catch { /* the server never wrote one */ }
      keep(repoId, seen, c)
      if (seen?.started === false) return { ok: false, why: seen.why ?? 'the app couldn\'t be started' }
      const text = seen?.report?.map
      const none = seen ? `the session ended without a map it could save${seen.refused ? ` (HQ refused ${seen.refused})` : ''}` : 'its browser tools never started'
      if (!text) return { ok: false, why: c.kind === 'error' ? `the session couldn't be asked (${c.why})` : none }
      const map = taken(text); if (typeof map === 'string') return { ok: false, why: map }
      if (!getRepo(repoId)) return 'stopped' // removed meanwhile
      const now0 = mapOf(repoId) // a ticket that merged meanwhile may have started one: its screens stay as it wrote them
      saveMap(repoId, [...now0, ...map.filter((s) => !now0.some((x) => x.screen.toLowerCase() === s.screen.toLowerCase()))], 'HQ\'s first-map session')
      return { ok: true, chars: mapText(map).length, ms: c.kind === 'result' ? c.ms : 0, tokens: c.kind === 'result' ? c.tokens : 0 }
    } finally { await own.done() }
  })
  return r
}
/** What the session did, step by step, in HQ's own folder for the project (never in the user's repo): for a look when its map is wrong or it failed. */
function keep(repoId: string, seen: Out | null, c: Awaited<ReturnType<typeof call>>): void {
  try {
    const dir = path.join(PATHS.projects, repoId); fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'first-map.json'), JSON.stringify({ at: Date.now(), call: c.kind === 'result' ? { ms: c.ms, tokens: c.tokens } : c, ...seen }, null, 1))
  } catch { /* a record only */ }
}
/** The session's map as HQ keeps it, checked again here (the tools checked it, but what they wrote is a file in a checkout), or why not. */
function taken(text: string): Screen[] | string {
  const p = parseMap(text); if ('error' in p) return `its map couldn't be read (${p.error})`
  if (!p.map.length) return 'its map had no screens'
  const bad = mapProblem(p.map); return bad ? `its map was refused (${bad})` : p.map
}

// The feature map: a short "button map" of the project's app, in a user's words: each screen, what's on it, what each control does. It is the tester's only
// picture of the app (it never sees code), so it says nothing a user wouldn't: no file names, paths or code terms, and it stays short. Engineers change it a
// screen at a time with update_feature_map as they finish a ticket that changes what the user sees; HQ applies the change when the ticket merges (mapstore.ts).
// Pure: no DB, no files. The first-map session's browser tools (testermcp.mjs) import it by path to check a map before they take it, so it imports nothing.
//
//   ## Reading (tab)
//   - "Add item" box + Add: puts an item on the list
//   - ✓ next to an item: marks it read (stays on the list, crossed out)

/** One screen: its heading (without "## ") and its lines (without "- "). */
export type Screen = { screen: string; lines: string[] }
/** The most a map may be, in characters as HQ writes it. A change that would make it longer is refused (one that shortens an over-long map is taken). */
export const MAP_CAP = 5000
const SCREEN_MAX = 60, LINE_MAX = 200

/** The map as text, as HQ keeps it and shows it. '' for none. */
export const mapText = (map: Screen[]): string => map.map((s) => `## ${s.screen}\n${s.lines.map((l) => `- ${l}`).join('\n')}`).join('\n\n') + (map.length ? '\n' : '')
const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim()
const same = (a: string, b: string): boolean => tidy(a).toLowerCase() === tidy(b).toLowerCase()

/** A map written as text (the first-map session's, or one kept by HQ): its screens, or what's wrong with its layout. Blank lines don't count; "* " is taken
 *  for "- ". */
export function parseMap(text: string): { map: Screen[] } | { error: string } {
  const map: Screen[] = []
  for (const [i, raw] of text.replace(/\r/g, '').split('\n').entries()) {
    const l = raw.trim(); if (!l) continue
    const head = /^##\s+(.+)$/.exec(l); if (head) { map.push({ screen: tidy(head[1]!), lines: [] }); continue }
    const item = /^[-*]\s+(.+)$/.exec(l)
    if (!item) return { error: `Line ${i + 1} ("${l.slice(0, 60)}") is neither a screen ("## Reading (tab)") nor a line about one ("- ✓ next to an item: marks it read").` }
    if (!map.length) return { error: `Line ${i + 1} comes before any screen: start with a "## " line naming the screen.` }
    map.at(-1)!.lines.push(tidy(item[1]!))
  }
  return { map }
}

// Words that belong to the code, not to the app as a user sees it. Text in quotes is a label on the screen ("Export JSON"), so code terms there are fine;
// file names and paths are refused even there.
const EXT = 'js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|html?|css|scss|sass|less|json|ya?ml|toml|ini|env|sql|sqlite|db|md|sh|vue|svelte|lock|xml'
const FILE = new RegExp(`(?:^|[^\\w.])([\\w-]+(?:\\.[\\w-]+)*\\.(?:${EXT}))(?![\\w.])`, 'gi')
const CODE_DIRS = new Set(['src', 'lib', 'app', 'apps', 'components', 'backend', 'frontend', 'server', 'api', 'test', 'tests', 'node_modules', 'public', 'dist', 'build',
  'scripts', 'data', 'config', 'static', 'assets', 'routes', 'pages', 'utils', 'models', 'views', 'controllers', 'handlers', 'migrations'])
const WORDS = ['api', 'apis', 'endpoint', 'endpoints', 'json', 'localstorage', 'sessionstorage', 'onclick', 'onchange', 'onsubmit', 'onload', 'usestate', 'useeffect',
  'props', 'div', 'span', 'css', 'html', 'dom', 'sql', 'database', 'db', 'schema', 'regex', 'callback', 'handler', 'http', 'https', 'localhost', 'npm', 'backend',
  'frontend', 'server', 'component', 'components', 'middleware', 'payload', 'null', 'undefined', 'boolean', 'async', 'await', 'const', 'fetch', 'xhr', 'ajax',
  'websocket', 'stdout', 'uuid', 'querystring']
const WORD = new RegExp(`\\b(${WORDS.join('|')})\\b`, 'gi')
const SHAPES: [RegExp, string][] = [
  [/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, ''], // addItem, onClick
  [/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, ''], // ReadingList
  [/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, ''], // add_item
  [/\b[\w.]+\(\)/g, ''], // save()
  [/\b\w+\.\w+\(/g, ''], // list.push(
  [/`[^`]*`?/g, ''], // anything in backticks
  [/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/gi, ''], // <button>
  [/=>|===|!==|&&|\|\||[{}]/g, ''],
  [/\b(?:GET|POST|PUT|PATCH|DELETE)\b/g, ''],
  [/\bhttps?:\/\/\S+/gi, ''],
]
/** Strips the labels in quotes ("Add item", “Fill from wishlist”), which say what the screen shows, whatever it shows. */
const unquoted = (s: string): string => s.replace(/"[^"]*"|“[^”]*”|'[^'\s][^']*[^'\s]'(?!\w)/g, ' ')
/** A token with a slash in it that reads as a path, not as "on/off" or "12/05": one that starts with ./ ../ ~/ or a drive, a /path of two parts or more
 *  (one part, "/authors", is the address a user sees), or one with a folder code lives in. */
function pathLike(tok: string): boolean {
  const t = tok.replace(/^[("'“‘[]+|[)"'”’\].,;:!?]+$/g, '')
  if (/^(\.{1,2}|~)\//.test(t) || /^[A-Za-z]:\\/.test(t) || /\\\w/.test(t)) return true
  if (!t.includes('/')) return false
  const parts = t.split('/').filter(Boolean); if (!parts.length) return false
  if (t.startsWith('/') && parts.length >= 2) return true
  return parts.slice(0, -1).some((p) => CODE_DIRS.has(p.toLowerCase())) || (parts.length >= 2 && CODE_DIRS.has(parts[0]!.toLowerCase()))
}
/** What in this text belongs to the code rather than to the screen: file names, paths, and code terms (outside quoted labels). Each at most once, in the order
 *  found. Empty when it reads as a user would say it. Part 1's criteria check can use it too. */
export function codeTerms(text: string): string[] {
  const out: string[] = [], add = (s: string) => { const t = s.trim(); if (t && !out.includes(t)) out.push(t) }
  for (const m of text.matchAll(FILE)) add(m[1]!)
  for (const tok of text.split(/\s+/)) if (pathLike(tok)) add(tok.replace(/^[("'“‘[]+|[)"'”’\].,;:!?]+$/g, ''))
  const bare = unquoted(text)
  for (const m of bare.matchAll(WORD)) add(m[1]!)
  for (const [re] of SHAPES) for (const m of bare.matchAll(re)) add(m[0])
  return out.filter((t) => !out.some((o) => o.length > t.length && o.toLowerCase().includes(t.toLowerCase()))) // "books.json" inside "data/books.json": once
}
const quote = (xs: string[]): string => xs.slice(0, 5).map((x) => `"${x.slice(0, 40)}"`).join(', ') + (xs.length > 5 ? ` and ${xs.length - 5} more` : '')
const WHY_WORDS = 'The map is the tester\'s only picture of the app, in a user\'s words: what is on each screen and what each control does. Say it the way a user '
  + 'would ("the Add button puts the item on the list"), with no file names, paths or code terms. A label shown on the screen goes in quotes.'

/** What's wrong with one screen's lines, in words the writer can act on, or null. `where`: the screen, for the message. */
function screenProblem(s: Screen): string | null {
  if (!s.screen) return 'A screen needs a name ("Reading (tab)").'
  if (s.screen.length > SCREEN_MAX) return `Keep a screen's name under ${SCREEN_MAX} characters: "${s.screen.slice(0, 70)}…".`
  const long = s.lines.find((l) => l.length > LINE_MAX); if (long) return `${s.screen}: keep each line under ${LINE_MAX} characters, one control or one thing it does: "${long.slice(0, 70)}…".`
  const bad = codeTerms([s.screen, ...s.lines].join('\n')); if (bad.length) return `${s.screen}: ${quote(bad)} ${bad.length === 1 ? 'is' : 'are'} code, not what a user sees. ${WHY_WORDS}`
  return null
}
/** What's wrong with a whole map, or null. `before`: the map it replaces, in characters: a map over the cap is refused unless it is shorter than that. */
export function mapProblem(map: Screen[], before = 0): string | null {
  const names = new Set<string>()
  for (const s of map) {
    const p = screenProblem(s); if (p) return p
    const k = s.screen.toLowerCase(); if (names.has(k)) return `Two screens are called "${s.screen}": put what is on that screen under one heading.`; names.add(k)
  }
  const n = mapText(map).length
  if (n > MAP_CAP && n >= before) return `That makes the map ${n} characters, over HQ's limit of ${MAP_CAP}. Condense: one line per control, say what it does in a few words, `
    + 'and leave out what a user can see at a glance. Then try again.'
  return null
}

/** One edit to one screen, as update_feature_map takes it: lines to add (at the end of the screen, or a new screen), lines to take out (as the map has them),
 *  or the whole screen gone. A changed line is one out and one in. Edits, not a screen's whole new list: a real engineer gave only its new lines as a
 *  screen's "whole list" (2026-11-17), which would have wiped the rest of the screen at the merge. Edits also land as they are when another ticket changed
 *  the same screen meanwhile. */
export type Edit = { screen: string; add: string[]; remove: string[]; gone: boolean }
/** A ticket's change, waiting for its merge: its edits, in the order it gave them. */
export type Change = Edit[]
const lineOf = (l: unknown): string => tidy(String(l ?? '').replace(/^\s*[-*]\s+/, ''))
/** What update_feature_map gives, as HQ keeps it, or what's wrong with its shape or its words. */
export function readChange(input: unknown): { edits: Edit[] } | { error: string } {
  const how = 'Give each screen you changed as { screen, add, remove }: add the new lines, remove the lines it no longer has (copied from the map), '
    + 'and gone: true for a screen that is gone. A changed line is one remove and one add.'
  if (!Array.isArray(input) || !input.length) return { error: how }
  const out: Edit[] = []
  for (const [i, raw] of input.entries()) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const screen = tidy(String(r.screen ?? '').replace(/^#+\s*/, ''))
    if (!screen) return { error: `Screen ${i + 1} has no name.` }
    const list = (k: 'add' | 'remove'): string[] | null => r[k] === undefined ? [] : Array.isArray(r[k]) ? (r[k] as unknown[]).map(lineOf).filter(Boolean) : null
    const add = list('add'), remove = list('remove'), gone = r.gone === true || r.gone === 'true'
    if (!add || !remove) return { error: `${screen}: add and remove are lists of lines. ${how}` }
    if (!gone && !add.length && !remove.length) return { error: `${screen}: nothing to add or remove. ${how}` }
    if (gone && add.length) return { error: `${screen}: a screen that is gone has nothing to add.` }
    const p = screenProblem({ screen, lines: add }); if (p) return { error: p }
    out.push({ screen, add, remove, gone })
  }
  return { edits: out }
}
/** The map with these edits in it, in order, or (`strict`) the first edit that doesn't fit the map: a line to remove that isn't there, or a gone screen
 *  that isn't. At a merge it is never strict: what another ticket already took out stays out, and a line already there isn't added twice. */
export function applyEdits(map: Screen[], edits: Change, strict = false): { map: Screen[] } | { error: string } {
  const out = map.map((s) => ({ screen: s.screen, lines: [...s.lines] }))
  for (const e of edits) {
    const i = out.findIndex((s) => same(s.screen, e.screen)), cur = i >= 0 ? out[i]! : null
    if (e.gone) { if (cur) out.splice(i, 1); else if (strict) return { error: `There's no screen "${e.screen}" on the map to take out.${screens(out)}` }; continue }
    if (strict && e.remove.length) {
      const missing = e.remove.filter((l) => !cur?.lines.some((x) => same(x, l)))
      const has = cur && missing.length ? `${cur.screen} has no line "${missing[0]!.slice(0, 120)}". Copy the lines to remove from the map exactly. It has:\n`
        + cur.lines.map((l) => `- ${l}`).join('\n') : ''
      if (missing.length) return { error: has || `There's no screen "${e.screen}" on the map, so nothing to remove from it.${screens(out)}` }
    }
    const lines = (cur?.lines ?? []).filter((l) => !e.remove.some((x) => same(x, l)))
    for (const a of e.add) if (!lines.some((l) => same(l, a))) lines.push(a)
    if (cur) { if (lines.length) out[i] = { screen: cur.screen, lines }; else out.splice(i, 1) } // its heading as the map has it
    else if (lines.length) out.push({ screen: e.screen, lines })
  }
  return { map: out }
}
const screens = (m: Screen[]): string => m.length ? ` The map's screens: ${m.map((s) => `"${s.screen}"`).join(', ')}.` : ' The map has no screens yet.'
/** The map with a ticket's change in it, at its merge. */
export const applyChange = (map: Screen[], change: Change): Screen[] => (applyEdits(map, change) as { map: Screen[] }).map
/** The screens a change touches, for a line in a summary: "Reading (tab), Authors (tab, gone)". */
export const changeWords = (c: Change): string => [...new Map(c.map((e) => [e.screen.toLowerCase(), e.gone ? `${e.screen} (gone)` : e.screen])).values()].join(', ')

// A scenario's timeline (Tester & Checker, Part 3): what the recorder wrote down (recorder.mjs) put in one order on one clock, with what changed in the data
// as diffs, and flags HQ computes itself: no model, no tokens. The checker reads this, not the raw logs, which stay on disk next to it.
// Flags: the same write twice in one action (duplicate), a call far slower than its endpoint's own normal in this run or than its label allows (slow), any
// 4xx/5xx (error), a console error (console), a request the browser couldn't make (failed_request). There are no thresholds to set; a project may override
// the defaults in its test setup (`limits`).
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type EndpointKind = 'instant' | 'normal' | 'heavy'
export type Endpoint = { method: string; path: string; kind: EndpointKind }
export type Limits = { slow_factor?: number; slow_gap_ms?: number; label_ms?: Partial<Record<EndpointKind, number>> }
export type FlagKind = 'duplicate' | 'slow' | 'error' | 'console' | 'failed_request'
export type Flag = { kind: FlagKind; method?: string; path?: string; status?: number; why: string }
export type Source = 'tester' | 'hq' | 'api' | 'server' | 'data' | 'browser'
export type Row = { at: number; source: Source; text: string; flags: Flag[] }
export type Call = { i: number; at: number; end: number; ms: number; method: string; path: string; status?: number; type?: string | null; stream?: boolean
  body?: string | null; action: number | null; error?: string; resetting?: boolean }
type Mark = { at: number; phase: 'start' | 'end'; label: string; action: number; ok?: boolean; why?: string }
type Seen = { at: number; kind: 'console' | 'failed_request' | 'outside'; text?: string; method?: string; path?: string; host?: string; action: number | null }
type Snap = { n: number; at: number; label: string; changed: boolean; hash: string; action: number | null }

/** "About 5× its own normal", and far enough above it to matter: a 1 ms call that took 6 ms is no news. A label's "far outside" is about 10× what it names. */
export const DEFAULT_LIMITS = { slow_factor: 5, slow_gap_ms: 100, label_ms: { instant: 1000, normal: 5000, heavy: 60_000 } as Record<EndpointKind, number> }
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const ID = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[A-Za-z0-9_-]{20,})$/i

const pathOnly = (p: string): string => p.split('?')[0] || '/'
/** A pattern of an endpoint label (`/api/items/:id`) as a test on a path. */
const matcher = (pattern: string): RegExp => new RegExp(`^${pathOnly(pattern).split('/').map((s) => s.startsWith(':') || s === '*' ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}/?$`)
/** The endpoint a call is to: its label when one matches, else its path with id-looking parts as `:id`. */
export function endpointOf(method: string, p: string, labels: Endpoint[]): { key: string; path: string; label: Endpoint | null } {
  const bare = pathOnly(p), label = labels.find((e) => e.method.toUpperCase() === method.toUpperCase() && matcher(e.path).test(bare)) ?? null
  const shape = label ? pathOnly(label.path) : bare.split('/').map((s) => ID.test(s) ? ':id' : s).join('/')
  return { key: `${method.toUpperCase()} ${shape}`, path: shape, label }
}
/** An API call, not the page or its files: a labelled endpoint, any write, or a path with no file extension that isn't a page. */
export function isApi(c: Call, labels: Endpoint[]): boolean {
  if (endpointOf(c.method, c.path, labels).label || WRITES.has(c.method)) return true
  const bare = pathOnly(c.path)
  return bare !== '/' && !/\.[a-z0-9]{1,6}$/i.test(bare) && !/^text\/html\b/.test(c.type ?? '')
}
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }

/** The flags of each call, by its number. HQ's own 503s while it resets the app are not the app's. */
export function flagCalls(calls: Call[], labels: Endpoint[], limits: Limits = {}): Map<number, Flag[]> {
  const L = { ...DEFAULT_LIMITS, ...limits, label_ms: { ...DEFAULT_LIMITS.label_ms, ...(limits.label_ms ?? {}) } }
  const out = new Map<number, Flag[]>(), add = (c: Call, f: Flag) => out.set(c.i, [...(out.get(c.i) ?? []), f])
  const mine = calls.filter((c) => !c.resetting).sort((a, b) => a.at - b.at || a.i - b.i)
  for (const c of mine) {
    const ep = endpointOf(c.method, c.path, labels)
    if (c.status !== undefined && c.status >= 400) add(c, { kind: 'error', method: c.method, path: ep.path, status: c.status, why: `${c.status}${c.error ? ` (${c.error})` : ''}` })
  }
  // The same write (method, path with its query, body) more than once in one action
  const seen = new Map<string, number>()
  for (const c of mine.filter((x) => WRITES.has(x.method) && x.action !== null)) {
    const k = `${c.action} ${c.method} ${c.path} ${c.body ?? ''}`, n = (seen.get(k) ?? 0) + 1; seen.set(k, n)
    if (n > 1) add(c, { kind: 'duplicate', method: c.method, path: endpointOf(c.method, c.path, labels).path, why: `${n}x in one action` })
  }
  // Slow: against the endpoint's own calls in this run (never its first, which may warm up a cache), and against its label
  const by = new Map<string, Call[]>()
  for (const c of mine.filter((x) => !x.stream && isApi(x, labels))) { const k = endpointOf(c.method, c.path, labels).key; by.set(k, [...(by.get(k) ?? []), c]) }
  for (const list of by.values()) {
    const ep = endpointOf(list[0]!.method, list[0]!.path, labels)
    list.forEach((c, idx) => {
      const cap = ep.label ? L.label_ms[ep.label.kind] : null
      if (cap !== null && c.ms > cap) return add(c, { kind: 'slow', method: c.method, path: ep.path, why: `${c.ms}ms, far over what an ${ep.label!.kind} call takes` })
      if (idx === 0) return
      const others = list.slice(1).filter((x) => x !== c).map((x) => x.ms)
      if (others.length < 2) return
      const normal = median(others)
      if (c.ms >= L.slow_factor * Math.max(normal, 1) && c.ms - normal >= L.slow_gap_ms) {
        add(c, { kind: 'slow', method: c.method, path: ep.path, why: `${c.ms}ms, its normal here is ${Math.round(normal)}ms` })
      }
    })
  }
  return out
}

// Data: what changed between two snapshots, as a person would say it: "books: +Dune", "reading: ~Emma (read: false→true)"
const KEYS = ['id', '_id', 'uuid', 'key'], NAMES = ['name', 'title', 'label', 'text', 'item', 'description']
const short = (v: unknown, n = 30): string => { const s = typeof v === 'string' ? v : JSON.stringify(v) ?? 'null'; return s.length > n ? `${s.slice(0, n - 1)}…` : s }
const nameOf = (r: unknown): string => {
  if (!r || typeof r !== 'object') return short(r)
  const o = r as Record<string, unknown>, n = NAMES.find((k) => typeof o[k] === 'string' && o[k]); return n ? short(o[n], 40) : short(KEYS.map((k) => o[k]).find((v) => v !== undefined) ?? r, 40)
}
const keyOf = (r: unknown): string => {
  if (r && typeof r === 'object') { const o = r as Record<string, unknown>; const k = KEYS.find((x) => o[x] !== undefined); if (k) return `${k}:${String(o[k])}` }
  return `=${JSON.stringify(r)}`
}
/** The changes between two lists of records, matched by their id (or, with none, by their whole value). */
export function diffRecords(a: unknown[], b: unknown[]): string[] {
  const before = new Map<string, unknown[]>(); for (const r of a) { const k = keyOf(r); before.set(k, [...(before.get(k) ?? []), r]) }
  const out: string[] = []
  for (const r of b) {
    const k = keyOf(r), list = before.get(k)
    if (!list?.length) { out.push(`+${nameOf(r)}`); continue }
    const old = list.shift()!
    if (JSON.stringify(old) === JSON.stringify(r)) continue
    if (r && old && typeof r === 'object' && typeof old === 'object') {
      const o = old as Record<string, unknown>, n = r as Record<string, unknown>
      const fields = [...new Set([...Object.keys(o), ...Object.keys(n)])].filter((f) => JSON.stringify(o[f]) !== JSON.stringify(n[f]))
      const shown = fields.filter((f) => !/^(updated|modified)(At|_at|On)?$/i.test(f)), list2 = (shown.length ? shown : fields)
      out.push(`~${nameOf(r)} (${list2.slice(0, 3).map((f) => `${f}: ${short(o[f], 20)}→${short(n[f], 20)}`).join(', ')}${list2.length > 3 ? ', …' : ''})`)
    } else out.push(`~${nameOf(r)}`)
  }
  for (const list of before.values()) for (const r of list) out.push(`-${nameOf(r)}`)
  return out
}
/** The changes inside one JSON value: lists of records by record, objects by key, anything else as old→new. */
export function diffJson(a: unknown, b: unknown, at = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return []
  if (Array.isArray(a) && Array.isArray(b)) return diffRecords(a, b).map((x) => at ? `${at}: ${x}` : x)
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const o = a as Record<string, unknown>, n = b as Record<string, unknown>
    const pre = at ? `${at}.` : ''
    return [...new Set([...Object.keys(o), ...Object.keys(n)])].flatMap((k) => k in n ? (k in o ? diffJson(o[k], n[k], `${pre}${k}`) : [`${pre}+${k}`]) : [`${pre}-${k}`])
  }
  return [`${at || 'value'}: ${short(a)}→${short(b)}`]
}
const SQLITE = /\.(sqlite3?|db)$/i
/** Every table's rows of a SQLite file (a copy: the snapshot's own). */
function sqliteRows(file: string): Record<string, unknown[]> {
  const db = new DatabaseSync(file)
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
    return Object.fromEntries(tables.map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name.replace(/"/g, '""')}" LIMIT 5000`).all()]))
  } finally { db.close() }
}
function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    const abs = path.join(root, rel); let st: fs.Stats; try { st = fs.statSync(abs) } catch { return }
    if (st.isDirectory()) { for (const n of fs.readdirSync(abs).sort()) walk(rel ? `${rel}/${n}` : n); return }
    if (!/-(wal|shm|journal)$/.test(rel) && !/\.tmp$/.test(rel)) out.push(rel)
  }
  walk(''); return out
}
/** What changed in the app's state between two snapshot folders, one entry per file that changed: "books: +Dune". */
export function diffSnapshots(beforeDir: string, afterDir: string): string[] {
  const a = new Set(filesUnder(beforeDir)), b = new Set(filesUnder(afterDir)), out: string[] = []
  for (const rel of [...new Set([...a, ...b])].sort()) {
    const name = path.basename(rel).replace(/\.[^.]+$/, '')
    if (!b.has(rel)) { out.push(`${name}: file removed`); continue }
    const fa = path.join(beforeDir, rel), fb = path.join(afterDir, rel)
    try {
      if (SQLITE.test(rel)) {
        const ra = a.has(rel) ? sqliteRows(fa) : {}, rb = sqliteRows(fb)
        for (const t of [...new Set([...Object.keys(ra), ...Object.keys(rb)])]) { const d = diffRecords(ra[t] ?? [], rb[t] ?? []); if (d.length) out.push(`${t}: ${d.join(', ')}`) }
        continue
      }
      const ta = a.has(rel) ? fs.readFileSync(fa, 'utf8') : null, tb = fs.readFileSync(fb, 'utf8')
      if (ta === tb) continue
      if (/\.json$/i.test(rel)) {
        const nb = JSON.parse(tb), d = diffJson(ta === null ? (Array.isArray(nb) ? [] : {}) : JSON.parse(ta), nb)
        if (d.length) out.push(`${name}: ${d.join(', ')}`); continue
      }
      const la = (ta ?? '').split('\n'), lb = tb.split('\n'), sa = new Set(la), sb = new Set(lb)
      out.push(`${name}: ${ta === null ? 'file created, ' : ''}+${lb.filter((l) => !sa.has(l)).length} -${la.filter((l) => !sb.has(l)).length} lines`)
    } catch { out.push(`${name}: changed`) }
  }
  return out
}

const readJsonl = <T>(file: string): T[] => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T] } catch { return [] } }) } catch { return [] }
}
const SERVER_WORTH = /\b(error|exception|warn(ing)?|fail(ed|ure)?|unhandled|traceback|panic|fatal|ECONN\w*|EADDR\w*)\b/i
const clock = (ms: number): string => { const d = new Date(ms); return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}` }
const cutText = (s: string, n: number): string => s.length > n ? `${s.slice(0, n - 1)}…` : s

export type Timeline = { rows: Row[]; flags: Flag[]; markdown: string; summary: string; calls: number; clean: boolean }
/** Puts a recording folder's logs in one order and writes timeline.md and data.jsonl next to them. `steps`: how each step went (result.json), when known. */
export function buildTimeline(dir: string, o: { endpoints?: Endpoint[]; limits?: Limits; name?: string } = {}): Timeline {
  const labels = o.endpoints ?? [], rows: Row[] = []
  const marks = readJsonl<Mark>(path.join(dir, 'actions.jsonl')), calls = readJsonl<Call>(path.join(dir, 'api.jsonl'))
  const seen = readJsonl<Seen>(path.join(dir, 'browser.jsonl')), snaps = readJsonl<Snap>(path.join(dir, 'snaps.jsonl'))
  // What the tester did (and HQ's resets): each action at its start, a failed one with why
  const ended = new Map(marks.filter((m) => m.phase === 'end').map((m) => [m.action, m]))
  for (const m of marks.filter((x) => x.phase === 'start')) {
    const e = ended.get(m.action), failed = e?.ok === false
    if (m.label === 'reset') rows.push({ at: m.at, source: 'hq', text: failed ? `✗ reset the app to its seed: ${e!.why}` : 'reset the app to its seed', flags: [] })
    else rows.push({ at: m.at, source: 'tester', text: failed ? `✗ ${m.label} (${e!.why})` : m.label, flags: [] })
  }
  // API calls: every write and every flagged call on a row of its own; an action's other reads in one row
  const flags = flagCalls(calls, labels, o.limits), api = calls.filter((c) => isApi(c, labels) || (c.status ?? 0) >= 400).sort((a, b) => a.at - b.at || a.i - b.i)
  const reads = new Map<string, Call[]>()
  for (const c of api) {
    const f = flags.get(c.i) ?? []
    if (c.resetting) continue
    if (!WRITES.has(c.method) && !f.length) { const k = String(c.action); reads.set(k, [...(reads.get(k) ?? []), c]); continue }
    const dup = f.find((x) => x.kind === 'duplicate'), rest = f.filter((x) => x !== dup)
    const marks = `${dup ? ` ⚠ ${dup.why.split(' ')[0]}` : ''}${rest.map((x) => ` ⚠ ${x.kind === 'error' ? x.why : `${x.kind}: ${x.why}`}`).join('')}`
    rows.push({ at: c.at, source: 'api', text: `${c.method} ${c.path} → ${c.status ?? 'no reply'} (${c.stream ? 'stream' : `${c.ms}ms`})${marks}`, flags: f })
  }
  for (const list of reads.values()) {
    const count = new Map<string, number>(); for (const c of list) { const p = pathOnly(c.path); count.set(p, (count.get(p) ?? 0) + 1) }
    const names = [...count].sort((a, b) => b[1] - a[1]).map(([p, n]) => n > 1 ? `${p} ×${n}` : p)
    const shown = `${names.slice(0, 6).join(', ')}${names.length > 6 ? `, +${names.length - 6} more` : ''}`
    rows.push({ at: list[0]!.at, source: 'api', text: `${list.length} read${list.length > 1 ? 's' : ''}: ${shown}`, flags: [] })
  }
  // Data: each snapshot that changed, against the last one that did
  const dataLines: { at: number; n: number; label: string; changes: string[] }[] = []
  let last: string | null = null, seedHash: string | null = snaps[0]?.hash ?? null
  for (const s of snaps) {
    const here = path.join(dir, 'snapshots', String(s.n).padStart(4, '0'))
    if (!s.changed) continue
    if (last && fs.existsSync(here)) {
      const changes = s.label === 'reset' && s.hash === seedHash ? ['back to the seed'] : diffSnapshots(last, here)
      if (changes.length) { dataLines.push({ at: s.at, n: s.n, label: s.label, changes }); rows.push({ at: s.at, source: 'data', text: cutText(changes.join('; '), 600), flags: [] }) }
    }
    if (s.label === 'start') seedHash = s.hash
    if (fs.existsSync(here)) last = here
  }
  try { fs.writeFileSync(path.join(dir, 'data.jsonl'), dataLines.map((d) => JSON.stringify(d)).join('\n') + (dataLines.length ? '\n' : '')) } catch { /* read-only: the rows have it */ }
  // The browser and the server: errors only; a host outside the test (no internet in here) said once, and not a flag
  const outside = new Set<string>()
  for (const b of seen) {
    if (b.kind === 'outside') {
      if (b.host && !outside.has(b.host)) {
        outside.add(b.host); rows.push({ at: b.at, source: 'browser', text: `couldn't reach ${b.host} (no internet in HQ's test: not the app's fault)`, flags: [] })
      }
      continue
    }
    const f: Flag = b.kind === 'console' ? { kind: 'console', why: cutText(b.text ?? '', 200) }
      : { kind: 'failed_request', method: b.method, path: b.path ? pathOnly(b.path) : undefined, why: b.text ?? '' }
    const text = b.kind === 'console' ? `console error: ${cutText(b.text ?? '', 300)} ⚠` : `${b.method ?? ''} ${b.path ?? ''} failed (${b.text}) ⚠`.trim()
    rows.push({ at: b.at, source: 'browser', text, flags: [f] })
  }
  try {
    for (const line of fs.readFileSync(path.join(dir, 'server.log'), 'utf8').split('\n')) {
      const [at, part, ...text] = line.split('\t'), t = text.join('\t')
      if (at && t && SERVER_WORTH.test(t)) rows.push({ at: Number(at), source: 'server', text: cutText(`${part}: ${t}`, 300), flags: [] })
    }
  } catch { /* no server output */ }
  // At the same millisecond, what the last action changed comes before the next action, and an action before what it caused
  const rank: Record<Source, number> = { data: 0, hq: 1, tester: 2, api: 3, browser: 4, server: 5 }
  rows.sort((a, b) => a.at - b.at || rank[a.source] - rank[b.source])
  const all = rows.flatMap((r) => r.flags), apiCount = api.filter((c) => !c.resetting).length
  const steps = marks.filter((m) => m.phase === 'end' && m.label !== 'reset'), failed = steps.filter((m) => m.ok === false).length
  const dataSteps = dataLines.filter((d) => d.label !== 'reset' && d.label !== 'start').length
  const clean = !all.length && !failed
  const ms = marks.length ? marks.at(-1)!.at - marks[0]!.at : 0
  const kinds = [...new Set(all.map((f) => f.kind))].map((k) => `${all.filter((f) => f.kind === k).length} ${k.replace('_', ' ')}`)
  const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`
  const summary = `${o.name ? `${o.name}: ` : ''}${plural(steps.length, 'step')}${failed ? `, ${failed} couldn't be done` : ' OK'}, ${plural(apiCount, 'API call')}, `
    + `data changed in ${dataSteps} step${dataSteps === 1 ? "" : "s"}, ${kinds.length ? `flags: ${kinds.join(', ')}` : 'no flags'} (${(ms / 1000).toFixed(1)} s)`
  const markdown = [`# ${o.name ?? 'Scenario'}`, '', summary, '', '| time | source | what |', '|---|---|---|',
    ...rows.map((r) => `| ${clock(r.at)} | ${r.source} | ${r.text.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)].join('\n') + '\n'
  try { fs.writeFileSync(path.join(dir, 'timeline.md'), markdown) } catch { /* read-only */ }
  return { rows, flags: all, markdown, summary, calls: apiCount, clean }
}

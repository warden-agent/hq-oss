// A project's test setup (Tester & Checker, Part 3): how HQ runs its app for a scenario, worked out once by the setup helper (testsetup.ts) and kept in HQ's
// own folder for the project, never in the user's repo and outside the launch recipe (a fixed recipe would wipe it, and a ⚙ command has no recipe to hold
// it). Four answers and the endpoint labels:
// - start: each part of the app as a production build would run it, never a dev server, which hands out the source (Vite serves /src/App.tsx).
// - snapshot: the paths that hold the app's state (a JSON-file app: its data/ folder; a SQLite app: its .db file). HQ copies them after every action, and empties them for a reset.
// - seed: a command that writes a deliberate, clean fixture into those (emptied) paths. The user's own data is never the seed.
// - reset: HQ's own steps, the same for every app: stop it, put the seed back, start it again (many apps read their files only when they start).
// - endpoints: each API endpoint and the kind of work it does (instant, normal, heavy), judged from the code; HQ's slow flag reads them (timeline.ts).
// File reads and the rules only; no DB.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { PATHS } from './config.ts'
import type { Recipe } from './apprun.ts'

const rel = z.string().min(1).max(200).refine((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'), 'must be a path inside the repo')
export const setupShape = {
  start: z.array(z.object({ part: z.string().describe('a part of the start steps, by name'), build: z.string().min(1).max(500).optional().describe('the production build, if it has one'),
    run: z.string().min(1).max(500).describe('runs the built app; $PORT as in the start steps') })).min(1).max(6),
  snapshot: z.array(rel).min(1).max(10).describe('paths holding the app\'s state: data folders, database files'),
  seed: z.string().min(1).max(8000).describe('writes a small clean fixture into the (emptied) snapshot paths; runs in the repo root, no network'),
  endpoints: z.array(z.object({ method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: z.string().min(1).max(200).regex(/^\//, 'starts with /'),
    kind: z.enum(['instant', 'normal', 'heavy']) })).max(200).default([]),
  notes: z.string().max(2000).default(''),
}
const setupSchema = z.object(setupShape)
export type TestSetup = z.infer<typeof setupSchema> & { limits?: { slow_factor?: number; slow_gap_ms?: number; label_ms?: Record<string, number> } }

/** What HQ keeps per project: the setup in use, when and by whom it was saved and checked, the helper working on it, and the changes engineers made on
 *  tickets not merged yet (applied when each one merges). `seen`: the user has seen this setup (it's shown to them once). */
export type SetupFile = {
  setup: TestSetup | null; saved_at: number | null; by: string | null; checked: { ok: boolean; at: number; why: string | null; scenario: string | null } | null; seen: boolean
  job: { agent_id: string; worktree: string; saves: number; state: 'working' | 'checking'; started_at: number } | null
  ended: { state: 'cant_test' | 'failed'; note: string; at: number } | null
  pending: Record<string, { key: string; setup: Partial<TestSetup>; at: number }>
  /** Changes whose tickets merged, waiting for HQ's check (oldest first). */
  merged: { ticket_id: string; key: string; setup: Partial<TestSetup>; at: number }[]
}
const blank = (): SetupFile => ({ setup: null, saved_at: null, by: null, checked: null, seen: false, job: null, ended: null, pending: {}, merged: [] })
export const setupFile = (repoId: string): string => path.join(PATHS.projects, repoId, 'test-setup.json')
export function readSetup(repoId: string): SetupFile {
  try { return { ...blank(), ...JSON.parse(fs.readFileSync(setupFile(repoId), 'utf8')) as Partial<SetupFile> } } catch { return blank() }
}
export function writeSetup(repoId: string, next: SetupFile): void {
  const f = setupFile(repoId); fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(next, null, 1)); fs.renameSync(tmp, f)
}
/** The setup in use for this project, or null when there is none yet. */
export const testSetupOf = (repoId: string): TestSetup | null => readSetup(repoId).setup

/** Commands that start a dev server, not a built app. A rule on the words only; HQ's check also looks at what the page loads (testsetup.ts). */
const DEV = new RegExp(['\\b(vite(?![\\w-])(?!\\s+(build|preview))|next\\s+dev|nuxt\\s+dev|nodemon|webpack(-dev)?-server|webpack\\s+serve|react-scripts\\s+start',
  '|ng\\s+serve|npm\\s+run\\s+dev|yarn\\s+dev|pnpm\\s+dev|flask\\s+run\\s+.*--debug|runserver)\\b|(^|\\s)--reload\\b'].join(''), 'i')
/** Paths a reset must never empty: the whole checkout, git's or HQ's folders, installed packages. */
const NEVER = /^(\.|\.git|\.claude|\.hq-[\w-]+|node_modules|\.venv)(\/|$)/
/** The setup if HQ can run it with these start steps in `root` (a checkout), else what's wrong, in words the helper can act on. */
export function checkSetup(input: unknown, recipe: Recipe, root: string): { setup: TestSetup } | { error: string } {
  const r = setupSchema.safeParse(input)
  if (!r.success) return { error: r.error.issues.map((i) => `${i.path.join('.') || 'setup'}: ${i.message}`).join('; ') }
  const s = r.data as TestSetup, names = recipe.parts.map((p) => p.name)
  for (const x of s.start) if (!names.includes(x.part)) return { error: `start: "${x.part}" isn't a part of the start steps (${names.join(', ')})` }
  const missing = names.filter((n) => !s.start.some((x) => x.part === n)), many = missing.length > 1
  if (missing.length) return { error: `start: say how the built ${missing.join(', ')} part${many ? 's' : ''} run${many ? '' : 's'}` }
  if (new Set(s.start.map((x) => x.part)).size !== s.start.length) return { error: 'start: one entry per part' }
  for (const x of s.start) {
    if (DEV.test(`${x.build ?? ''} ${x.run}`)) return { error: `start: "${x.run}" looks like a dev server, which serves the app's source; use its production build and a plain server for it` }
  }
  for (const p of s.snapshot.map((x) => path.normalize(x).replace(/\/$/, ''))) {
    if (NEVER.test(p)) return { error: `snapshot: ${p} isn't the app's data; name the folder or file it keeps its state in` }
    if (!fs.existsSync(path.dirname(path.join(root, p)))) return { error: `snapshot: the folder around ${p} doesn't exist in the repo` }
  }
  const eps = new Set<string>(); for (const e of s.endpoints) { const k = `${e.method} ${e.path}`; if (eps.has(k)) return { error: `endpoints: ${k} is listed twice` }; eps.add(k) }
  return { setup: s }
}
/** An engineer's change on top of the setup in use: the fields they gave replace those fields. */
export const mergeSetup = (base: TestSetup, change: Partial<TestSetup>): TestSetup => ({ ...base, ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) })

/** What the preview pane shows about testing. */
export function setupView(repoId: string): { setup: TestSetup | null; saved_at: number | null; by: string | null; checked: SetupFile['checked']; seen: boolean
  working: boolean; state: string | null; note: string | null; helper_agent_id: string | null; pending: string[]; checking: string[] } {
  const f = readSetup(repoId)
  return { setup: f.setup, saved_at: f.saved_at, by: f.by, checked: f.checked, seen: f.seen, working: !!f.job, state: f.job?.state ?? f.ended?.state ?? null,
    note: f.ended?.note ?? null, helper_agent_id: f.job?.agent_id ?? null, pending: Object.values(f.pending).map((p) => p.key), checking: f.merged.map((m) => m.key) }
}

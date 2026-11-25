// A project's test steps (Bug 411): how HQ tests it when its own rules (testrun.ts detectTests) can't run every test the project has. One part per folder
// with tests of its own: what installs its packages from nothing, and what runs its suite. Worked out once by the test steps helper (teststeps.ts), checked
// by HQ in its own sandbox before it is used, and kept in HQ's folder for the project, never in the user's repo. The user's own test command (repos.test_cmd)
// always comes first; with neither, the rules decide, as before.
// File reads and the rules only; no DB.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { PATHS } from './config.ts'
import { isProjectTest, notRun, type NotRun } from './testcensus.ts'

const inside = (p: string): boolean => !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..')
export const stepsShape = {
  parts: z.array(z.object({
    dir: z.string().min(1).max(200).describe('the folder, from the project\'s root; "." for the root'),
    install: z.string().min(1).max(300).optional().describe('installs the folder\'s packages from nothing; HQ runs it there with the network on. Leave out when nothing needs installing'),
    test: z.string().min(1).max(300).describe('runs the folder\'s whole test suite; HQ runs it there with no network beyond localhost. Non-zero exit when a test fails'),
  })).min(1).max(8),
  left_out: z.array(z.object({ path: z.string().min(1).max(200).describe('a folder or file of tests your parts don\'t run'),
    why: z.string().min(1).max(300).describe('one plain sentence: why HQ can\'t run them') })).max(20).default([]),
  notes: z.string().max(1000).default(''),
}
const stepsSchema = z.object(stepsShape)
export type TestSteps = z.infer<typeof stepsSchema>
/** A part as HQ keeps it. `tests`: the commit it was checked on had test files under its folder, so on a commit with none there the part is left out (steps
 *  learned from one ticket's code can't fail another's). `engineers`: the helper ran its test command in its own session, so an engineer's session can too;
 *  one it couldn't run (a tool its sandbox can't read) is HQ's alone to run. */
export type SavedPart = TestSteps['parts'][number] & { tests: boolean; engineers: boolean }
export type SavedSteps = Omit<TestSteps, 'parts'> & { parts: SavedPart[] }
/** What HQ keeps per project: the steps in use, when they were saved and on which commit HQ checked them, the helper working on them, how the last helper
 *  ended, and the gaps a helper has already looked at (a gap never starts a second session by itself). `seen`: the user has seen these steps. */
export type StepsFile = {
  steps: SavedSteps | null; saved_at: number | null; by: string | null; checked: { sha: string; at: number } | null; seen: boolean
  job: { agent_id: string; worktree: string; saves: number; state: 'working' | 'checking'; started_at: number; sha: string; why: 'first' | 'again' | 'gap'; ticket_id: string | null
    gap: string } | null
  ended: { state: 'cant' | 'failed'; note: string; at: number } | null
  looked: { gap: string; at: number; result: 'saved' | 'cant' | 'failed' }[]
}
const blank = (): StepsFile => ({ steps: null, saved_at: null, by: null, checked: null, seen: false, job: null, ended: null, looked: [] })
export const stepsFile = (repoId: string): string => path.join(PATHS.projects, repoId, 'test-steps.json')
export function readSteps(repoId: string): StepsFile {
  try { return { ...blank(), ...JSON.parse(fs.readFileSync(stepsFile(repoId), 'utf8')) as Partial<StepsFile> } } catch { return blank() }
}
export function writeSteps(repoId: string, next: StepsFile): void {
  const f = stepsFile(repoId); fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(next, null, 1)); fs.renameSync(tmp, f)
}
/** The steps in use for this project, or null when it has none (the rules decide). */
export const stepsOf = (repoId: string): SavedSteps | null => readSteps(repoId).steps

const tidy = (dir: string): string => path.posix.normalize(dir.trim().replace(/\\/g, '/')).replace(/\/+$/, '') || '.'
/** The steps if HQ can run them in `root` (a checkout), else what's wrong, in words the helper can act on. A folder's name goes into a shell line, so one the
 *  shell would read as more than a name is refused. */
export function checkSteps(input: unknown, root: string): { steps: TestSteps } | { error: string } {
  const r = stepsSchema.safeParse(input)
  if (!r.success) return { error: r.error.issues.map((i) => `${i.path.join('.') || 'steps'}: ${i.message}`).join('; ') }
  const s: TestSteps = { ...r.data, parts: r.data.parts.map((p) => ({ ...p, dir: tidy(p.dir), test: p.test.trim(), ...(p.install ? { install: p.install.trim() } : {}) })),
    left_out: r.data.left_out.map((l) => ({ path: tidy(l.path), why: l.why.trim() })) }
  for (const p of s.parts) {
    if (!inside(p.dir) || /["\\$`\n]/.test(p.dir)) return { error: `parts: "${p.dir}" must be a plain folder inside the project, from its root ("." for the root)` }
    const at = path.join(root, p.dir); if (!fs.existsSync(at) || !fs.statSync(at).isDirectory()) return { error: `parts: there is no folder "${p.dir}" in the project` }
  }
  const seen = new Set<string>()
  for (const p of s.parts) { const k = `${p.dir}\0${p.test}`; if (seen.has(k)) return { error: `parts: "${p.test}" in "${p.dir}" is listed twice` }; seen.add(k) }
  for (const l of s.left_out) if (!inside(l.path)) return { error: `left_out: "${l.path}" must be a path inside the project, from its root` }
  return { steps: s }
}
/** A part's command as one shell line from the project's root: bare at the root, `(cd "web" && npm test)` in a folder (the shape HQ's rules build too). */
export const partCmd = (dir: string, run: string): string => dir === '.' ? run : `(cd ${JSON.stringify(dir)} && ${run})`
/** The parts' test commands as the project's one test command. */
export const chain = (parts: { dir: string; test: string }[]): string => parts.map((p) => partCmd(p.dir, p.test)).join(' && ')
const under = (file: string, dir: string): boolean => dir === '.' || file.startsWith(`${dir}/`)
/** Does a commit have test files under this folder? What `tests` records as steps are saved. */
export const hasTests = (files: string[], dir: string): boolean => files.some((f) => under(f, dir) && isProjectTest(f))
/** The parts that apply to a commit with these files: all of them, but one whose folder has no test files there though it had some when HQ checked it. */
export const partsHere = <P extends SavedPart>(parts: P[], files: string[]): P[] =>
  parts.filter((p) => !p.tests || hasTests(files, p.dir))
/** The test files of a commit that saved steps neither run nor leave out on purpose. HQ can't tell what kind of tests a helper's command runs, so a part
 *  answers for every kind in its folder. */
export function stepsSkip(files: string[], steps: Pick<SavedSteps, 'parts' | 'left_out'>, has: (p: string) => boolean, read: (p: string) => string): NotRun[] {
  const left = steps.left_out.map((l) => l.path), out = (f: string): boolean => left.some((l) => l === '.' || f === l || f.startsWith(`${l}/`))
  return notRun(files.filter((f) => !out(f)), steps.parts.map((p) => ({ dir: p.dir, kind: 'any' as const })), has, read)
}
/** A gap by name, to remember that a helper has looked at it: the folders and kinds of the tests not run, in order. '' for none. */
export const gapKey = (gaps: NotRun[]): string => gaps.map((g) => `${g.dir}:${g.kind}`).sort().join(',')

/** What the turn gate knows as this project's test runs (heavy.ts): the user's own command, else each saved step's command (a run of one folder's suite is a
 *  test run too). [] when there is neither: the gate goes by the program's name alone. */
export const gateCmds = (testCmd: string | null, steps: SavedSteps | null): string[] => testCmd?.trim() ? [testCmd.trim()] : steps ? [...new Set(steps.parts.map((p) => p.test))] : []
/** The project's saved test command, whoever wrote it: the user's own, else the saved steps as one line; null when the rules decide. */
export const savedCmd = (testCmd: string | null, steps: SavedSteps | null): string | null => testCmd?.trim() || (steps ? chain(steps.parts) : null)

/** What the page shows about the project's test steps. */
export function stepsView(repoId: string): { steps: SavedSteps | null; saved_at: number | null; by: string | null; checked: StepsFile['checked']; seen: boolean; working: boolean
  state: string | null; note: string | null; helper_agent_id: string | null; saves: number } {
  const f = readSteps(repoId)
  return { steps: f.steps, saved_at: f.saved_at, by: f.by, checked: f.checked, seen: f.seen, working: !!f.job, state: f.job?.state ?? f.ended?.state ?? null, note: f.ended?.note ?? null,
    helper_agent_id: f.job?.agent_id ?? null, saves: f.job?.saves ?? 0 }
}

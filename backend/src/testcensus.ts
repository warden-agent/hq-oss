// Bug 411: does HQ's test command run every test the project has? HQ's rules (testrun.ts detectTests) stopped at the first thing they knew: a repo with
// frontend/ (npm) and backend/ (pytest) ran the frontend's tests only, and nothing said so. This lists a commit's test files (from git's own list, so nothing
// installed or ignored counts) and says which of them no part of the command runs: plain code, no model. Rules only, no imports but the test-file rule:
// the page words its findings too.
import { isTestFile } from './criteria.ts'

/** The kinds of test files HQ tells apart, by their ending. */
export type TestKind = 'js' | 'python' | 'rust' | 'go' | 'java' | 'ruby' | 'php' | 'csharp' | 'elixir' | 'swift' | 'dart'
export const KIND_NAME: Record<TestKind, string> = { js: 'JavaScript', python: 'Python', rust: 'Rust', go: 'Go', java: 'Java', ruby: 'Ruby', php: 'PHP', csharp: 'C#', elixir: 'Elixir',
  swift: 'Swift', dart: 'Dart' }
const EXT: Record<string, TestKind> = { js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js', py: 'python', rs: 'rust', go: 'go',
  java: 'java', kt: 'java', scala: 'java', groovy: 'java', rb: 'ruby', php: 'php', cs: 'csharp', ex: 'elixir', exs: 'elixir', swift: 'swift', dart: 'dart' }
/** Folders whose files aren't the project's own tests: other people's code, what a build makes, and what tests read (fixtures, snapshots). */
/** Django's own name for an app's tests (`shop/tests.py`), which the shared test-file rule doesn't know. */
const TESTS_PY = /(^|\/)tests\.py$/
const NOT_TESTS = /(^|\/)(node_modules|vendor|third_party|third-party|testdata|fixtures?|__fixtures__|__snapshots__|__mocks__|snapshots|\.github|\.buildkite|dist|build|target)\//
/** Is this path one of the project's own test files: code, named or placed as a test, and not somebody else's or something tests only read? */
export const isProjectTest = (file: string): boolean => !!kindOf(file) && !NOT_TESTS.test(file) && (isTestFile(file) || TESTS_PY.test(file))
/** A part of the test command: the folder it runs in ('.' for the project's root) and the kind of tests it runs (`any`: HQ can't tell, so every kind). */
export type RunPart = { dir: string; kind: TestKind | 'any' }
/** Test files no part runs: the folder at the project's top they are under ('.' for the top itself), their kind, how many, and one of them. */
export type NotRun = { dir: string; kind: TestKind; count: number; example: string }

export const kindOf = (file: string): TestKind | undefined => EXT[file.slice(file.lastIndexOf('.') + 1).toLowerCase()]
const under = (file: string, dir: string): boolean => dir === '.' || file.startsWith(`${dir}/`)
const join = (dir: string, name: string): string => dir === '.' ? name : `${dir}/${name}`
const parent = (p: string): string => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'
/** What kind of tests a command of HQ's rules runs. */
const runKind = (run: string): RunPart['kind'] => /^(npm|yarn|pnpm|bun) /.test(run) ? 'js' : /\bpytest\b/.test(run) ? 'python' : /^cargo /.test(run) ? 'rust' : /^go /.test(run) ? 'go' : 'any'
/** The parts of the command HQ's rules build, read back from it: `(cd "web" && npm test) && …` is one part per folder, anything else one part at the root. */
export function ruleParts(test: string): RunPart[] {
  const ms = [...test.trim().matchAll(/\(cd ("[^"\\$`]+") && ([^()]+)\)/g)]
  return ms.length ? ms.map((m) => ({ dir: JSON.parse(m[1]!) as string, kind: runKind(m[2]!) })) : [{ dir: '.', kind: runKind(test.trim()) }]
}
/** The test files among `files` (a commit's files, as git lists them) that no part runs, most first. A part runs the test files of its kind in its folder,
 *  except those in a project of their own further down that the part's project doesn't hold: a nested package.json when the part's own isn't a workspace's
 *  root (its `npm test` never goes there), a nested go.mod (`go test ./...` stops at one). `has`: is this path one of the files; `read`: a file's text, ''
 *  when it can't be read. */
export function notRun(files: string[], parts: RunPart[], has: (path: string) => boolean, read: (path: string) => string): NotRun[] {
  const workspace = (dir: string): boolean => /"workspaces"\s*:/.test(read(join(dir, 'package.json'))) || has(join(dir, 'pnpm-workspace.yaml'))
  const nested = (file: string, p: RunPart): boolean => {
    const manifest = p.kind === 'js' ? 'package.json' : p.kind === 'go' ? 'go.mod' : null
    if (!manifest || (p.kind === 'js' && workspace(p.dir))) return false
    for (let d = parent(file); d !== p.dir && d !== '.'; d = parent(d)) if (has(join(d, manifest))) return true
    return false
  }
  const groups = new Map<string, NotRun>()
  for (const f of files) {
    const kind = kindOf(f); if (!kind || !isProjectTest(f)) continue
    if (parts.some((p) => under(f, p.dir) && (p.kind === 'any' || p.kind === kind) && !nested(f, p))) continue
    const dir = f.includes('/') ? f.slice(0, f.indexOf('/')) : '.', key = `${dir}\0${kind}`, g = groups.get(key)
    if (g) g.count++; else groups.set(key, { dir, kind, count: 1, example: f })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
}
/** "backend/ (9 Python test files)", "the top folder (1 Go test file)": one group, for a person. */
export const notRunWords = (g: NotRun): string => `${g.dir === '.' ? 'the top folder' : `${g.dir}/`} (${g.count} ${KIND_NAME[g.kind]} test file${g.count === 1 ? '' : 's'})`

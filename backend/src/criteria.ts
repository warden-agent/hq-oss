// Acceptance criteria HQ can check. Auto mode merges with nobody watching, and "the old tests still pass" let a ticket with no tests of its own through. So the
// TPM gives each ticket its criteria as a list (A1, A2…, each for the screen or behind it), and at open_pr the engineer names, for each one, the test that proves
// it, or says why none can. HQ checks that with git (proof.ts) and, as auto mode tests the ticket, against what its own run printed. No model, no tokens.
// Pure: no DB, no git, no files. The page imports it too, so the board and the backend say the same words. What a criterion may not say (a file, code, words
// too vague to check) is criteriawords.ts.
import { wordingProblems } from './criteriawords.ts'
import { shownLine } from './testcounts.ts'

export type Criterion = { id: string; kind: 'ui' | 'backend'; text: string }
/** What open_pr gives for one criterion: the test that proves it (its file, and its name as written there), or why nothing can test it. */
export type ProofEntry = { criterion: string; file?: string; name?: string; cant_test?: string }
/** How HQ's own test run answered for one named test. `passed`: the run printed it (or its file, with no test in it skipped) as passing. `skipped`: printed
 *  as skipped. `not_run`: the run listed the tests it ran by name, and never this one. `unconfirmed`: the run passed and doesn't list every test by name
 *  (`pytest -q`, `go test`, vitest's and jest's one line per test file), or its file passed with a test in it skipped (Bug 375), so HQ can't tell by name.
 *  Never a reason to send a ticket back. */
export type Confirmed = 'passed' | 'skipped' | 'not_run' | 'unconfirmed'
/** What git shows about a finished ticket's changes, for the user to look at: test files it deleted, existing tests it took lines out of, and files it changed
 *  that the TPM didn't expect it to touch. Listed, never refused: each can be right. */
export type Flags = { tests_deleted: string[]; tests_cut: { file: string; removed: number }[]; outside: string[] }
/** A finished ticket's record: the map open_pr gave, what git showed then, and (once auto mode has tested it) how each named test did in HQ's run. */
export type Proof = { at: number; tests: (ProofEntry & { state?: Confirmed })[]; flags: Flags; confirmed_at?: number }
export type Changed = { path: string; status: 'A' | 'M' | 'D'; added: number; removed: number }

export const MAX_CRITERIA = 12
const ID = /^A[1-9]\d?$/
/** The criteria a TPM (or the API) gave, as HQ keeps them, or what's wrong with them in words the TPM can act on. Ids are the TPM's when it gives one for
 *  every criterion (so a later change keeps them), else A1, A2… in order. Each one's kind may come as `type` too (the spec's word). The words of every
 *  criterion are checked last, and all their problems said at once (criteriawords.ts). Stored criteria are read with criteriaOf, unchecked. */
export function readCriteria(input: unknown): { list: Criterion[] } | { error: string } {
  if (!Array.isArray(input)) return { error: 'criteria must be a list, one entry per thing the finished ticket must do' }
  if (input.length > MAX_CRITERIA) return { error: `At most ${MAX_CRITERIA} criteria per ticket: a ticket with more is two tickets.` }
  const rows = input.map((c) => (c && typeof c === 'object' ? c : {}) as Record<string, unknown>)
  const given = rows.filter((c) => typeof c.id === 'string' && c.id.trim()).length
  if (given && given !== rows.length) return { error: 'Give every criterion an id (A1, A2…) or none of them: HQ numbers them itself when none has one.' }
  const list: Criterion[] = []
  for (const [i, c] of rows.entries()) {
    const text = typeof c.text === 'string' ? c.text.trim().replace(/\s+/g, ' ') : '', kind = String(c.kind ?? c.type ?? '').trim().toLowerCase()
    const id = given ? String(c.id).trim().toUpperCase() : `A${i + 1}`
    if (!text) return { error: `Criterion ${i + 1} has no text.` }
    if (text.length > 400) return { error: `Criterion ${id} is over 400 characters: say the one thing to check; detail goes in the spec.` }
    if (kind !== 'ui' && kind !== 'backend') return { error: `Criterion ${id} needs kind "ui" (something the user sees or does on the screen) or "backend" (anything else).` }
    if (!ID.test(id)) return { error: `"${id}" isn't a criterion id: use A1, A2… up to A99.` }
    if (list.some((x) => x.id === id)) return { error: `Two criteria are called ${id}.` }
    list.push({ id, kind, text })
  }
  const words = list.flatMap((c) => wordingProblems(c.id, c.text))
  return words.length ? { error: `${words.join(' ')}${words.length > 1 ? ' Fix each one and give the whole list again.' : ''}` } : { list }
}
/** A ticket's stored criteria; [] for one with none (HQ's own repair tickets, and every ticket made before criteria were a list). */
export function criteriaOf(t: { criteria?: string | null }): Criterion[] {
  const one = (c: unknown): c is Criterion => !!c && typeof (c as Criterion).id === 'string' && typeof (c as Criterion).text === 'string'
  try { const v = JSON.parse(t.criteria || '[]') as unknown; return Array.isArray(v) ? v.filter(one) : [] } catch { return [] }
}
export function proofOf(t: { proof?: string | null }): Proof | null {
  try { const p = t.proof ? JSON.parse(t.proof) as Proof : null; return p && Array.isArray(p.tests) && p.flags ? p : null } catch { return null }
}
const KIND = { ui: 'screen', backend: 'behind the screen' } as const
/** Headings for criteria split by kind, as the user reads them (the Ticket tab, the ticket box, the run's summary). */
export const KIND_HEADING = { ui: 'On the screen', backend: 'Behind the screen' } as const
/** A ticket's criteria split by kind, screen first, each kind in the TPM's order; a kind with none is left out. */
export const byKind = (list: Criterion[]): { kind: Criterion['kind']; list: Criterion[] }[] =>
  (['ui', 'backend'] as const).map((kind) => ({ kind, list: list.filter((c) => c.kind === kind) })).filter((g) => g.list.length)
/** "- A1 (screen): The list shows each book's due date." */
export const criteriaLines = (list: Criterion[]): string => list.map((c) => `- ${c.id} (${KIND[c.kind]}): ${c.text}`).join('\n')

/** A ticket's criteria under its spec in features/F-N.md, split by kind with the TPM's words for them (ui, backend) and their ids, which update_ticket_spec
 *  keeps. '' with none. */
export const criteriaMd = (list: Criterion[]): string => byKind(list)
  .map((g) => `\n\nAcceptance criteria (${g.kind}):\n${g.list.map((c) => `- ${c.id}: ${c.text}`).join('\n')}`).join('')

/** The ticket box's criteria line, which opens them: how many there are of each kind. null with none (HQ's own repair tickets). */
export function boxCriteria(list: Criterion[]): string | null {
  if (!list.length) return null
  const n = (k: Criterion['kind']) => list.filter((c) => c.kind === k).length, ui = n('ui'), be = n('backend')
  return `Criteria: ${[ui ? `${ui} on the screen` : '', be ? `${be} behind it` : ''].filter(Boolean).join(' · ')}`
}
/** The run summary's "What each one had to do": per merged ticket with criteria, its criteria split by kind, for the user who wasn't asked about them
 *  before work started (auto mode). Empty when none of them has any. */
export function criteriaSummary(done: { key: string; title: string; criteria: Criterion[] }[]): string[] {
  return done.filter((t) => t.criteria.length).map((t) => [`**${t.key}: ${t.title}**`,
    ...byKind(t.criteria).flatMap((g) => [`- ${KIND_HEADING[g.kind]}`, ...g.list.map((c) => `  - ${c.id}: ${c.text}`)])].join('\n'))
}

/** A ticket's criteria as its engineer reads them (launch prompt, get_ticket, a takeover), with what they mean for the plan and for open_pr. '' with none. */
export const criteriaBlock = (list: Criterion[]): string => !list.length ? '' : '\n## Acceptance criteria\nThe ticket is done when every one of these is true. '
  + 'Your plan says, for each id, how you\'ll build it and which test will prove it. open_pr then asks for that test, or for why nothing can test it.\n'
  + `${criteriaLines(list)}\n`

const inRepo = (p: string): boolean => !!p && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..')
/** What's wrong with the map open_pr gave, in words the engineer can act on, or null. Shape only: whether the files and names exist is git's to say. */
export function proofProblem(criteria: Criterion[], tests: ProofEntry[]): string | null {
  const ids = criteria.map((c) => c.id), how = 'For each criterion give the test that proves it (file and name), or cant_test with the reason.'
  for (const e of tests) {
    const id = String(e.criterion ?? '').trim().toUpperCase()
    if (!ids.includes(id)) return `"${e.criterion}" isn't one of this ticket's criteria (${ids.join(', ')}).`
    const file = e.file?.trim(), name = e.name?.trim(), cant = e.cant_test?.trim()
    if (cant && (file || name)) return `${id}: give a test (file and name) or cant_test, not both.`
    if (cant) {
      if (cant.length < 15) return `${id}: say why it can't be tested, in a sentence the user can judge ("${cant}" is too short).`
      if (cant.length > 300) return `${id}: keep the cant_test reason under 300 characters.`
      continue
    }
    if (!file || !name) return `${id}: a test needs both file (its path in the repo) and name (the test's name as written in that file). ${how}`
    if (!inRepo(file)) return `${id}: file must be a path inside the repo, like test/items.test.js, not "${file}".`
    if (name.length > 200) return `${id}: keep name under 200 characters; a part of the test's name that only it has is enough.`
  }
  const missing = ids.filter((id) => !tests.some((e) => String(e.criterion ?? '').trim().toUpperCase() === id))
  return missing.length ? `Nothing named for ${missing.join(', ')}. ${how}` : null
}
/** The map as HQ keeps it: ids in capitals, text trimmed, in the criteria's order. */
export function tidyProof(criteria: Criterion[], tests: ProofEntry[]): ProofEntry[] {
  const rank = (e: ProofEntry) => criteria.findIndex((c) => c.id === e.criterion)
  return tests.map((e) => {
    const criterion = String(e.criterion).trim().toUpperCase(), cant = e.cant_test?.trim()
    return cant ? { criterion, cant_test: cant } : { criterion, file: e.file!.trim().replace(/^\.\//, ''), name: e.name!.trim() }
  }).sort((a, b) => rank(a) - rank(b))
}

const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e)\//i, TEST_NAME = /[._-](test|spec)\.[a-z0-9]+$/i, TEST_PREFIX = /(^|\/)test_[^/]+\.py$/
/** Does this path look like a test, or something tests use? By its folder (test/, tests/, __tests__/, spec/, e2e/) or its name (x.test.js, x_test.go, test_x.py). */
export const isTestFile = (p: string): boolean => TEST_DIR.test(p) || TEST_NAME.test(p) || TEST_PREFIX.test(p)
/** A lockfile changes whenever its manifest does: not a file outside the plan when the manifest was expected. */
const LOCK_OF: Record<string, string> = { 'package-lock.json': 'package.json', 'yarn.lock': 'package.json', 'pnpm-lock.yaml': 'package.json', 'uv.lock': 'pyproject.toml',
  'bun.lock': 'package.json', 'bun.lockb': 'package.json', 'poetry.lock': 'pyproject.toml', 'Cargo.lock': 'Cargo.toml', 'go.sum': 'go.mod' }
const glob = (pattern: string): RegExp => new RegExp(`^${pattern.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`)
/** Does an entry of the TPM's expected_files cover this path? The path itself, a folder it's in, or a pattern with * (not across folders) or **. */
export function covers(expected: string, file: string): boolean {
  const e = expected.trim().replace(/^\.\//, '').replace(/\/+$/, ''); if (!e) return false
  return e === file || file.startsWith(`${e}/`) || (e.includes('*') && glob(e).test(file))
}
/** What to list for the user about a finished ticket's changes. `proofFiles`: the test files its map names, which count as tests whatever they're called. */
export function flagsFor(changed: Changed[], expected: string[], proofFiles: string[]): Flags {
  const test = (p: string) => isTestFile(p) || proofFiles.includes(p)
  const planned = (p: string) => expected.some((e) => covers(e, p)) || expected.some((e) => { const base = p.split('/').pop()!, m = LOCK_OF[base]
    return !!m && covers(e, p.slice(0, p.length - base.length) + m) })
  return {
    tests_deleted: changed.filter((c) => c.status === 'D' && isTestFile(c.path)).map((c) => c.path),
    tests_cut: changed.filter((c) => c.status === 'M' && test(c.path) && c.removed > 0).map((c) => ({ file: c.path, removed: c.removed })),
    outside: expected.length ? changed.filter((c) => !test(c.path) && !planned(c.path)).map((c) => c.path) : [], // no list from the TPM: nothing to compare with
  }
}
export const NO_FLAGS: Flags = { tests_deleted: [], tests_cut: [], outside: [] }
export const flagged = (f: Flags): boolean => f.tests_deleted.length + f.tests_cut.length + f.outside.length > 0

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// A line that says a test (or a test file) passed, as the runners print it. Captured through HQ's own sandbox, 2026-11-16: node --test (✔ name (1ms)),
// cargo (test path::name ... ok), go test -v (--- PASS: Name), pytest -rA / -v (PASSED file::name, file::name PASSED); 2026-11-23 (Bug 372): vitest 1.6, 2.1,
// 3.2 and 4.1 (✓ file (8 tests) 5ms, ✓ name 452ms), jest 30 (PASS file, ✓ name (1 ms)), mocha 11 (✔ name); by its docs: TAP (ok 1 - name). `pytest -q`
// and plain `go test` print none of these: HQ can't confirm a name there, and says so.
// Bug 411, through HQ's sandbox, 2026-11-25: pytest 9.2 -v (file::name PASSED / SKIPPED (reason)); Python 3.14's unittest -v and Django 5.2's `manage.py test -v 2`
// (`name (module.Class.name) ... ok`, `... skipped 'reason'`; Django's first one comes glued to the end of a migration's line, so these match at the line's end).
// Bug 427: a test marked as expected to fail. pytest 9.2 prints `XFAIL` for one that failed as expected (`file::name XFAIL (why)` with -v, `XFAIL file::name -
// why` and `XFAIL at setup of …` with -rA; also for `run=False` and `pytest.xfail()`), and Python 3.14's unittest `... expected failure`: it proves nothing,
// so it reads as skipped. pytest's `XPASS` (one that passed although marked, not strict) ran and its checks held, as pytest's own outcome says: a pass.
// A strict one prints FAILED (`[XPASS(strict)]` after it) and fails the run, as unittest's `... unexpected success` does: neither line is a pass.
const PASS_LINE = [/^\s*[✔✓√]\s/, /^\s*--- PASS: /, /^test .+ \.\.\. ok$/, /^\s*X?PASS(ED)?\s/, /\s(PASSED|XPASS)(\s|$)/, /^\s*ok \d+ /, /\) \.\.\. ok$/]
const SKIP_LINE = [/# (SKIP|TODO)\b/i, /^\s*[﹣↓○]\s/, /^\s*--- SKIP: /, /^test .+ \.\.\. ignored/, /^\s*(SKIPPED|XFAIL)\s/, /\s(SKIPPED|XFAIL)(\s|$)/,
  /\) \.\.\. (skipped\b|expected failure$)/,
  /^ {2,}- \S/] // mocha's pending test (`it.skip`): `  - name`, indented two more for each suite it's in (mocha 11.8 spec and list reporters; Bug 377)
// A line for a whole test file, not for one test. It proves that file ran and names no test, so it's never a sign that the runner lists tests by name
// (Bug 372: vitest's were read as that, and every named test "never ran"). Jest's `PASS test/a.test.js`; vitest's `✓ src/a.test.ts (8 tests | 1 skipped) 5ms`,
// which also says how many tests the file has: vitest's usual output names only the slow ones under it, its `tree` reporter every one. Bug 375: such a line
// proves only that the file's tests that ran passed. Vitest's says when some were skipped (`| 1 skipped`, `| 1 todo`); jest's says nothing, and only its
// summary does, for the whole run (`Tests:       1 skipped, 1 todo, 2 passed, 4 total`).
const JEST_FILE = /^\s*PASS\s/, VITEST_FILE = /\s\((\d+) tests?( \| [^)]*)?\)/, JEST_SKIPS = /^\s*Tests:\s.*\b[1-9]\d* (skipped|todo)\b/
// Bug 414: a line for ONE test that also names its file: pytest's node id (`tests/a.py::test_x SKIPPED (why)`, `-v`) and vitest's verbose reporter
// (`↓ src/a.test.ts > list > a skipped one`). It names the test, so it says nothing about the file's other tests: it neither passes the file nor makes it
// unsure. pytest -rA's skip summary (`SKIPPED [1] tests/a.py:8: why`) names no test, and still makes its file unsure (Bug 375).
const ONE_TEST = [/(?:^|\s)[^\s:]+\.[\p{L}\p{N}]+::\S/u, /^\s*↓\s+(?:\|[^|]*\|\s+)?\S+ > \S/]
const PATH_CHAR = /[\p{L}\p{N}_.@~/\\-]/u, PATH_GOES_ON = /^(?:[\p{L}\p{N}_/\\-]|\.[\p{L}\p{N}])/u
/** Does this line name the test file `file` (its path from the repo's root)? Whole, or as a runner started in a folder prints it: the end of that path
 *  (`src/a.test.ts` for `frontend/src/a.test.ts`, perhaps after `./` or `../`). The printed path must begin and end where that end does, so `b/a.test.ts`
 *  and `a.test.tsx` are other files. `folders` (Bug 376): the folders the test command starts its runners in, when HQ knows them (testFolders): then a
 *  line counts only for a file inside one of them, and an end of its path only from that folder down: `src/a.test.ts` from a run in web/ isn't admin/'s. */
export function namesFile(s: string, file: string, folders: string[] | null = null): boolean {
  const tails = (p: string): string[] => p ? [p, ...(p.includes('/') ? tails(p.slice(p.indexOf('/') + 1)) : [])] : []
  const inside = !folders ? '' : folders.find((d) => file.startsWith(`${d}/`))
  for (const tail of inside === undefined ? [] : inside ? [file, ...tails(file.slice(inside.length + 1))] : tails(file)) {
    for (let i = s.indexOf(tail); i >= 0; i = s.indexOf(tail, i + 1)) {
      const before = s.slice(0, i).replace(/(?:\.{1,2}\/)+$/, '').at(-1) ?? ' ' // a longer printed path (an absolute one) only counts for the whole of `file`
      if ((!PATH_CHAR.test(before) || (tail === file && before === '/')) && !PATH_GOES_ON.test(s.slice(i + tail.length, i + tail.length + 2))) return true
    }
  }
  return false
}
/** What to look for in a run's output: the names of a map's tests, and the files they are in. */
export type Watch = { names: string[]; files: string[] }
/** `unsure`: files a line showed with a skipped test in them, so their passing says nothing about a named test that isn't printed by name (Bug 375).
 *  `parts` (Bug 411): when HQ ran the test command part by part (one folder's suite at a time, testrun.ts), each part's folder ('.' for the project's root)
 *  and whether that part's own output listed its tests by name. `prints` is then true only when every part's did. */
export type Watched = { prints: boolean; passed: string[]; skipped: string[]; unsure: string[]; parts?: WatchedPart[] }
export type WatchedPart = { dir: string; prints: boolean }
/** The parts whose folder holds this file: the suites that could have run it. */
export const partsFor = (file: string, parts: WatchedPart[]): WatchedPart[] => parts.filter((p) => p.dir === '.' || file.startsWith(`${p.dir}/`))
/** Bug 411: what several parts' watchers saw, as one. One suite's output says nothing about another's tests: a part that lists names can't make a quiet
 *  part's tests read "never ran", and a part that counts many tests can't hide that another's named test didn't run. */
export function mergeWatched(seen: { dir: string; seen: Watched }[]): Watched {
  const all = (pick: (w: Watched) => string[]): string[] => [...new Set(seen.flatMap((s) => pick(s.seen)))], passed = all((w) => w.passed)
  return { prints: seen.length > 0 && seen.every((s) => s.seen.prints), passed, skipped: all((w) => w.skipped).filter((x) => !passed.includes(x)), unsure: all((w) => w.unsure),
    parts: seen.map((s) => ({ dir: s.dir, prints: s.seen.prints })) }
}
/** Watches a test run's output as it streams in for the tests a ticket's map names: which names (and which files) showed up on a line that says "passed", and
 *  which names on a line that says "skipped". `prints`: the runner listed the tests it ran by name, so a name that never showed up wasn't run. One passing
 *  test printed by name shows that, unless the runner's own file lines counted more tests than it named (vitest naming just its slow ones). Only a line for
 *  a whole file passes that file (Bug 414). A file named by a skip line that names no test, whose vitest line counts skipped tests, or whose jest PASS line
 *  is in a run with skipped tests, is `unsure`, never passed.
 *  `folders`: where the test command starts its runners, when HQ knows (namesFile). */
export function nameWatch(wanted: Watch, folders: string[] | null = null): { take: (chunk: string) => void; seen: () => Watched } {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))], names = uniq(wanted.names), files = uniq(wanted.files)
  const passed = new Set<string>(), skipped = new Set<string>(); let rest = '', named = 0, skips = 0, counted = 0
  const filesOk = new Set<string>(), byJest = new Set<string>(), unsure = new Set<string>(); let jestSkips = false
  const line = (raw: string) => {
    const s = shownLine(raw).replace(ANSI, '').trimEnd(); if (!s || s.length > 2000) return
    if (JEST_SKIPS.test(s)) { jestSkips = true; return }
    const skip = SKIP_LINE.some((re) => re.test(s)), pass = !skip && PASS_LINE.some((re) => re.test(s)); if (!skip && !pass) return
    const perFile = pass ? VITEST_FILE.exec(s) : null, jest = pass && !perFile && JEST_FILE.test(s)
    if (skip) skips++; else if (perFile) counted += Number(perFile[1]); else if (!jest) named++
    for (const w of names) if (s.includes(w)) (skip ? skipped : passed).add(w)
    // Bug 414: only a line for a whole file speaks for the tests in it HQ didn't see by name. One test's line passing made a test pytest -v never ran
    // read "passed" when the rest of its file passed, and one test's skip line made the file's unprinted tests "couldn't see it" instead of "never ran"
    const whole = skip ? !ONE_TEST.some((re) => re.test(s)) : !!perFile || jest
    if (whole) for (const f of files) if (namesFile(s, f, folders)) (skip || perFile?.[2] ? unsure : jest ? byJest : filesOk).add(f)
  }
  return {
    take: (chunk) => { const parts = (rest + chunk).split('\n'); rest = parts.pop() ?? ''; parts.forEach(line); if (rest.length > 4000) rest = '' },
    seen: () => { if (rest) { line(rest); rest = '' }
      if (jestSkips) byJest.forEach((f) => unsure.add(f))
      const ok = [...filesOk, ...byJest].filter((f) => !unsure.has(f))
      return { prints: named > 0 && named + skips >= counted, passed: [...new Set([...passed, ...ok])], skipped: [...skipped].filter((w) => !passed.has(w)),
        unsure: [...unsure] } },
  }
}
/** Every name and file a map's tests name: what nameWatch looks for. */
export function watchFor(tests: ProofEntry[]): Watch {
  const named = tests.filter((e) => !e.cant_test)
  return { names: named.map((e) => e.name ?? ''), files: named.map((e) => e.file ?? '') }
}
/** How HQ's run answered for one entry of the map; undefined for a criterion that can't be tested. A name seen skipped (and never passing) is skipped even
 *  when its file passed as a whole. One not printed, in a file shown with skipped tests, is unconfirmed: it may be one of those (Bug 375). */
export function confirm(e: ProofEntry, w: Watched): Confirmed | undefined {
  if (e.cant_test || !e.name) return undefined
  if (w.skipped.includes(e.name)) return 'skipped'
  if (w.passed.includes(e.name) || (!!e.file && w.passed.includes(e.file))) return 'passed'
  if (e.file && w.unsure.includes(e.file)) return 'unconfirmed'
  // Bug 411: run part by part, a name that never showed up wasn't run only when the suites that could hold its file listed their tests by name. A file in no
  // part's folder was run by nobody.
  const own = w.parts && e.file ? partsFor(e.file, w.parts) : null
  return (own ? own.every((p) => p.prints) : w.prints) ? 'not_run' : 'unconfirmed'
}
/** Bug 411: is this entry's file in a folder none of the test command's parts runs (and so the command, not the ticket, is what leaves it out)? Only known
 *  when HQ ran the command part by part. */
export const outsideParts = (e: ProofEntry, parts: WatchedPart[] | undefined, leftOut: LeftOut[] = []): boolean =>
  !!parts?.length && !!e.file && !partsFor(e.file, parts).length && !leftOutOf(e.file, leftOut)
/** What a project's test steps leave out on purpose, and why (teststepsstore.ts). */
export type LeftOut = { path: string; why: string }
/** The left-out entry this file is under, if any: its test can't be seen running, and no command of HQ's is missing a part for it. */
export const leftOutOf = (file: string | undefined, leftOut: LeftOut[]): LeftOut | undefined =>
  file ? leftOut.find((l) => l.path === '.' || file === l.path || file.startsWith(`${l.path}/`)) : undefined
const top = (file: string): string => file.includes('/') ? `${file.slice(0, file.indexOf('/'))}/` : 'the project\'s top folder'
const ranIn = (parts: WatchedPart[]): string => parts.map((p) => p.dir === '.' ? 'the top folder' : `${p.dir}/`).join(', ')
/** The entries HQ's passing run didn't prove: skipped, or never run. One line each, for the engineer the ticket goes back to. `parts`: the folders the
 *  command's parts ran in, when HQ ran it part by part: a test in none of them gets told so (Bug 411: "put it where that command runs it" had an engineer wrap
 *  a backend's tests in the frontend's runner). `leftOut`: what the project's test steps leave out on purpose: a test there can't be seen, and says why. */
export function unproven(tests: Proof['tests'], cmd: string, parts?: WatchedPart[], leftOut: LeftOut[] = []): string[] {
  const left = (e: ProofEntry): LeftOut | undefined => leftOutOf(e.file, leftOut)
  return tests.flatMap((e) => e.state === 'skipped' ? [`${e.criterion}: "${e.name}" in ${e.file} was skipped, so nothing proved ${e.criterion}. Make it run, or name a test that does.`]
    : e.state !== 'not_run' ? []
    : left(e) ? [`${e.criterion}: "${e.name}" in ${e.file} never ran: HQ's test steps leave ${left(e)!.path} out (${left(e)!.why}), so HQ can't see it run. `
      + `Name a test for ${e.criterion} that HQ's test command runs, or give the reason it can't be tested (cant_test).`]
    : outsideParts(e, parts) ? [`${e.criterion}: "${e.name}" in ${e.file} never ran: HQ's test command runs nothing in ${top(e.file!)} (it runs ${ranIn(parts!)}).`]
    : [`${e.criterion}: "${e.name}" in ${e.file} never ran. \`${cmd}\` listed other tests and not this one: put it where that command runs it.`])
}

/** The check's words for named tests that are no reason to send the ticket back: every one ran, or the run passed and HQ couldn't see some by name
 *  (Bug 372: that read "Every test … ran" too, which nobody had seen). */
export function ranWords(tests: Proof['tests']): string {
  const named = tests.filter((e) => !e.cant_test), unseen = named.filter((e) => e.state === 'unconfirmed').length, none = tests.length - named.length
  const noTest = none ? ` (${none} of them ${none === 1 ? 'has' : 'have'} no test)` : ''
  const which = unseen < named.length ? `${unseen} of the ${named.length} tests` : unseen === 1 ? 'the test' : 'the tests'
  return unseen ? `The tests passed, but HQ couldn't see ${which} named for its criteria by name${noTest}.`
    : `Every test named for its criteria ran${noTest}.`
}

const list = (xs: string[], max = 4): string => xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', ')
/** What's worth a look on a finished ticket, one plain line each, for the run's summary and the Ticket tab: criteria with no test, tests HQ couldn't see by
 *  name, and what git flagged. Empty when there's nothing. */
export function lookLines(p: Proof | null): string[] {
  if (!p) return []
  const cant = p.tests.filter((e) => e.cant_test), unseen = p.tests.filter((e) => e.state === 'unconfirmed').map((e) => e.criterion)
  return [
    ...cant.map((e) => `${e.criterion} has no test: ${e.cant_test}`),
    unseen.length ? `tests passed, but HQ couldn't see ${list([...new Set(unseen)])}'s by name: the test command doesn't print every test's name` : '',
    ...flagLines(p.flags),
  ].filter(Boolean)
}
/** What git flagged about a finished ticket's changes, one plain line each. */
export function flagLines(f: Flags): string[] {
  return [
    f.tests_deleted.length ? `deleted tests: ${list(f.tests_deleted)}` : '',
    f.tests_cut.length ? `took lines out of existing tests: ${list(f.tests_cut.map((c) => `${c.file} (${c.removed})`))}` : '',
    f.outside.length ? `changed files outside the ones planned for it: ${list(f.outside)}` : '',
  ].filter(Boolean)
}
/** One criterion's proof in a few words, for the Ticket tab. `tone`: good, something to look at, or nothing known yet. */
export function proofWords(e: (ProofEntry & { state?: Confirmed }) | undefined): { text: string; tone: 'ok' | 'look' | 'none' } {
  if (!e) return { text: 'no test named yet', tone: 'none' }
  if (e.cant_test) return { text: `no test: ${e.cant_test}`, tone: 'look' }
  const where = `${e.file} · "${e.name}"`
  return e.state === 'passed' ? { text: `${where} · passed in HQ's test run`, tone: 'ok' }
    : e.state === 'skipped' ? { text: `${where} · skipped in HQ's test run`, tone: 'look' }
    : e.state === 'not_run' ? { text: `${where} · HQ's test command didn't run it`, tone: 'look' }
    : e.state === 'unconfirmed' ? { text: `${where} · in a passing run; the test command doesn't print every test's name, so HQ couldn't confirm it`, tone: 'look' }
    : { text: `${where} · HQ hasn't tested it yet`, tone: 'none' }
}

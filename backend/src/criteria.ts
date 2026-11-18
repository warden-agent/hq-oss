// Acceptance criteria HQ can check. Auto mode merges with nobody watching, and "the old tests still pass" let a ticket with no tests of its own through. So the
// TPM gives each ticket its criteria as a list (A1, A2…, each for the screen or behind it), and at open_pr the engineer names, for each one, the test that proves
// it, or says why none can. HQ checks that with git (proof.ts) and, as auto mode tests the ticket, against what its own run printed. No model, no tokens.
// Pure: no DB, no git, no files. The page imports it too, so the board and the backend say the same words. What a criterion may not say (a file, code, words
// too vague to check) is criteriawords.ts.
import { wordingProblems } from './criteriawords.ts'

export type Criterion = { id: string; kind: 'ui' | 'backend'; text: string }
/** What open_pr gives for one criterion: the test that proves it (its file, and its name as written there), or why nothing can test it. */
export type ProofEntry = { criterion: string; file?: string; name?: string; cant_test?: string }
/** How HQ's own test run answered for one named test. `passed`: the run printed it (or its file) as passing. `skipped`: printed as skipped. `not_run`: the run
 *  printed other tests by name and never this one. `unconfirmed`: the run passed and prints no test names (`pytest -q`, `go test`), so HQ can't tell by name. */
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
  'poetry.lock': 'pyproject.toml', 'Cargo.lock': 'Cargo.toml', 'go.sum': 'go.mod' }
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
// cargo (test path::name ... ok), go test -v (--- PASS: Name), pytest -rA / -v (PASSED file::name, file::name PASSED); and by their docs: jest and vitest
// (✓ name, PASS file), mocha (✓ name), TAP (ok 1 - name). `pytest -q` and plain `go test` print none of these: HQ can't confirm a name there, and says so.
const PASS_LINE = [/^\s*[✔✓√]\s/, /^\s*--- PASS: /, /^test .+ \.\.\. ok$/, /^\s*PASS(ED)?\s/, /\sPASSED(\s|$)/, /^\s*ok \d+ /]
const SKIP_LINE = [/# (SKIP|TODO)\b/i, /^\s*[﹣↓○]\s/, /^\s*--- SKIP: /, /^test .+ \.\.\. ignored/, /^\s*SKIPPED\s/, /\sSKIPPED(\s|$)/]
/** A file-level line only (jest's `PASS test/a.test.js`): it proves that file ran, and says nothing about whether the runner prints test names. */
const FILE_ONLY = /^\s*PASS\s/
export type Watched = { prints: boolean; passed: string[]; skipped: string[] }
/** Watches a test run's output as it streams in for the tests a ticket's map names: which names (and which files) showed up on a line that says "passed", and
 *  which names on a line that says "skipped". `prints`: the runner printed at least one passing test by name, so a name that never showed up wasn't run. */
export function nameWatch(wanted: string[]): { take: (chunk: string) => void; seen: () => Watched } {
  const want = [...new Set(wanted.filter(Boolean))], passed = new Set<string>(), skipped = new Set<string>(); let rest = '', prints = false
  const line = (raw: string) => {
    const s = raw.replace(ANSI, '').trimEnd(); if (!s || s.length > 2000) return
    const skip = SKIP_LINE.some((re) => re.test(s)), pass = !skip && PASS_LINE.some((re) => re.test(s)); if (!skip && !pass) return
    if (pass && !FILE_ONLY.test(s)) prints = true
    for (const w of want) if (s.includes(w)) (skip ? skipped : passed).add(w)
  }
  return {
    take: (chunk) => { const parts = (rest + chunk).split('\n'); rest = parts.pop() ?? ''; parts.forEach(line); if (rest.length > 4000) rest = '' },
    seen: () => { if (rest) { line(rest); rest = '' } return { prints, passed: [...passed], skipped: [...skipped].filter((w) => !passed.has(w)) } },
  }
}
/** Every name and file a map's tests name: what nameWatch looks for. */
export const watchFor = (tests: ProofEntry[]): string[] => tests.flatMap((e) => e.cant_test ? [] : [e.name ?? '', e.file ?? ''])
/** How HQ's run answered for one entry of the map; undefined for a criterion that can't be tested. A name seen skipped (and never passing) is skipped even
 *  when its file passed as a whole. */
export function confirm(e: ProofEntry, w: Watched): Confirmed | undefined {
  if (e.cant_test || !e.name) return undefined
  if (w.skipped.includes(e.name)) return 'skipped'
  if (w.passed.includes(e.name) || (!!e.file && w.passed.includes(e.file))) return 'passed'
  return w.prints ? 'not_run' : 'unconfirmed'
}
/** The entries HQ's passing run didn't prove: skipped, or never run. One line each, for the engineer the ticket goes back to. */
export function unproven(tests: Proof['tests'], cmd: string): string[] {
  return tests.flatMap((e) => e.state === 'skipped' ? [`${e.criterion}: "${e.name}" in ${e.file} was skipped, so nothing proved ${e.criterion}. Make it run, or name a test that does.`]
    : e.state === 'not_run' ? [`${e.criterion}: "${e.name}" in ${e.file} never ran. \`${cmd}\` listed other tests and not this one: put it where that command runs it.`] : [])
}

const list = (xs: string[], max = 4): string => xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', ')
/** What's worth a look on a finished ticket, one plain line each, for the run's summary and the Ticket tab: criteria with no test, tests HQ couldn't see by
 *  name, and what git flagged. Empty when there's nothing. */
export function lookLines(p: Proof | null): string[] {
  if (!p) return []
  const cant = p.tests.filter((e) => e.cant_test), unseen = p.tests.filter((e) => e.state === 'unconfirmed').map((e) => e.criterion)
  return [
    ...cant.map((e) => `${e.criterion} has no test: ${e.cant_test}`),
    unseen.length ? `tests passed, but HQ couldn't see ${list([...new Set(unseen)])}'s by name: the test command doesn't print test names` : '',
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
    : e.state === 'unconfirmed' ? { text: `${where} · in a passing run; the test command prints no names, so HQ couldn't confirm it`, tone: 'look' }
    : { text: `${where} · HQ hasn't tested it yet`, tone: 'none' }
}

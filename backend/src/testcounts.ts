// Bug 126: how many tests a run passed and skipped, read from the summary lines test runners print. A merged ticket says what HQ ran on it and how it ended,
// and "tests passed" says nothing about the tests that were skipped. Only the summary formats seen in real output (captured through runSandboxed, 2026-11-16):
// node --test, pytest, unittest, cargo, jest, vitest, mocha. Anything else gives null and the page shows no counts: never a guessed "0 skipped".
// go test prints no counts without -v, so it gives null too.
// Bug 384: todo tests (vitest `| 1 todo`, jest `1 todo`, node `ℹ todo 1`) are a count of their own, as the runners print them: neither passed nor skipped,
// and one makes its file's named tests read "couldn't confirm it" (Bug 375), so the tests line says why. `todo` is there only when some were.

export type Counts = { passed: number; failed: number; skipped: number; todo?: number }
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
/** What a terminal shows of one line of a run's output: what was written after the line's last carriage return, drawn over what came before it. A runner that
 *  redraws its line prints `\r` and the new text (mocha's `list` reporter, with no terminal: `title: \r  ✔ title: 0ms`, Bug 383); a `\r` at the end (`\r\n`)
 *  redraws nothing. HQ's readers of a run's output (the name watcher, the summary lines, failureLines, failedLine) all read a line this way, so they agree. */
export const shownLine = (raw: string): string => { const s = raw.replace(/\r+$/, ''); return s.slice(s.lastIndexOf('\r') + 1) }
const NODE = /^[ℹ#] (pass|fail|skipped|cancelled|todo) (\d+)$/
const PYTEST = /^=*\s*(\d+ [a-z]+(?:, \d+ [a-z]+)*) in [\d.]+s\b/
const JEST = /^Tests:\s+(\d+ [a-z]+(?:, \d+ [a-z]+)*)$/
// Bug 426: vitest 4 says `1 expected fail` for a `test.fails` that failed as it should: two words, and neither a pass nor a failure (pairs reads one word)
const VITEST = /^Tests\s+(\d+ [a-z]+(?: [a-z]+)?(?: \| \d+ [a-z]+(?: [a-z]+)?)*) \(\d+\)$/
const CARGO = /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;/
const RAN = /^Ran (\d+) tests? in /, UNITTEST_END = /^(OK|FAILED)(?: \((.+)\))?$/
const MOCHA = /^(\d+) (passing|failing|pending)(?: \(.+\))?$/
const ANY = [NODE, PYTEST, JEST, VITEST, CARGO, RAN, UNITTEST_END, MOCHA]
const KEEP = 400 // a run with more summaries than this (a monorepo of hundreds of crates) gets no counts: some were dropped

/** Keeps the summary lines of a run's output as it streams in: a chained command prints one summary per part, and the first ones are long gone from the
 *  output's tail by the end. `lines()`: null when there were too many to keep. */
export function summaryLines(): { take: (chunk: string) => void; lines: () => string[] | null } {
  const kept: string[] = []; let rest = '', over = false
  const line = (raw: string) => {
    const s = shownLine(raw).replace(ANSI, '').trim()
    if (s.length > 200 || !ANY.some((re) => re.test(s))) return
    if (kept.length < KEEP) kept.push(s); else over = true
  }
  return {
    take: (chunk) => { const s = rest + chunk, parts = s.split('\n'); rest = parts.pop() ?? ''; parts.forEach(line); if (rest.length > 4000) rest = '' },
    lines: () => { if (rest) { line(rest); rest = '' } return over ? null : kept },
  }
}

/** The passed, failed, skipped and todo tests the summary lines add up to, over every summary (one per part of a chained command); null when none was recognised. */
export function testCounts(lines: string[] | null): Counts | null {
  if (!lines) return null
  const c: Counts = { passed: 0, failed: 0, skipped: 0 }; let found = false, ran: number | null = null, todo = 0
  const add = (word: string, n: number) => {
    if (/^(passed|passing|pass)$/.test(word)) c.passed += n
    else if (/^(failed|failing|fail|errors?|error|cancelled)$/.test(word)) c.failed += n
    else if (/^(skipped|pending|ignored)$/.test(word)) c.skipped += n
    else if (word === 'todo') todo += n
    else return
    found = true
  }
  const pairs = (s: string, sep: RegExp) => { for (const p of s.split(sep)) { const m = /^(\d+) ([a-z]+)$/.exec(p.trim()); if (m) add(m[2]!, Number(m[1])) } }
  for (const s of lines) {
    let m: RegExpExecArray | null
    if ((m = NODE.exec(s))) add(m[1]!, Number(m[2]))
    else if ((m = CARGO.exec(s))) { add('passed', Number(m[1])); add('failed', Number(m[2])); add('skipped', Number(m[3])) }
    else if ((m = PYTEST.exec(s)) || (m = JEST.exec(s))) pairs(m[1]!, /,/)
    else if ((m = VITEST.exec(s))) pairs(m[1]!, /\|/)
    else if ((m = MOCHA.exec(s))) add(m[2]!, Number(m[1]))
    else if ((m = RAN.exec(s))) ran = Number(m[1])
    else if ((m = UNITTEST_END.exec(s)) && ran !== null) { // "Ran 3 tests" then "OK (skipped=1)" or "FAILED (failures=1, errors=1)"
      const by = Object.fromEntries((m[2] ?? '').split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, Number(v)]))
      const failed = (by.failures ?? 0) + (by.errors ?? 0), skipped = by.skipped ?? 0
      c.failed += failed; c.skipped += skipped; c.passed += Math.max(0, ran - failed - skipped - (by['expected failures'] ?? 0)); found = true; ran = null
    }
  }
  return !found ? null : todo ? { ...c, todo } : c
}

/** Counts in words, as the page says them: "412 passed, 6 skipped, 1 todo". Failed only when some did (a passing run with failures is a runner's own
 *  choice); skipped and todo only when there are some. */
export const countWords = (c: Counts): string =>
  [`${c.passed} passed`, c.failed ? `${c.failed} failed` : '', c.skipped ? `${c.skipped} skipped` : '', c.todo ? `${c.todo} todo` : ''].filter(Boolean).join(', ')
/** How long a run took: "under 1 s", "8 s", "2 min 5 s". */
export const took = (ms: number): string => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return !s ? 'under 1 s' : m ? `${m} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s` }

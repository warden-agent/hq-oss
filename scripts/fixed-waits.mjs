// Counts the places where a test pauses for a fixed time, and fails when there are more than scripts/fixed-waits.baseline allows, so the counts
// only go down. A test that sleeps and then checks passes on a quiet machine and fails on a busy one, or passes when it shouldn't because nothing
// had happened yet: tests wait for a state (waitFor) or for one of HQ's looks to have run (hq.beats), not for time.
//
// What counts, in backend/e2e/*.ts and backend/src/*.test.ts:
//   sleep     `new Promise((r) => setTimeout(r, …))` written out where the test pauses
//   helper    a call to one of the file's own sleep helpers. A helper is found from its definition: a one-line `const wait = (ms) => new Promise(…
//             setTimeout…)`, or a one-line function that pauses inside (`const kept = async (…) => { await wait(1600); … }`). Its calls count, not its definition.
//   pending   `pendingAfter(promise, ms)`: "still not settled after ms" is a pause too
// What doesn't: a pause inside a loop (a poll: it ends as soon as its condition holds), and anything inside a string (`sleep 600` is a dummy process).
//
// A pause that has to stay says why, in a comment on its own line or the line above, starting with one of LABELS (`// limit: the stop delay is 2 s`).
// Labelled and unlabelled pauses are counted apart, and each has its number in the baseline. `--list` prints every place.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const LABELS = ['limit', 'window', 'real-time', 'hold']
const SLEEP = /new Promise(?:<[^>]*>)?\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*(?:void\s+)?setTimeout\(\s*\1\b/g
const DEFINES = /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:<[^>]*>\s*)?\([^)]*\)\s*(?::\s*[^=]+?)?=>\s*(.*)$/
const LOOP = /\b(?:for|while)\s*\(|\bdo\s*\{/
const LABEL = new RegExp(`//\\s*(${LABELS.join('|')}):`)

/** The line with what is inside quotes blanked (same length), and its `//` comment apart. Template strings can run over lines: `inTemplate` carries that. */
function strip(line, inTemplate) {
  let code = '', comment = '', quote = inTemplate ? '`' : ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === '\\') { code += '  '; i++; continue } if (c === quote) { quote = ''; code += c } else code += ' '; continue }
    if (c === '/' && line[i + 1] === '/') { comment = line.slice(i); break }
    if (c === "'" || c === '"' || c === '`') quote = c
    code += c
  }
  return { code, comment, inTemplate: quote === '`' }
}

/** Every fixed pause in one file's text: `{ line, kind, label }`, line from 1, label null when it has none. */
export function pauses(text) {
  const lines = text.split('\n'), stripped = []; let tpl = false
  for (const l of lines) { const s = strip(l, tpl); tpl = s.inTemplate; stripped.push(s) }
  // The file's sleep helpers, to a fixed point: one that pauses by calling another is one too
  const helpers = new Map() // name -> its definition's line index
  const calls = (code) => [...helpers.keys()].flatMap((n) => [...code.matchAll(new RegExp(`(?<![.\\w])${n}\\(`, 'g'))].map((m) => m.index))
  for (let grew = true; grew;) {
    grew = false
    stripped.forEach(({ code }, i) => {
      const d = DEFINES.exec(code); if (!d || d[1] === 'pendingAfter' || helpers.has(d[1]) || LOOP.test(d[2])) return // pendingAfter's calls count as `pending`
      if ([...d[2].matchAll(SLEEP)].length || calls(d[2]).length) { helpers.set(d[1], i); grew = true }
    })
  }
  const defined = new Set(helpers.values()), blank = (x) => /^\s*$/.test(x ?? '')
  const out = [], loops = [] // loops: the brace depths at which a loop's block opened and hasn't closed
  let depth = 0
  stripped.forEach(({ code, comment }, i) => {
    const above = i > 0 && blank(stripped[i - 1].code) ? stripped[i - 1].comment : ''
    const label = LABEL.exec(comment)?.[1] ?? LABEL.exec(above)?.[1] ?? null
    const marks = defined.has(i) || /^\s*import\b/.test(code) || /\bconst\s+pendingAfter\b/.test(code) ? [] : [
      ...[...code.matchAll(SLEEP)].map((m) => ({ at: m.index, kind: 'sleep' })), ...calls(code).map((at) => ({ at, kind: 'helper' })),
      ...[...code.matchAll(/(?<![.\w])pendingAfter\(/g)].map((m) => ({ at: m.index, kind: 'pending' }))].sort((a, b) => a.at - b.at)
    // Walk the line. A pause is a poll, and not counted, inside a loop: in its header, in its block (which may run over lines), or in the one
    // statement of a loop with no block (`while (busy()) await wait(5)`, to the next `;`)
    let paren = 0, header = -1, after = false, blockNext = false, body = false, m = 0
    for (let c = 0; c < code.length; c++) {
      const ch = code[c]
      if (after && ch !== ' ') { after = false; if (ch === '{') blockNext = true; else body = true }
      while (m < marks.length && marks[m].at === c) { if (!loops.length && header < 0 && !body) out.push({ line: i + 1, kind: marks[m].kind, label }); m++ }
      if (!/[\w.$]/.test(code[c - 1] ?? '')) {
        if (/^(?:for|while)\s*\(/.test(code.slice(c, c + 12)) && header < 0) header = paren
        else if (/^do\s*\{/.test(code.slice(c, c + 6))) blockNext = true
      }
      if (ch === '(') paren++
      else if (ch === ')') { paren--; if (header >= 0 && paren === header) { header = -1; after = true } }
      else if (ch === '{') { depth++; if (blockNext) { loops.push(depth); blockNext = false } }
      else if (ch === '}') { if (loops.at(-1) === depth) loops.pop(); depth-- }
      else if (ch === ';' && paren === 0) body = false
    }
  })
  return out
}

const root = path.resolve(import.meta.dirname, '..')
/** The test files: tracked ones under backend/e2e (the harness too) and the unit tests. */
export const testFiles = () => execFileSync('git', ['ls-files', 'backend/e2e/*.ts', 'backend/src/*.test.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
/** `{ unlabelled, labelled }` from the baseline file's two lines. */
export const readBaseline = (text) => ({ unlabelled: Number(/^unlabelled\s+(\d+)$/m.exec(text)?.[1] ?? NaN), labelled: Number(/^labelled\s+(\d+)$/m.exec(text)?.[1] ?? NaN) })
/** What the check says and whether it fails, from the counts and the baseline. */
export function verdict(now, base) {
  const lines = [`Fixed waits in tests: ${now.unlabelled} with no reason given (baseline ${base.unlabelled}), ${now.labelled} with one (baseline ${base.labelled})`]
  const over = []
  if (!(now.unlabelled <= base.unlabelled)) {
    over.push(`${now.unlabelled - base.unlabelled} more with no reason than the baseline: wait for a state (waitFor) or for one of HQ's looks (hq.beats), not for time.`)
  }
  if (!(now.labelled <= base.labelled)) {
    over.push(`${now.labelled - base.labelled} more with a reason than the baseline: `
      + 'if the pause has to be there, raise "labelled" in scripts/fixed-waits.baseline in the same commit.')
  }
  const under = []
  if (now.unlabelled < base.unlabelled) under.push(`unlabelled ${now.unlabelled}`); if (now.labelled < base.labelled) under.push(`labelled ${now.labelled}`)
  return { lines, over, under: under.length ? `Below the baseline: set scripts/fixed-waits.baseline to ${under.join(' and ')}.` : '' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const all = testFiles().map((f) => ({ f, found: pauses(fs.readFileSync(path.join(root, f), 'utf8')) })).filter((x) => x.found.length)
  const flat = all.flatMap((x) => x.found), now = { unlabelled: flat.filter((p) => !p.label).length, labelled: flat.filter((p) => p.label).length }
  const v = verdict(now, readBaseline(fs.readFileSync(path.join(import.meta.dirname, 'fixed-waits.baseline'), 'utf8')))
  console.log(v.lines.join('\n'))
  if (process.argv.includes('--list')) for (const x of all) for (const p of x.found) console.log(`  ${x.f}:${p.line}  ${p.kind}${p.label ? `  (${p.label})` : ''}`)
  else for (const x of all.sort((a, b) => b.found.length - a.found.length).slice(0, 10)) console.log(`  ${String(x.found.length).padStart(3)}  ${x.f}`)
  if (v.over.length) { console.error(`\n${v.over.join('\n')}\n(node scripts/fixed-waits.mjs --list shows each place)`); process.exit(1) }
  if (v.under) console.log(`\n${v.under}`)
}

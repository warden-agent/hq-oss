// A test reporter that fails the run when a test file did not run all of itself (Bug 291). node's runner calls a file a pass when
// its process exits 0, whatever it reported: a file that stopped part-way (something called process.exit(0) in a test), or whose
// later tests were never declared (--test-force-exit ends a file once the tests it knows of are done, so tests after a top-level
// `await` are dropped when the earlier ones finish first), left its missing tests out of the count and the run said OK.
// own-tmp.mjs adds it next to the usual reporter for `npm test` and `npm run e2e`. It says nothing when every file is whole.
// A file is whole when: it sent its own end-of-file summary; every test it started finished; and it ran at least as many top-level
// tests as its text declares. The last check is skipped when the run was asked for part of the tests (a name pattern, a shard, only).
import fs from 'node:fs'
import path from 'node:path'

/** How many top-level tests a file's text declares: lines that begin with `test(`, `it(`, `describe(` or `suite(` (and their
 *  `.skip`/`.todo`/`.only` forms). Lines inside a template string don't count (a test file written out as a fixture), nor does a
 *  test made in a loop or an `if`: the file may run more than this, never fewer. */
export function declared(text) {
  let n = 0, inTemplate = false
  for (const line of text.split('\n')) {
    if (!inTemplate && /^(test|it|describe|suite)(\.(skip|todo|only))?\(/.test(line)) n++
    if ((line.match(/(?<!\\)`/g) ?? []).length % 2) inTemplate = !inTemplate
  }
  return n
}

const PART = /^--test-(name-pattern|skip-pattern|shard|only)\b/ // the run was asked for some of the tests: fewer than declared is right
/** What is wrong with each file, from what the runner was told about it. `files`: file → { started, finished, top (null: no summary), last (test started) }. */
export function problems(files, { part = false, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const out = []
  for (const [file, f] of files) {
    const name = path.relative(process.cwd(), file)
    if (f.top === null) {
      out.push(`${name} stopped before its end: it never sent its end-of-file summary (${f.finished} of its tests were reported${f.last ? `; the last it started was "${f.last}"` : ''})`)
      continue
    }
    if (f.started > f.finished) out.push(`${name}: ${f.started - f.finished} of its tests started and never finished`)
    let want = 0; try { want = declared(read(file)) } catch { /* not a file we can read: nothing to compare with */ }
    if (!part && f.top < want) out.push(`${name} ran ${f.top} of the ${want} tests it declares: the rest were never run`)
  }
  return out
}

export default async function* wholeFiles(source) {
  const files = new Map(), of = (file) => { if (!files.has(file)) files.set(file, { started: 0, finished: 0, top: null, last: '' }); return files.get(file) }
  // a file that reports no test of its own is reported as one test, named as the file was given: that one is the runner's, not the file's
  const itself = (d) => d.nesting === 0 && [d.file, path.relative(process.cwd(), d.file), path.basename(d.file)].includes(d.name)
  for await (const { type, data } of source) {
    // only what a file's tests and its summary say: what a file prints (a warning on stderr, say) comes as an item too, under the file's
    // name as it was given, not its full path, and counted as a file of its own it would be one that never sent a summary
    if (!data?.file || !['test:start', 'test:pass', 'test:fail', 'test:summary'].includes(type)) continue
    const f = of(path.resolve(data.file))
    if (type === 'test:summary') f.top = data.counts?.topLevel ?? 0
    else if (itself(data)) continue
    else if (type === 'test:start') { f.started++; f.last = String(data.name ?? '') }
    else f.finished++
  }
  const found = problems(files, { part: process.execArgv.some((a) => PART.test(a)) })
  if (!found.length) return
  process.exitCode = 1
  yield `\n✖ ${found.length === 1 ? 'A test file' : `${found.length} test files`} did not run whole, so this run fails (scripts/whole-files.mjs, Bug 291):\n`
  for (const p of found) yield `  ${p}\n`
}

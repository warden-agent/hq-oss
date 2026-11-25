// Bugs 315, 341, 366: a button whose job opened HQ's dialog first read busy ("Merging…", "Starting…", "Undoing…", a dimmed ✕) while the dialog was
// still up and nothing had happened yet. The dialog now goes in the `ask` step of useBusy / ActBtn (board.ts), which runs before the button
// reads busy. This scans the page's code so a new button can't put a dialog back inside its job. The pages were checked in a headless browser
// (Merge into main, Try it with another app on, with a one-off script).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const dir = new URL('../../frontend/src/', import.meta.url)
const src = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8')
const tsx = fs.readdirSync(dir).filter((f) => f.endsWith('.tsx'))

/** The text from `open` (an index of "(" or "{") to its matching close, strings and template literals skipped roughly. */
function balanced(s: string, open: number): string {
  let depth = 0, q: string | null = null
  for (let i = open; i < s.length; i++) {
    const c = s[i]!
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue }
    if (c === "'" || c === '"' || c === '`') q = c
    else if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') { depth--; if (!depth) return s.slice(open, i + 1) }
  }
  return s.slice(open)
}
/** A call's first argument: `(job, ask)` → `job`. */
function firstArg(call: string): string {
  let depth = 0, q: string | null = null
  for (let i = 1; i < call.length - 1; i++) {
    const c = call[i]!
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue }
    if (c === "'" || c === '"' || c === '`') q = c
    else if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    else if (c === ',' && !depth) return call.slice(1, i)
  }
  return call.slice(1, -1)
}
/** The functions that open HQ's dialog: board.ts's helpers that call its `ask`, and the pages' own wrappers of them (launchOnly). */
function dialogHelpers(): string[] {
  const board = src('board.ts'), names = new Set<string>()
  for (const m of board.matchAll(/\nexport (?:async )?(?:function (\w+)|const (\w+) = )/g)) {
    const at = m.index! + 1, end = board.slice(at + 1).search(/\n(export |function |const |\/\*\*)/), body = board.slice(at, end < 0 ? undefined : at + 1 + end)
    if (/[^.\w]ask\(/.test(body)) names.add((m[1] ?? m[2])!)
  }
  for (const f of tsx) for (const m of src(f).matchAll(/\nconst (\w+) = \([^)]*\)(?:: [^=]+)? => (\w+)\(/g)) if (names.has(m[2]!)) names.add(m[1]!)
  return [...names]
}
/** Every busy job in `code`: ActBtn's `run={…}` and the job given to a useBusy runner (`const [busy, go] = useBusy()` → `go(job, ask)`). A job
 *  named by a local `const` is looked up, so `run={go}` checks go's body. */
function jobs(code: string): string[] {
  const out: string[] = [], local = (x: string) => {
    const id = x.trim(); if (!/^\w+$/.test(id)) return x
    const d = code.search(new RegExp(`const ${id} = `)); if (d < 0) return x
    const rest = code.slice(d), arrow = rest.indexOf('=>'), body = rest.slice(arrow + 2).trimStart()
    return body.startsWith('{') ? balanced(body, 0) : body.split('\n')[0]!
  }
  for (const m of code.matchAll(/\srun=\{/g)) out.push(local(balanced(code, m.index! + m[0].length - 1).slice(1, -1)))
  const runners = [...code.matchAll(/const \[\w+, (\w+)\] = useBusy\(\)/g)].map((m) => m[1]!)
  for (const r of new Set(runners)) for (const m of code.matchAll(new RegExp(`[^.\\w]${r}\\(`, 'g'))) {
    const call = balanced(code, m.index! + m[0].length - 1); if (/^\(\s*\)$/.test(call)) continue
    out.push(local(firstArg(call)))
  }
  return out
}
/** A file cut at its top-level declarations, so a job's name is looked up in its own component. */
const parts = (code: string): string[] => code.split(/\n(?=(?:export )?(?:async )?(?:function|const|let) )/)
const opensDialog = (job: string, helpers: string[]) => helpers.find((h) => new RegExp(`[^.\\w]${h}\\(`).test(` ${job}`))

test('Bugs 315, 341: no busy job opens a dialog: it goes in the ask step, so the button reads busy only after the user says yes', () => {
  const helpers = dialogHelpers()
  for (const h of ['stopOthers', 'mergeConfirm', 'cancelConfirm', 'freshConfirm', 'undoConfirm', 'portConfirm', 'launchOnly']) assert.ok(helpers.includes(h), `${h} is known as a dialog`)
  let n = 0
  for (const f of tsx) for (const part of parts(src(f))) for (const j of jobs(part)) {
    n++; const h = opensDialog(j, helpers); assert.equal(h, undefined, `${f}: a busy job opens ${h}'s dialog: ${j.slice(0, 160)}`)
  }
  assert.ok(n > 40, `the scan finds the page's busy jobs (${n})`)
})

test('Bug 341: Merge into main, Try it, ✕, ⟳, OK Claude\'s new steps and Undo this run ask first', () => {
  const nodes = src('Nodes.tsx'), preview = src('Preview.tsx'), auto = src('Auto.tsx')
  assert.match(nodes, /label=\{`Merge into \$\{a\.into\}`\} busyLabel="Merging…" run=\{\(\) => api\(`tickets\/\$\{t\.id\}\/merge`, \{\}\)\}\s+ask=\{\(\) => mergeConfirm\(/)
  assert.match(nodes, /label="Try it" busyLabel="Starting…" run=\{go\} ask=\{\(\) => stopOthers\(/)
  assert.match(nodes, /run\(\(\) => api\(path, \{\}\), \(\) => cancelConfirm\(/)
  assert.match(nodes, /run\(\(\) => api\(`agents\/\$\{a\.id\}\/fresh-start`, \{\}\), \(\) => freshConfirm\(/)
  assert.match(preview, /ask=\{\(\) => launchOnly\(all, repo\)\} run=\{\(\) => api\(`previews\/\$\{p\.id\}\/approve`/)
  assert.match(auto, /go\(\(\) => api\(`auto-runs\/\$\{run\.id\}\/undo`[^\n]*, sure\)/)
})

test('Bugs 315, 341: what the scan must catch, and what it must not', () => {
  const helpers = dialogHelpers()
  // the old Merge into main, Try it and ✕: caught
  const old = [
    "const go = async () => { if (await mergeConfirm(t, a, 'x')) await api(`tickets/${t.id}/merge`, {}) }\n  return <ActBtn label=\"Merge\" run={go} />",
    "const go = async () => {\n  if (!(await stopOthers(s, id, { title: 'Try', go: 'Try it' }))) return\n  await api('x', {})\n}\nreturn <ActBtn label=\"Try it\" run={go} />",
    "const [busy, run] = useBusy()\n  return <button onClick={() => run(async () => { if (await cancelConfirm(title, body, go)) await api(path, {}) })}>✕</button>",
  ]
  for (const code of old) assert.ok(jobs(code).some((j) => opensDialog(j, helpers)), `caught: ${code.slice(0, 60)}`)
  // a dialog in the ask step, a plain job, and a dialog outside any busy button (switching repos): not caught
  const fine = [
    "return <ActBtn label=\"Merge\" run={() => api('m', {})} ask={() => mergeConfirm(t, a, 'x')} />",
    "const [busy, go] = useBusy()\n  go(launch, () => launchOnly(all, repo))",
    "const switchRepo = async (id) => { if (!(await stopOthers(all, id, { title: 'Switch', go: 'Switch' }))) return }",
  ]
  for (const code of fine) assert.ok(!jobs(code).some((j) => opensDialog(j, helpers)), `not caught: ${code.slice(0, 60)}`)
})

/** The `disabled={…}` of the `<button` that holds `marker` (its onClick), or null when it has none. */
function disabledOf(code: string, marker: string): string | null {
  const at = code.indexOf(marker); assert.ok(at >= 0, `found ${marker}`)
  const tag = code.slice(code.lastIndexOf('<button', at), at), d = tag.indexOf('disabled={')
  return d < 0 ? null : balanced(tag, d + 'disabled='.length).slice(1, -1)
}
test('Bug 366: Undo this run is not dimmed while its are-you-sure is up, like the other five; only busy (after yes) dims it', () => {
  const auto = src('Auto.tsx'), nodes = src('Nodes.tsx')
  assert.equal(disabledOf(auto, 'onClick={undo}'), 'busy')
  // the other buttons Bug 341 changed: dimmed by busy (and their own reasons), never by their dialog being up
  assert.equal(disabledOf(nodes, "onClick={() => run(() => api(path, {}), () => cancelConfirm("), 'busy')
  assert.match(src('ui.tsx'), /export function ActBtn[^\n]*\n[^\n]*\n\s*const \[busy, go\] = useBusy\(\)\n[^\n]*disabled=\{disabled \|\| busy\}/)
  // what it must catch: the old Undo, dimmed while asking
  const old = '<button className="btn" disabled={busy || asking} title={`Put back`}\n          onClick={undo}>{busy ? \'Undoing…\' : \'Undo this run\'}</button>'
  assert.equal(disabledOf(old, 'onClick={undo}'), 'busy || asking')
})

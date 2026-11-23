// Bug 304: the plan under review (its "In plain words" part and the rest), a ticket's Spec and its handoff note were shown as plain text, so the
// markdown they are written in (```, **, `code`, ## headings; HQ's own repair spec too) showed as raw marks. They now go through ui.tsx's Md, as
// agents' messages do. The pages were checked in a headless browser by a one-off script; this keeps the rule in the code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = (f: string) => fs.readFileSync(new URL(`../../frontend/src/${f}`, import.meta.url), 'utf8')
/** One function of a file, up to the next top-level declaration. */
const fn = (file: string, name: string): string => {
  const s = src(file), at = s.search(new RegExp(`\\n(export )?function ${name}\\(`)); assert.ok(at >= 0, `${file} has ${name}`)
  const end = s.slice(at + 1).search(/\n(export |function |const |\/\*\*)/); return s.slice(at, end < 0 ? undefined : at + 1 + end)
}

test('Bug 304: the plan, the Spec and the handoff note are shown through Md', () => {
  const places: [string, string, string][] = [['Nodes.tsx', 'ReviewPanel', 'plain'], ['Nodes.tsx', 'ReviewPanel', 'rest'],
    ['App.tsx', 'TicketInfo', "t.spec || '—'"], ['App.tsx', 'HandoffNote', 'note']]
  for (const [file, name, text] of places) {
    const f = fn(file, name), esc = text.replace(/[|.*+?()[\]{}]/g, '\\$&')
    assert.match(f, new RegExp(`<Md text=\\{${esc}\\} />`), `${name}: ${text} goes through Md`)
    assert.doesNotMatch(f, new RegExp(`>\\{${esc}\\}</`), `${name}: ${text} is not printed as plain text`)
  }
})
test('Bug 304: what stays plain: test output is not markdown', () => {
  assert.doesNotMatch(fn('App.tsx', 'MergeTests'), /<Md /, "HQ's test output is shown as it came")
})

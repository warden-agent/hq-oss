// Bugs 270, 290: the side panel cut long names: a message's "TPM <project> → You" line ran out of the panel (Bug 270), and at 820 px a long agent tab
// squeezed the other tabs to "Tick…", "Messag…", "Even…" (Bug 290). The panel now wraps: its tabs go onto a second row, and a long word with no spaces
// wraps (`wrap-anywhere`). Real windows were checked in a headless browser by a one-off script; this keeps the rule in the code: the side
// panel's own parts (frontend/src/App.tsx's <aside> and the tabs it shows, Events.tsx) never cut text with `truncate`, and the places that print a name wrap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const app = fs.readFileSync(new URL('../../frontend/src/App.tsx', import.meta.url), 'utf8')
const events = fs.readFileSync(new URL('../../frontend/src/Events.tsx', import.meta.url), 'utf8')
/** One top-level function of App.tsx, up to the next top-level declaration. */
const fn = (name: string): string => {
  const at = app.indexOf(`\nfunction ${name}(`); assert.ok(at >= 0, `App.tsx has ${name}`)
  const end = app.slice(at + 1).search(/\n(function |const |export |\/\*\*)/); return app.slice(at, end < 0 ? undefined : at + 1 + end)
}
const aside = app.slice(app.indexOf('<aside'), app.indexOf('</aside>'))
const PANEL = ['TicketInfo', 'Criteria', 'Readers', 'MergeTests', 'AgentPane', 'Messages', 'MsgMark', 'HandoffNote']
const classes = (src: string): string[] => [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]!)

test('Bugs 270, 290: nothing in the side panel cuts its text', () => {
  assert.ok(aside.length > 200, 'found the side panel')
  for (const [where, src] of [['the panel', aside], ...PANEL.map((n) => [n, fn(n)]), ['Events.tsx', events]] as [string, string][])
    for (const c of classes(src)) assert.ok(!/\btruncate\b/.test(c), `${where}: "${c}" cuts its text`)
})

test('Bugs 270, 290: the panel\'s tabs wrap onto another row, and a long agent name wraps inside its tab', () => {
  const row = classes(aside).find((c) => c.includes('flex-wrap'))
  assert.ok(row, 'the tabs sit in a row that wraps')
  const tab = classes(aside).find((c) => c.startsWith('btn ') && c.includes("t === 'agent'"))!
  assert.match(tab, /'agent' \? '[^']*wrap-anywhere/, 'the Agent tab wraps a long name')
  assert.match(tab, /: '[^']*whitespace-nowrap/, 'the other tabs keep their one word whole')
})

test('Bug 270: every name the panel prints wraps a long word', () => {
  assert.ok(classes(fn('Messages')).some((c) => c.includes('overflow-y-auto') && c.includes('wrap-anywhere')), 'Messages: the list ("from → to" lines and bodies)')
  assert.ok(classes(fn('Messages')).some((c) => c.includes('text-zinc-500') && c.includes('wrap-anywhere')), "Messages: the feature's title in its header")
  assert.match(fn('AgentPane'), /return <div className="[^"]*wrap-anywhere[^"]*">/, "AgentPane: the agent's name in its header, and the lines under its terminal")
  assert.ok(!/whitespace-nowrap[^"]*">\{a\.display_name/.test(fn('AgentPane')), "AgentPane: the name itself may wrap")
  assert.match(events, /<p className="[^"]*wrap-anywhere[^"]*">What <span/, 'Events: "What <name> did"')
})

test('Bugs 270, 290: what the check must not catch: the top bar keeps its one-line labels', () => {
  // the project's sync status in the top bar is cut on purpose (its hover has it whole); it isn't the side panel's
  assert.match(fn('RepoBar'), /max-w-52 truncate/)
  assert.ok(!aside.includes('max-w-52 truncate') && !PANEL.some((n) => fn(n).includes('max-w-52 truncate')))
})

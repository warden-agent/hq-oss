import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyChange, applyEdits, changeWords, codeTerms, MAP_CAP, mapProblem, mapText, parseMap, readChange, type Edit, type Screen } from './featuremap.ts'

const SPEC_EXAMPLE = `## Reading (tab)
- "Add item" box + Add: puts an item on the list
- ✓ next to an item: marks it read (stays on list, crossed out)
- "Fill from wishlist": adds the missing books from the wishlist
`
test('the spec\'s own example reads as a map, with nothing to refuse', () => {
  const p = parseMap(SPEC_EXAMPLE); assert.ok('map' in p)
  assert.deepEqual(p.map.map((s) => s.screen), ['Reading (tab)']); assert.equal(p.map[0]!.lines.length, 3)
  assert.equal(mapProblem(p.map), null); assert.equal(mapText(p.map), SPEC_EXAMPLE)
})
test('what a user would say passes: slashes in prose, dates, labels with code words in quotes, a one-part address', () => {
  for (const ok of ['Toggle on/off: shows or hides books already read', 'Week of 12/05 shows that week\'s loans', 'Fine per day/week, whichever the library uses',
    '"Export CSV": downloads the list', '"Export JSON" button: saves a copy of the library', 'The address /authors opens the Authors tab',
    '"Due soon" label on books due back within 3 days', 'Shows 2× next to an item added twice', 'Edit and/or remove an item from its menu',
    'Remove (bin icon): takes the item off, after "Are you sure?"', 'Search box: filters the list as you type (e.g. "Dune")',
    'Settings (gear): the readers\' names and the yearly goal', 'Book(s) read this week, crossed out']) {
    assert.deepEqual(codeTerms(ok), [], ok)
  }
})
test('file names, paths and code terms are refused, each named', () => {
  const cases: [string, string][] = [
    ['Writes a line in data/books.json', 'data/books.json'], ['The list comes from reading.js', 'reading.js'],
    ['Calls addItem when clicked', 'addItem'], ['Runs save_item on submit', 'save_item'], ['Posts to /api/items', '/api/items'],
    ['Stored in localStorage', 'localStorage'], ['The ReadingList component', 'ReadingList'], ['Calls save() first', 'save()'],
    ['Sends a POST request', 'POST'], ['The <button> at the top', '<button>'], ['Opens ./src/app', './src/app'], ['Uses `fetch`', '`fetch`'],
    ['Saves to the database', 'database'], ['The API returns the list', 'API'], ['Opens http://localhost:3000', 'http://localhost:3000'],
  ]
  for (const [text, word] of cases) assert.ok(codeTerms(text).includes(word), `${text} → ${JSON.stringify(codeTerms(text))}`)
  assert.deepEqual(codeTerms('Writes a line in data/books.json'), ['data/books.json']) // once, not also as "books.json"
  const p = mapProblem([{ screen: 'Reading (tab)', lines: ['Add: calls addItem and writes data/books.json'] }])
  assert.match(p!, /"data\/books\.json", "addItem" are code/); assert.match(p!, /in a user's words/)
})
test('a file name or path in quotes is still refused; a code word in quotes is a label', () => {
  assert.deepEqual(codeTerms('"Download books.csv"'), []) // csv is data a user downloads, not code
  assert.deepEqual(codeTerms('"see server.js"'), ['server.js'])
  assert.deepEqual(codeTerms('"API keys" box: where the service key goes'), [])
})
test('layout: a line before any screen, or one that is neither, is refused and says which', () => {
  const a = parseMap('- Add: puts an item on the list'); assert.ok('error' in a && /before any screen/.test(a.error))
  const b = parseMap('## Reading\nAdd puts things on the list'); assert.ok('error' in b && /Line 2/.test(b.error))
  assert.match(mapProblem([{ screen: 'Shop', lines: [] }, { screen: 'shop', lines: [] }])!, /Two screens/)
  assert.match(mapProblem([{ screen: 'Shop', lines: ['x'.repeat(201)] }])!, /under 200/)
})
test('the size cap: over it is refused, but a change that shortens an over-long map is taken', () => {
  const line = 'A button that does one plain thing for the user, said in a few words, and then some more'
  const big = (n: number): Screen[] => Array.from({ length: n }, (_, i) => ({ screen: `Screen ${i}`, lines: [line] }))
  let n = 1; while (mapText(big(n)).length <= MAP_CAP) n++
  assert.match(mapProblem(big(n))!, /over HQ's limit/)
  assert.equal(mapProblem(big(n), mapText(big(n + 1)).length), null)
  assert.equal(mapProblem(big(n - 1)), null)
})
test('readChange: edits, prefixes, an empty edit, code in a line', () => {
  const ok = readChange([{ screen: '## Reading (tab)', add: ['- Search box: filters the list', '  '], remove: ['Old: gone'] }, { screen: 'Old tab', gone: true }])
  assert.deepEqual(ok, { edits: [{ screen: 'Reading (tab)', add: ['Search box: filters the list'], remove: ['Old: gone'], gone: false },
    { screen: 'Old tab', add: [], remove: [], gone: true }] })
  assert.ok('error' in readChange([])); assert.ok('error' in readChange([{ screen: 'x', add: 'no' }]))
  const empty = readChange([{ screen: 'Reading' }]); assert.ok('error' in empty && /nothing to add or remove/.test(empty.error))
  assert.ok('error' in readChange([{ screen: 'Reading', gone: true, add: ['x'] }]))
  const bad = readChange([{ screen: 'Reading', add: ['Add calls addItem'] }]); assert.ok('error' in bad && /addItem/.test(bad.error))
})
const map0: Screen[] = [{ screen: 'Reading', lines: ['Add: puts an item on the list', '✓: marks it read'] }, { screen: 'Authors', lines: ['Open an author: shows their books'] }]
const ed = (screen: string, o: Partial<Edit>): Edit => ({ screen, add: [], remove: [], gone: false, ...o })
test('edits: lines left out stay (only new lines given: the rest of the screen is kept), new screens go at the end, gone removes one', () => {
  const m = applyChange(map0, [ed('reading', { add: ['Clear read: takes ticked items off'] }), ed('Goals (tab)', { add: ['Yearly goal box: sets it'] }), ed('authors', { gone: true })])
  assert.deepEqual(m, [{ screen: 'Reading', lines: ['Add: puts an item on the list', '✓: marks it read', 'Clear read: takes ticked items off'] },
    { screen: 'Goals (tab)', lines: ['Yearly goal box: sets it'] }])
  assert.equal(changeWords([ed('Reading', { add: ['x'] }), ed('reading', { add: ['y'] }), ed('Authors', { gone: true })]), 'reading, Authors (gone)')
})
test('strict edits (the tool call): a line to remove must be on the map, and the refusal shows the screen\'s lines', () => {
  const r = applyEdits(map0, [ed('Reading', { remove: ['✓ marks read'] })], true)
  assert.ok('error' in r); assert.match(r.error, /Reading has no line "✓ marks read"[^]+It has:\n- Add: puts an item on the list\n- ✓: marks it read$/)
  const g = applyEdits(map0, [ed('Shelves', { gone: true })], true); assert.ok('error' in g && /no screen "Shelves"[^]+"Reading", "Authors"/.test(g.error))
  assert.ok('map' in applyEdits(map0, [ed('READING', { remove: ['✓: Marks it read'], add: ['✓ next to an item: marks it read'] })], true), 'case and spacing don\'t matter')
})
test('two tickets change the same screen at once, and both land, whichever merges first', () => {
  const a = [ed('Reading', { add: ['Search box: filters the list'] })]
  const b = [ed('Reading', { remove: ['✓: marks it read'], add: ['✓ next to an item: marks it read, crossed out'] })]
  for (const [first, second] of [[a, b], [b, a]] as const) {
    const lines = applyChange(applyChange(map0, first), second).find((s) => s.screen === 'Reading')!.lines
    assert.deepEqual([...lines].sort(), ['Add: puts an item on the list', 'Search box: filters the list', '✓ next to an item: marks it read, crossed out'].sort(), JSON.stringify(lines))
  }
  const twice = applyChange(applyChange(map0, a), a); assert.equal(twice[0]!.lines.filter((l) => l.startsWith('Search')).length, 1, 'a line already there isn\'t added twice')
})

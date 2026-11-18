// What HQ refuses in a criterion's words (criteriawords.ts), and, as much, what it must let through: a rule that refuses good criteria sends the TPM round in
// circles. The spec's own examples are in both lists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wordingProblems } from './criteriawords.ts'

const ok = [
  'Adding (Dune, 2) shows Dune ×2 in the list without a reload',
  'An empty name shows an error and adds nothing',
  'Exactly one new book record with that name and quantity; nothing else changes',
  'An empty name gets a 4xx from the API, not just blocked in the UI',
  'GET /api/items has due_on.',
  'POST /api/items with a duplicate name answers 409 and stores nothing.',
  'The list shows the item(s) the user added, newest first.',
  'The response is JSON with fields name and quantity.',
  'The list shows each book\'s due date.',
  'The page title says "Library" in the browser tab.',
  'Adding 2 and 3 gives 5.',
  'The app runs on Node.js 20 and starts with npm start.',
  'A price of 2.50 shows as $2.50.',
  'Version 1.2 appears in the footer.',
  'Saving shows "Saved" for two seconds, then it disappears.',
  'When the server is down, the page says "Can\'t reach the library" and keeps what was typed.',
  'Sign-in with a wrong password shows "Wrong password" and does not sign in.',
  'Books near their due date say "Due soon".',
  'Search for "Du" lists Dune and nothing else.',
  'The total is shown in bold.',
  'A client/server error shows a message instead of a blank page.',
  'The record count goes up by exactly one.',
  // words on the screen in quotes, layout words, a condition, URL paths and English words that look like folders, a file the user is given
  'A valid coupon shows "Looks good!" under the field',
  'The page says "Easy to use library" at the top',
  'The total is right-aligned in its column',
  'Save is right of Cancel',
  'The name field is marked as required',
  'Sign-in succeeds only when the password is correct',
  'GET /home/feed answers 200',
  'A backend/network error shows a Retry button',
  'Export downloads a file named books.csv',
]
const refused: [string, RegExp][] = [
  ['A line is added to data/books.json', /names a file or path \("data\/books\.json"\)/],
  ['index.html shows the list', /names a file or path \("index\.html"\)/],
  ['The record is written to ./store/items', /names a file or path \("\.\/store\/items"\)/],
  ['src/components holds the new list', /names a file or path \("src\/components"\)/],
  ['Items are saved in books.db.', /names a file or path \("books\.db"\)/],
  ['The settings go in /Users/me/.library', /names a file or path/],
  ['addItem() is called once', /names code \("addItem\(\)"\)/],
  ['add(2, 3) gives 5.', /names code \("add\(2, 3\)"\)/],
  ['store.save(item) runs on submit', /names code \("store\.save\(item\)"\)/],
  ['The handleSubmit function clears the form', /names code \("handleSubmit function"\)/],
  ['The BookList component shows every item', /names code \("BookList component"\)/],
  ['A new add_item helper stores the item', /names code \("add_item helper"\)/],
  ['Adding items works well', /too vague to check \("works well"\)/],
  ['The form is intuitive', /too vague to check \("is intuitive"\)/],
  ['The new layout looks good on phones', /too vague to check \("looks good"\)/],
  ['Dates are formatted correctly', /too vague to check \("formatted correctly"\)/],
  ['The total is correct', /too vague to check \("is correct"\)/],
  ['When Dune is added, the total is correct', /too vague to check \("is correct"\)/], // a condition before it, but not about it
  ['Items are saved in "data/books.json"', /names a file or path \("data\/books\.json"\)/], // quotes don't hide a file
  ['The list shows "Saved" and works well', /too vague to check \("works well"\)/], // outside the quotes
  ['Errors are handled gracefully', /too vague to check \("handled gracefully"\)/],
  ['The list updates as expected', /too vague to check \("as expected"\)/],
  ['A user-friendly empty state', /too vague to check \("user-friendly"\)/],
  ['Search works.', /too vague to check \("Search works\."\)/],
  ['It works.', /too vague to check \("It works\."\)/], ['Done', /too short to check \("Done"\)/],
  ['Fast', /too short to check/],
]

test('criteria a person or a tester can check from outside pass, whatever they name that looks a bit like code', () => {
  for (const text of ok) assert.deepEqual(wordingProblems('A1', text), [], text)
})
test('a criterion that names a file, a path or a function, or that is too vague to check, is refused with why and what to write instead', () => {
  for (const [text, why] of refused) {
    const p = wordingProblems('A2', text); assert.equal(p.length >= 1, true, text); assert.match(p.join(' '), why, text); assert.match(p[0]!, /^A2 /)
  }
  assert.match(wordingProblems('A1', 'x')[0]!, /like "an empty name shows an error and adds nothing"|"when X happens, Y is true"/)
  assert.match(wordingProblems('A1', 'data/books.json')[0]!, /"one new book record", not "a line in data\/books\.json"/)
})
test('one criterion with several problems gets each said at once, so the TPM fixes them in one go', () => {
  const p = wordingProblems('A3', 'saveItem() writes to items.json correctly as expected')
  assert.equal(p.length, 3); assert.match(p[0]!, /file/); assert.match(p[1]!, /code/); assert.match(p[2]!, /vague/)
})

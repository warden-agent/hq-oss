// Bug 142: what a repair said it left out, as the run's summary lists it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-leftout-unit-'))
const { keepProposed, leftOutLines, leftOutSection, saysNothing } = await import('./leftout.ts')
const { migrate, run, now } = await import('./db.ts'); migrate()
const pr = (id: string, body: string) => run("INSERT INTO docs(scope, key, text, updated_at) VALUES (?, 'pr', ?, ?)", `ticket:${id}`, `# Done\n\n${body}`, now())

test('leftOutSection: the words under the heading, up to the next one; none, or an empty one, is null', () => {
  assert.equal(leftOutSection('x\n\n## Tests left out\ntest/a.js: needs the internet\n- and b\n\n## Deviations from approved plan\nNone'), 'test/a.js: needs the internet\n- and b')
  assert.equal(leftOutSection('## Deviations from approved plan\nNone\n## tests left out:\n  Nothing  '), 'Nothing', 'any case, a colon, at the end')
  assert.equal(leftOutSection('## Tests left out\n### Which\nc.js'), '### Which\nc.js', 'a smaller heading is part of it')
  assert.equal(leftOutSection('## Tests left out\n\n## Deviations from approved plan\nNone'), null)
  assert.equal(leftOutSection('## Deviations from approved plan\nNone'), null)
  assert.equal(leftOutSection('Tests left out: none'), null, 'a heading, not a line')
})

test('saysNothing: only the word the spec asks for and its spellings; words that name tests are shown', () => {
  for (const s of ['Nothing', 'nothing.', ' None ', 'N/A', 'Nothing left out.', 'no tests left out']) assert.equal(saysNothing(s), true, s)
  for (const s of ['None of the network tests run', 'Nothing runs test/a.js now', 'test/a.js']) assert.equal(saysNothing(s), false, s)
})

test('leftOutLines: a proposal and a PR each, "nothing" and repeats left out, long words cut saying where the rest is, later lines inside the item', () => {
  keepProposed('t1', ' npm   test ', 'test/a.js, which needs the internet'); pr('t1', '## Tests left out\ntest/a.js, which needs the internet')
  keepProposed('t2', 'npm test', 'old words'); keepProposed('t2', 'npm test', 'nothing'); pr('t2', '## Tests left out\ntest/b.js: removed\n\n## Notes\n- npm test lists its files')
  pr('t3', '## Tests left out\nNothing'); pr('t4', 'From before Bug 142: no section')
  pr('t5', `## Tests left out\n${'x'.repeat(1600)}`)
  assert.deepEqual(leftOutLines([{ id: 't1', key: 'T-01' }, { id: 't2', key: 'T-02' }, { id: 't3', key: 'T-03' }, { id: 't4', key: 'T-04' }]), [
    '- T-01, when it proposed `npm test`: test/a.js, which needs the internet', '- T-02, in its PR: test/b.js: removed'])
  const [long] = leftOutLines([{ id: 't5', key: 'T-05' }]); assert.ok(long!.endsWith('… (the rest is in its PR)')); assert.ok(long!.length < 1600)
  pr('t6', '## Tests left out\n- a.js: internet\n\n## \n### Why\nb.js')
  assert.deepEqual(leftOutLines([{ id: 't6', key: 'T-06' }]), ['- T-06, in its PR: a.js: internet'], 'one line: its own list mark dropped')
  pr('t7', '## Tests left out\na.js\n### Why\nit calls a website'); assert.deepEqual(leftOutLines([{ id: 't7', key: 'T-07' }]), ['- T-07, in its PR:\n  a.js\n  ### Why\n  it calls a website'])
})

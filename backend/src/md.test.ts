// Bug 256 (frontend/src/md.ts): how ui.tsx's Md splits an agent's message; a ``` fence showed as a lone "`" with its code as plain text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mdBlocks, mdInline } from '../../frontend/src/md.ts'

const line = (text: string, head = false) => ({ kind: 'line', text, head })
test('Bug 256: a fence is one code block, its marks gone', () => {
  assert.deepEqual(mdBlocks('---\n\n```\nnpm test\n```\n\n🎉'), [line('---'), line(''), { kind: 'code', lines: ['npm test'] }, line(''), line('🎉')])
  assert.deepEqual(mdBlocks('Run:\n```bash\nnpm ci\n  npm test -- --watch\n```'), [line('Run:'), { kind: 'code', lines: ['npm ci', '  npm test -- --watch'] }],
    'a language after the fence is dropped; indentation inside is kept')
  assert.deepEqual(mdBlocks('~~~\na\n~~~'), [{ kind: 'code', lines: ['a'] }], 'a tilde fence')
  assert.deepEqual(mdBlocks('````\n```\nx\n```\n````'), [{ kind: 'code', lines: ['```', 'x', '```'] }], 'a shorter fence inside a longer one is code')
  assert.deepEqual(mdBlocks('```\n## not a heading\n**not bold**\n```'), [{ kind: 'code', lines: ['## not a heading', '**not bold**'] }],
    'no markdown is read inside a fence')
  assert.deepEqual(mdBlocks('```\nnever closed\nstill code'), [{ kind: 'code', lines: ['never closed', 'still code'] }], 'an unclosed fence runs to the end')
  assert.deepEqual(mdBlocks('```\n```'), [{ kind: 'code', lines: [] }], 'an empty fence')
})
test('Bug 256: what must NOT become a code block', () => {
  assert.deepEqual(mdBlocks('## Ready\n\nplain'), [line('Ready', true), line(''), line('plain')], 'headings and text as before')
  assert.deepEqual(mdBlocks('use ```x``` here'), [line('use ```x``` here')], 'backticks inside a line')
  assert.deepEqual(mdBlocks('```js```'), [line('```js```')], 'a backtick fence whose info has a backtick is not a fence')
  assert.deepEqual(mdBlocks('``\nnot code'), [line('``'), line('not code')], 'two backticks')
  assert.deepEqual(mdBlocks('    ```\nx'), [line('    ```'), line('x')], 'four spaces in is not a fence')
  assert.deepEqual(mdBlocks('```\na\n~~~\nb\n```'), [{ kind: 'code', lines: ['a', '~~~', 'b'] }], 'the other mark does not close it')
})
test('Bug 256: inline marks only where the pattern matched', () => {
  assert.deepEqual(mdInline('```'), [{ kind: 'text', text: '```' }], 'a stray fence stays text (it was a <code>` before)')
  assert.deepEqual(mdInline('**SHOP-4** · run `npm test`'), [{ kind: 'bold', text: 'SHOP-4' }, { kind: 'text', text: ' · run ' }, { kind: 'code', text: 'npm test' }])
  assert.deepEqual(mdInline('****'), [{ kind: 'text', text: '****' }])
  assert.deepEqual(mdInline(''), [])
})

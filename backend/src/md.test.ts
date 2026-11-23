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
// Bug 283: a lone ``` paired with a later ` ("Use``" plain, " to start a fence, and " as code); a fence in a list item kept its indent.
const text = (t: string) => ({ kind: 'text', text: t }), code = (t: string) => ({ kind: 'code', text: t })
test('Bug 283: a run of N backticks closes only on a run of exactly N; one nothing closes is text', () => {
  assert.deepEqual(mdInline('Use ``` to start a fence, and `x` is inline'), [text('Use ``` to start a fence, and '), code('x'), text(' is inline')])
  assert.deepEqual(mdInline('use ``a`b`` here'), [text('use '), code('a`b'), text(' here')], 'a ` inside a `` span')
  assert.deepEqual(mdInline('`` `x` ``'), [code('`x`')], 'one space off each end')
  assert.deepEqual(mdInline('use ```x``` here'), [text('use '), code('x'), text(' here')])
  assert.deepEqual(mdInline('``a` b'), [text('``a` b')], 'no run closes either')
  assert.deepEqual(mdInline('a ` b ``c`` d'), [text('a ` b '), code('c'), text(' d')])
  assert.deepEqual(mdInline('a `` b `c` d'), [text('a `` b '), code('c'), text(' d')])
  assert.deepEqual(mdInline('` ` ` `'), [code(' '), text(' '), code(' ')], 'a span of only a space keeps it')
})
test('Bug 283: what must not change, and code inside bold', () => {
  assert.deepEqual(mdInline('just plain text'), [text('just plain text')])
  assert.deepEqual(mdInline('`a` and `b`'), [code('a'), text(' and '), code('b')])
  assert.deepEqual(mdInline('run `a < b && c > d` ok'), [text('run '), code('a < b && c > d'), text(' ok')], '< > & are kept as they are')
  assert.deepEqual(mdInline('a ` b'), [text('a ` b')]); assert.deepEqual(mdInline('a `` b'), [text('a `` b')])
  assert.deepEqual(mdInline('see `**x**` here'), [text('see '), code('**x**'), text(' here')], '** inside code is code')
  assert.deepEqual(mdInline('***a**'), [text('*'), { kind: 'bold', text: 'a' }])
  assert.deepEqual(mdInline('**Run `npm test` now**'), [{ kind: 'bold', text: 'Run ' }, { kind: 'code', text: 'npm test', bold: true }, { kind: 'bold', text: ' now' }],
    'code inside bold is both (it was bold with the backticks showing)')
  assert.deepEqual(mdInline('**a `b**` c**'), [{ kind: 'bold', text: 'a ' }, { kind: 'code', text: 'b**', bold: true }, { kind: 'bold', text: ' c' }], 'code first')
  assert.deepEqual(mdInline('a \ue000 `b` \ue000'), [text('a \ue000 '), code('b'), text(' \ue000')], 'the mark used for code spans is never one in the line')
})
test('Bug 283: a fence inside a list item loses the item\'s indent', () => {
  assert.deepEqual(mdBlocks('1. Run this:\n   ```bash\n   npm test\n   ```\n2. Next'), [line('1. Run this:'), { kind: 'code', lines: ['npm test'] }, line('2. Next')])
  assert.deepEqual(mdBlocks('- Run:\n  ```\n  npm test\n    deeper\n  ```\n- next'), [line('- Run:'), { kind: 'code', lines: ['npm test', '  deeper'] }, line('- next')],
    'only the fence\'s own indent comes off')
  assert.deepEqual(mdBlocks('1. a\n   - b:\n     ```\n     x\n     ```\n2. c'), [line('1. a'), line('   - b:'), { kind: 'code', lines: ['x'] }, line('2. c')], 'a nested item')
  assert.deepEqual(mdBlocks('10. ten:\n    ```\n    y\n    ```'), [line('10. ten:'), { kind: 'code', lines: ['y'] }], 'four spaces in, under a "10."')
  assert.deepEqual(mdBlocks('  ```\n  a\n b\nc\n  ```'), [{ kind: 'code', lines: ['a', 'b', 'c'] }], 'at the top, up to the fence\'s indent comes off')
  assert.deepEqual(mdBlocks('- a\n\ntext\n    ```\nx'), [line('- a'), line(''), line('text'), line('    ```'), line('x')], 'out of the list, four in is not a fence')
  assert.deepEqual(mdBlocks('- a\n      ```\n      x'), [line('- a'), line('      ```'), line('      x')], 'four past the item\'s text is not a fence')
})

// Bug 124 (frontend/src/reply.ts): the TPM box's preview of its last reply, and when it points to the rest of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replyPreview } from '../../frontend/src/reply.ts'

test('Bug 124: a first line that leads into a list points to the rest', () => {
  assert.deepEqual(replyPreview('SHOP-2 is done, so three tickets wait for you to merge:\n\n- SHOP-1\n- SHOP-2\n- SHOP-3'),
    { text: 'SHOP-2 is done, so three tickets wait for you to merge:', more: true })
  assert.deepEqual(replyPreview("**I've updated SHOP-3's spec:**\n1. keep the old names"), { text: "I've updated SHOP-3's spec:", more: true }, 'markdown marks go')
  assert.deepEqual(replyPreview('\n\n## Ready to merge:  \n\n* T-01'), { text: 'Ready to merge:', more: true }, 'blank lines and a heading before it')
  assert.equal(replyPreview('Two choices：\nA or B').more, true, 'a full-width colon too')
})
test('Bug 124: what must NOT point to the rest', () => {
  assert.deepEqual(replyPreview('T-02 is ready to start.'), { text: 'T-02 is ready to start.', more: false }, 'one line')
  assert.deepEqual(replyPreview('I split it into two tickets.\n\nT-02 first, then T-03.'), { text: 'I split it into two tickets.', more: false },
    'a whole sentence first: the box shows a summary, as before')
  assert.equal(replyPreview('Here is the list:').more, false, 'a colon with nothing after is the whole reply')
  assert.equal(replyPreview('Here is the list:\n\n  \n- \n').more, false, 'only blank lines and bare list marks after it')
  assert.equal(replyPreview('Done at 10:30\nmore').more, false, 'a colon inside the line')
  assert.deepEqual(replyPreview(''), { text: '', more: false })
  assert.deepEqual(replyPreview('\n  \n'), { text: '', more: false })
})

// Bug 229: a reply that starts with a markdown heading showed only the heading ("What the page does now"), a label with nothing said.
const PAGE = `## What the page does now

The book list loads from the server and you can search it by title.

## What's next

- SHOP-4: borrowing a book
- SHOP-5: due dates`
test('Bug 229: a heading first goes on to the first line with something in it, the heading in front', () => {
  assert.deepEqual(replyPreview(PAGE), { text: 'What the page does now — The book list loads from the server and you can search it by title.', more: false })
  assert.deepEqual(replyPreview('# SHOP-3 is merged!\n\nI checked the page and it works.\n\nNext up is SHOP-4.'),
    { text: 'SHOP-3 is merged! I checked the page and it works.', more: false }, 'a heading that is a sentence: no dash')
  assert.deepEqual(replyPreview('# Status update\n\n## SHOP-2\n\nMerged and live.'), { text: 'SHOP-2 — Merged and live.', more: false },
    'several headings: the one just over the line')
  assert.deepEqual(replyPreview('## ✅ What changed\n\n- Added search\n- Fixed the login page'), { text: '✅ What changed — Added search', more: true },
    'a heading over a list: its first item, and the link, since the list goes on')
  assert.deepEqual(replyPreview('## Plan\n\n1. Build the list\n'), { text: 'Plan — Build the list', more: false }, 'a one-item list is all of it')
  assert.deepEqual(replyPreview('### Next steps ###\nAsk me anything.'), { text: 'Next steps — Ask me anything.', more: false }, 'closing #s go')
})
test('Bug 229: bare structure is skipped', () => {
  assert.deepEqual(replyPreview('---\n\n## Summary\n***\n\n- \n* \n1.\n```ts\nnpm test\n```'), { text: 'Summary — npm test', more: false },
    'rules, empty bullets, code fences')
  assert.deepEqual(replyPreview('## Try it\n\n```sh\nnpm start\n# then open it\n```\n\nThe page opens on the book list.'),
    { text: 'Try it — The page opens on the book list.', more: false }, 'code (and a # inside it) comes after what is said')
  assert.deepEqual(replyPreview('Run this:\n```\nnpm test\n```'), { text: 'Run this:', more: true }, 'a colon line before code points on')
  assert.deepEqual(replyPreview('🎉\n\n> \nAll three tickets are merged.'), { text: 'All three tickets are merged.', more: false }, 'a lone emoji and a lone >')
  assert.deepEqual(replyPreview('Title\n=====\nThe body.'), { text: 'Title', more: false }, 'a setext underline is a rule, the title is the first line')
  assert.deepEqual(replyPreview('| Ticket | State |\n|---|:---:|\n| SHOP-1 | merged |'), { text: '| Ticket | State |', more: false },
    'a table: its header row, as before')
})
test('Bug 229: only headings', () => {
  assert.deepEqual(replyPreview('## Done'), { text: 'Done', more: false }, 'one heading is the whole reply')
  assert.deepEqual(replyPreview('# Status\n\n## All merged\n---'), { text: 'Status', more: true }, 'several: the first, and the rest is in Chat')
  assert.deepEqual(replyPreview('## 🎉\n\n---'), { text: '', more: false }, 'nothing with a letter in it')
})
test('Bug 229: a list or a colon line after a heading, and long lines (Bug 124 kept)', () => {
  assert.deepEqual(replyPreview('## Ready to merge:\n\n- SHOP-1\n- SHOP-2'), { text: 'Ready to merge:', more: true }, 'a heading ending in ":" leads in')
  assert.deepEqual(replyPreview('## 📋 Where things stand\n\nThree tickets wait for you to merge:\n\n- SHOP-1\n- SHOP-2\n\n## Then\nSHOP-4.'),
    { text: '📋 Where things stand — Three tickets wait for you to merge:', more: true }, 'colon line under a heading still points on')
  assert.deepEqual(replyPreview('- SHOP-1 merged\n- SHOP-2 merged'), { text: 'SHOP-1 merged', more: true }, 'a list first: cut at its first item')
  const long = 'I looked at every page of the app, '.repeat(12).trim()
  assert.deepEqual(replyPreview(`## Report\n\n${long}\n\nMore below.`), { text: `Report — ${long}`, more: false }, 'a long line is kept whole (the box cuts it, hover shows it)')
  assert.deepEqual(replyPreview(`${long}:\n- a`), { text: `${long}:`, more: true }, 'a long colon line still gets the link')
})

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

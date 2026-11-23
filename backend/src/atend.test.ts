// Bug 286: a message sent from one tab pulled another tab's scrolled-up Chat to the end. The Chat (frontend/src/atend.ts useAtEnd)
// took any message from the user as "mine"; now only one this tab sent (sendHere) is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendHere, sentHere } from '../../frontend/src/atend.ts'

test('Bug 286: only a message sent from this tab counts as its own', async () => {
  assert.equal(sentHere('msg_other_tab'), false) // another tab's message (or the TPM's): the reader stays where they are
  assert.equal(sentHere(undefined), false)
  // The usual order: HQ answers first, the message's patch comes up to 100 ms later (the page batches them)
  const r = await sendHere(async () => ({ message: { id: 'msg_here' } }), (x) => x.message.id)
  assert.deepEqual(r, { message: { id: 'msg_here' } }, 'the answer is passed through')
  assert.equal(sentHere('msg_here'), true); assert.equal(sentHere('msg_other_tab'), false)
  // A message given as its own row (the Agent tab's send answers with it), and an ask answer that sent none
  await sendHere(async () => ({ id: 'msg_row' }), (m) => m.id); assert.equal(sentHere('msg_row'), true)
  await sendHere(async () => ({ id: 'ask_1' }), (x: any) => x.message_id); assert.equal(sentHere('msg_after_ask'), false)
})

test('Bug 286: the patch can come before HQ answers; a refused send marks nothing', async () => {
  let answer!: (v: { message: { id: string } }) => void
  const p = sendHere(() => new Promise<{ message: { id: string } }>((res) => { answer = res }), (x) => x.message.id)
  assert.equal(sentHere('msg_early'), true, 'while the send is out, a new message is taken as this one')
  answer({ message: { id: 'msg_early' } }); await p
  assert.equal(sentHere('msg_early'), true); assert.equal(sentHere('msg_later_other_tab'), false, 'nothing is out any more')

  await assert.rejects(sendHere(async () => { throw new Error('409 refused') }, () => 'never'))
  assert.equal(sentHere('never'), false); assert.equal(sentHere('msg_next_other_tab'), false, 'a refused send leaves nothing out')
})

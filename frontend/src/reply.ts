// The TPM box's one-line preview of the TPM's last reply (board.ts tpmView). Its first line often leads into a list ("…waiting for you
// to merge:"); shown alone that reads as cut off (Bug 124), so the box then adds a link to the rest.

/** A line of text without markdown marks: leading #, >, *, - and spaces, and ** or ` anywhere. */
const plain = (l: string): string => l.replace(/^[#>*\-\s]+/, '').replace(/\*\*|`/g, '').trim()
/** The preview of a reply: its first line, and whether the box should point to the rest. It does when that line ends in ":" and
 *  the reply goes on after it (a line that ends in ":" with nothing after is the whole reply). */
export function replyPreview(body: string): { text: string; more: boolean } {
  const lines = String(body).split('\n').map(plain), at = lines.findIndex(Boolean)
  if (at < 0) return { text: '', more: false }
  const text = lines[at]!
  return { text, more: /[:：]$/.test(text) && lines.slice(at + 1).some(Boolean) }
}
/** The link at the end of such a preview; it opens the box's Chat, which has the whole reply. */
export const MORE = 'more in Chat ›'

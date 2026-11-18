// The TPM box's one-line preview of the TPM's last reply (board.ts tpmView). Its first line often leads into a list ("…waiting for you
// to merge:"); shown alone that reads as cut off (Bug 124), so the box then adds a link to the rest. A reply that starts with a
// markdown heading showed only the heading, a label with nothing said (Bug 229): the preview now goes on to the first line with
// something in it and keeps the heading in front of it.

/** A line of text without markdown marks: leading #, >, *, - and spaces, and ** or ` anywhere. */
const plain = (l: string): string => l.replace(/^[#>*\-\s]+/, '').replace(/\*\*|`/g, '').trim()
type Part = { kind: 'head' | 'item' | 'text' | 'code'; text: string }
/** The parts of a reply, one per line, without bare structure: blank lines, code fences, rules (---, ***, ===, a table's |---|), list
 *  marks with nothing after them, and anything else without a letter or digit (a lone emoji, a lone >). Lines inside a fence are code. */
function parts(body: string): Part[] {
  let fenced = false
  return String(body).split('\n').flatMap((line): Part[] => {
    const l = line.trim()
    if (/^(```|~~~)/.test(l)) { fenced = !fenced; return [] }
    const head = !fenced && /^#{1,6}(\s|$)/.test(l), item = !fenced && !head && /^([-*+]|\d+[.)])(\s|$)/.test(l)
    const text = fenced ? l : plain(head ? l.replace(/\s#+$/, '') : item ? l.replace(/^([-*+]|\d+[.)])/, '') : l)
    return /[\p{L}\p{N}]/u.test(text) ? [{ kind: fenced ? 'code' : head ? 'head' : item ? 'item' : 'text', text }] : []
  })
}
const COLON = /[:：]$/
/** The preview of a reply and whether the box should point to the rest. It is the first line with something said in it (code only
 *  when there is nothing else), after the heading just over it ("What the page does now — The list loads…"); a reply of headings
 *  only shows its first one. It points to the rest when the shown line ends in ":" or is a list item and the reply goes on after
 *  it: a list cut at its first item reads as if that were all. A heading that ends in ":" leads into what follows, so it is shown
 *  alone with the link, as in Bug 124. */
export function replyPreview(body: string): { text: string; more: boolean } {
  const ps = parts(body), said = ps.findIndex((p) => p.kind === 'text' || p.kind === 'item')
  const at = said >= 0 ? said : ps.findIndex((p) => p.kind === 'code'), c = ps[at], h = ps.slice(0, at).filter((p) => p.kind === 'head').pop()
  if (!c) return { text: ps[0]?.text ?? '', more: ps.length > 1 }
  if (h && COLON.test(h.text)) return { text: h.text, more: true }
  const text = h ? `${h.text}${/[.!?。！？]$/.test(h.text) ? ' ' : ' — '}${c.text}` : c.text
  return { text, more: (COLON.test(c.text) || c.kind === 'item') && at < ps.length - 1 }
}
/** The link at the end of such a preview; it opens the box's Chat, which has the whole reply. */
export const MORE = 'more in Chat ›'

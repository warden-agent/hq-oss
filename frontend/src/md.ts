// How ui.tsx's Md splits an agent's message. Bug 256: a code fence (```) showed as a lone "`" and the code in it as plain text; a fence's
// lines are now one code block, shown as such, and no markdown inside it is read. Bug 283: a lone ``` in a line of text paired with a
// later ` and marked the wrong part as code; `code` now follows CommonMark's backtick runs. A fence inside a list item kept the item's
// indent on every code line; it is now taken off.

export type MdBlock = { kind: 'line'; text: string; head: boolean } | { kind: 'code'; lines: string[] }
const FENCE = /^( *)(`{3,}|~{3,})(.*)$/
const ITEM = /^( *)(?:[-*+]|\d{1,9}[.)])( +|$)/
/** The message as lines and code blocks. A fence opens with ``` or ~~~ (an info string after it, such as a language, is dropped) and
 *  closes with a line of the same mark, at least as long; a fence never closed runs to the end, as in CommonMark. It may be indented up to
 *  3 spaces, or up to 3 past the text of the list item it is in ("1. Run:" then "   ```"), and that many spaces come off each of its
 *  lines (Bug 283). "## Heading" lines outside fences are headings. */
export function mdBlocks(text: string): MdBlock[] {
  const out: MdBlock[] = []; let code: { mark: string; indent: number; lines: string[] } | null = null
  const items: number[] = [] // where the text of each list item the line may be in starts, innermost last
  for (const l of String(text).split('\n')) {
    const f = FENCE.exec(l), indent = f ? f[1]!.length : 0
    if (code) {
      if (f && f[2]![0] === code.mark[0] && f[2]!.length >= code.mark.length && !f[3]!.trim() && indent <= code.indent + 3) {
        out.push({ kind: 'code', lines: code.lines }); code = null
      } else code.lines.push(l.replace(new RegExp(`^ {0,${code.indent}}`), ''))
      continue
    }
    const lead = /^ */.exec(l)![0].length, item = ITEM.exec(l)
    if (l.trim()) while (items.length && items.at(-1)! > lead) items.pop() // a line left of an item's text is not in that item
    if (item) items.push(item[0].length)
    const inItem = items.some((w) => indent >= w && indent <= w + 3)
    if (f && (indent <= 3 || inItem) && !(f[2]![0] === '`' && f[3]!.includes('`'))) code = { mark: f[2]!, indent, lines: [] } // a backtick fence's info has no `
    else { const h = /^#{1,4}\s+(.*)$/.exec(l); out.push({ kind: 'line', text: h ? h[1]! : l, head: !!h }) }
  }
  if (code) out.push({ kind: 'code', lines: code.lines })
  return out
}
/** A line's **bold** and `code` parts. Code inside bold is code with `bold` set. */
export type MdPart = { kind: 'text' | 'bold'; text: string } | { kind: 'code'; text: string; bold?: true }
/** A line's code spans, as CommonMark has them (Bug 283): a run of N backticks opens one that only a run of exactly N closes, and a run
 *  nothing closes is plain text. One space comes off each end when both ends have one (`` `a` `` is "`a`"). */
function codeSpans(line: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [], none = new Set<number>() // run lengths with no closing run further on
  let text = '', at = 0
  const runAt = (i: number) => { let j = i; while (line[j] === '`') j++; return j - i }
  while (at < line.length) {
    const open = line.indexOf('`', at)
    if (open < 0) { text += line.slice(at); break }
    const n = runAt(open); let close = -1
    if (!none.has(n)) for (let j = line.indexOf('`', open + n); j >= 0; j = line.indexOf('`', j + runAt(j))) if (runAt(j) === n) { close = j; break }
    if (close < 0) { none.add(n); text += line.slice(at, open + n); at = open + n; continue }
    if (text + line.slice(at, open)) out.push({ code: false, text: text + line.slice(at, open) })
    const c = line.slice(open + n, close); out.push({ code: true, text: /^ [^]* $/.test(c) && c.trim() ? c.slice(1, -1) : c })
    text = ''; at = close + n
  }
  if (text) out.push({ code: false, text })
  return out
}
/** Code spans first, as in CommonMark (`**` inside one is code); then **bold** around the text and code that's left. Only what the
 *  patterns matched is marked: a part that merely starts and ends with ` (a stray "```") stays text. */
export function mdInline(line: string): MdPart[] {
  const spans = codeSpans(line); let s = 0xe000; while (line.includes(String.fromCharCode(s))) s++
  const slot = String.fromCharCode(s), codes = spans.filter((p) => p.code).map((p) => p.text); let k = 0
  const masked = spans.map((p) => p.code ? slot : p.text).join('') // each code span as one mark that is not a *
  const back = (t: string, bold: boolean): MdPart[] => t.split(slot).flatMap((x, i): MdPart[] => [
    ...(i ? [bold ? { kind: 'code' as const, text: codes[k++]!, bold: true as const } : { kind: 'code' as const, text: codes[k++]! }] : []),
    ...(x ? [{ kind: bold ? 'bold' as const : 'text' as const, text: x }] : [])])
  return masked.split(/(\*\*[^*]+\*\*)/).flatMap((p, i) => !p ? [] : i % 2 === 0 ? back(p, false) : back(p.slice(2, -2), true))
}

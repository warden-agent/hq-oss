// How ui.tsx's Md splits an agent's message. Bug 256: a code fence (```) showed as a lone "`" and the code in it as plain text; a fence's
// lines are now one code block, shown as such, and no markdown inside it is read.

export type MdBlock = { kind: 'line'; text: string; head: boolean } | { kind: 'code'; lines: string[] }
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** The message as lines and code blocks. A fence opens with ``` or ~~~ (an info string after it, such as a language, is dropped) and
 *  closes with a line of the same mark, at least as long; a fence never closed runs to the end, as in CommonMark. "## Heading" lines
 *  outside fences are headings. */
export function mdBlocks(text: string): MdBlock[] {
  const out: MdBlock[] = []; let code: { mark: string; lines: string[] } | null = null
  for (const l of String(text).split('\n')) {
    const f = FENCE.exec(l)
    if (code) {
      if (f && f[1]![0] === code.mark[0] && f[1]!.length >= code.mark.length && !f[2]!.trim()) { out.push({ kind: 'code', lines: code.lines }); code = null }
      else code.lines.push(l)
    } else if (f && !(f[1]![0] === '`' && f[2]!.includes('`'))) code = { mark: f[1]!, lines: [] } // a backtick fence's info string has no backtick
    else { const h = /^#{1,4}\s+(.*)$/.exec(l); out.push({ kind: 'line', text: h ? h[1]! : l, head: !!h }) }
  }
  if (code) out.push({ kind: 'code', lines: code.lines })
  return out
}
export type MdPart = { kind: 'text' | 'bold' | 'code'; text: string }
/** A line's **bold** and `code` parts. Only what the pattern matched is marked: a part that merely starts and ends with ` (a stray "```")
 *  stays text. */
export function mdInline(line: string): MdPart[] {
  return line.split(/(\*\*[^*]+\*\*|`[^`]+`)/).flatMap((p, i): MdPart[] => !p ? [] : i % 2 === 0 ? [{ kind: 'text', text: p }]
    : p.startsWith('**') ? [{ kind: 'bold', text: p.slice(2, -2) }] : [{ kind: 'code', text: p.slice(1, -1) }])
}

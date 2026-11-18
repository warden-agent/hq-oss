// Reading an agent's terminal screen (a tmux capture of Claude Code; checked on 2.1.300 and 2.1.322). Pure, so it is unit-tested on real captures.

/** The line under the input box when Claude Code waits at its prompt. It starts with the permission mode ("⏸ manual mode on", "⏸ plan mode on",
 *  "⏵⏵ accept edits on"), and that part is the only one that is always there. 2.1.300 also ended every one with "← for agents"; 2.1.322 doesn't, and shows
 *  hints that come and go instead: "? for shortcuts" (gone while there's a draft in the box, or once a helper has run: "/tasks to see subagents"),
 *  "(shift+tab to cycle)" (gone while a command runs in the background: "1 shell · ↓ to manage"). Bug 97. */
const FOOTER = /\b(?:manual mode|plan mode|accept edits|auto mode|bypass permissions) on\b|for shortcuts|shift\+tab to cycle|for agents/
/** Claude Code's working line above the box ("✳ Choreographing… (13s · ↓ 82 tokens)"): a spinner glyph, a word and "…". Its line once the turn
 *  has ended has no "…" ("✻ Baked for 22s · done 2:21 AM", "✻ Waiting for 1 background agent to finish"). */
const SPINNER = /^[·✢✳✶✻✽*] \S[^…]*…/
/** Whether the screen shows Claude Code waiting at its prompt: the input box (a `❯` line) and the footer are there, and nothing
 *  is running. While Claude Code works, its footer says "esc to interrupt"; a menu or dialog (a plan approval, a permission
 *  prompt) lists numbered options. Text after the `❯` doesn't matter: idle screens often show a greyed suggestion there.
 *  Bug 189: with a draft typed in the box, 2.1.322 drops "esc to interrupt" even while it works. Two other signs stay (checked on 2.1.322):
 *  the box's `❯` is drawn grey all through a turn and in the terminal's own colour once it ends (only a capture with `-e` shows it: pass
 *  one when you can), and the working line sits above the box (not while text streams in, and the screen keeps changing then). */
export function paneLooksIdle(screen: string): boolean {
  const styled = /\x1b\[[0-9;:]*m/.test(screen), lines = plainScreen(screen).split('\n').map((l) => l.replace(/\s+$/, ''))
  if (lines.some((l) => /esc to interrupt/.test(l))) return false
  if (paneShowsDialog(lines.join('\n'))) return false
  const prompt = lines.map((l) => /^❯(\s|$)/.test(l)).lastIndexOf(true), rule = (l: string): boolean => /^─{10,}/.test(l.trim())
  if (!(prompt > 0 && rule(lines[prompt - 1]) && lines.slice(prompt + 1).some((l) => FOOTER.test(l)))) return false
  if (styled && !typedOnly(screen)[prompt]?.startsWith('❯')) return false // the `❯` is drawn in a colour: a turn runs
  const above = lines.slice(0, prompt - 1).reverse().find((l) => /^\S/.test(l)) // the last line above the box that isn't indented
  return !(above && SPINNER.test(above))
}
/** A menu or dialog on the screen (a plan approval, a permission prompt): numbered options, or the question itself. */
export const paneShowsDialog = (screen: string): boolean => screen.split('\n').some((l) => /^\s*❯\s*\d+\.\s/.test(l) || /Do you want to|Would you like to proceed/.test(l))

/** A tmux capture taken with `-e` (styles kept) as plain text: what `capture-pane -p` gives. */
export const plainScreen = (styled: string): string => styled.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '')
/** Each line of a `-e` capture with every character a person typed kept and every other one (dim, coloured or inverse) made a space. tmux writes only
 *  the style changes, carried from one line to the next, so the whole screen is read in order. */
function typedOnly(styled: string): string[] {
  let dim = false, fg = false, inverse = false, out = ''
  for (const part of styled.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').split(/(\x1b\[[0-9;:?]*[A-Za-z])/)) {
    const sgr = /^\x1b\[([0-9;:]*)m$/.exec(part)
    if (sgr) {
      const ps = sgr[1].split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)))
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i]
        if (p === 0) { dim = false; fg = false; inverse = false } else if (p === 2) dim = true; else if (p === 22) dim = false
        else if (p === 7) inverse = true; else if (p === 27) inverse = false; else if (p === 39) fg = false
        else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) fg = true
        if (p === 38 || p === 48 || p === 58) { if (p === 38) fg = true; i += ps[i + 1] === 5 ? 2 : ps[i + 1] === 2 ? 4 : 0 } // its colour's own numbers
      }
    } else if (!part.startsWith('\x1b')) out += dim || fg || inverse ? part.replace(/[^\n]/g, ' ') : part
  }
  return out.split('\n')
}
/** Bug 149: a line somebody typed into Claude Code's prompt box and hasn't sent (a draft). HQ never types there then: Enter would send the two
 *  as one message. `styled` is a capture with `-e`. Checked on 2.1.322 (test-tools README item 25): a typed draft is drawn in the terminal's own
 *  colour, on the `❯` line and the lines under it (indented) up to the box's lower rule; an empty box shows nothing or a dim placeholder
 *  (`Try "…"`), Claude Code's suggestion of what to type next is dim (`❯ ESC[2mcommit this`), and so is "Press up to edit queued messages".
 *  Only text drawn plain counts, so a capture with no styles at all (colours turned off, say) never does: a wrong "there's a draft" would hold
 *  the agent's messages for good, a missed one only does what HQ did before. */
export function paneHasDraft(styled: string): boolean {
  if (!/\x1b\[[0-9;:]*m/.test(styled)) return false
  const plain = plainScreen(styled).split('\n'), typed = typedOnly(styled), rule = (l: string | undefined): boolean => /^─{10,}/.test((l ?? '').trim())
  const top = plain.map((l) => /^❯(\s|$)/.test(l)).lastIndexOf(true)
  if (top < 1 || !rule(plain[top - 1])) return false
  const end = plain.findIndex((l, i) => i > top && rule(l)); if (end < 0) return false
  return typed.slice(top, end).some((l, i) => /\S/.test(i === 0 ? l.replace(/^❯/, '') : l))
}

// Reading an agent's terminal screen (a tmux capture of Claude Code; checked on 2.1.300 and 2.1.322). Pure, so it is unit-tested on real captures.

/** The line under the input box when Claude Code waits at its prompt. It starts with the permission mode ("⏸ manual mode on", "⏸ plan mode on",
 *  "⏵⏵ accept edits on"), and that part is the only one that is always there. 2.1.300 also ended every one with "← for agents"; 2.1.322 doesn't, and shows
 *  hints that come and go instead: "? for shortcuts" (gone while there's a draft in the box, or once a helper has run: "/tasks to see subagents"),
 *  "(shift+tab to cycle)" (gone while a command runs in the background: "1 shell · ↓ to manage"). Bug 97. */
const FOOTER = /\b(?:manual mode|plan mode|accept edits|auto mode|bypass permissions) on\b|for shortcuts|shift\+tab to cycle|for agents/
/** Whether the screen shows Claude Code waiting at its prompt: the input box (a `❯` line) and the footer are there, and nothing
 *  is running. While Claude Code works, its footer says "esc to interrupt"; a menu or dialog (a plan approval, a permission
 *  prompt) lists numbered options. Text after the `❯` doesn't matter: idle screens often show a greyed suggestion there. */
export function paneLooksIdle(screen: string): boolean {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''))
  if (lines.some((l) => /esc to interrupt/.test(l))) return false
  if (paneShowsDialog(screen)) return false
  const prompt = lines.map((l) => /^❯(\s|$)/.test(l)).lastIndexOf(true)
  return prompt > 0 && /^─{10,}/.test(lines[prompt - 1].trim()) && lines.slice(prompt + 1).some((l) => FOOTER.test(l))
}
/** A menu or dialog on the screen (a plan approval, a permission prompt): numbered options, or the question itself. */
export const paneShowsDialog = (screen: string): boolean => screen.split('\n').some((l) => /^\s*❯\s*\d+\.\s/.test(l) || /Do you want to|Would you like to proceed/.test(l))

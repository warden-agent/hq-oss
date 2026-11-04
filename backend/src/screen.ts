// Reading an agent's terminal screen (a tmux capture of Claude Code 2.1.300). Pure, so it is unit-tested on real captures.

/** Whether the screen shows Claude Code waiting at its prompt: the input box (a `❯` line) and the footer are there, and nothing
 *  is running. While Claude Code works, its footer says "esc to interrupt"; a menu or dialog (a plan approval, a permission
 *  prompt) lists numbered options. Text after the `❯` doesn't matter: idle screens often show a greyed suggestion there. */
export function paneLooksIdle(screen: string): boolean {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''))
  if (lines.some((l) => /esc to interrupt/.test(l))) return false
  if (lines.some((l) => /^\s*❯\s*\d+\.\s/.test(l) || /Do you want to|Would you like to proceed/.test(l))) return false
  const prompt = lines.map((l) => /^❯(\s|$)/.test(l)).lastIndexOf(true)
  return prompt > 0 && /^─{10,}/.test(lines[prompt - 1].trim()) && lines.slice(prompt + 1).some((l) => /for shortcuts|shift\+tab to cycle|for agents/.test(l))
}

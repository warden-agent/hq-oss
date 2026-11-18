// What HQ refuses in a criterion's words (Tester & Checker spec, Part 1): a file, path or function name, or words too vague to check. Criteria are checked
// from outside the code (by a person, a tester that never sees the code, a test), so "a line in data/books.json" is refused and "one new book record" is
// not. Plain code: a short list of signals that only code has (a file extension, a name glued to "(", a code-shaped name next to "function"), and a short
// list of phrases that say nothing anyone can see ("works well", "is intuitive"). It misses some (a file named without its extension, a vague claim in
// other words) and is kept narrow on purpose so it doesn't refuse good criteria: URL paths (/api/items, /home/feed), field names (due_on), status codes
// (4xx), "item(s)", a file the user is given ("downloads a file named books.csv"), and words on the screen in double quotes ("shows "Looks good!"") all pass;
// "is correct" passes as a condition ("only when the password is correct"). Pure, imported by criteria.ts.

const EXT = 'js|mjs|cjs|jsx|ts|tsx|json|py|go|rs|rb|java|kt|swift|php|css|scss|sass|less|html?|vue|svelte|md|ya?ml|toml|ini|env|sql|sqlite3?|db|sh|csv|lock|xml|txt'
/** A file name: a word (and the folders before it) with a code or data file's extension, standing alone. */
const FILE = new RegExp(`(?:^|[\\s"'\`(\\[])((?:[\\w.@-]+/)*[\\w@-][\\w.@-]*\\.(?:${EXT}))(?=$|[\\s"'\`)\\],;:!?]|\\.(?:\\s|$))`, 'gi')
/** A file the user is given or sees by name ("a file named books.csv", "called report.txt"): what the app shows, not where the code keeps things. */
const SHOWN_FILE = new RegExp(`\\b(named|called)\\s+["“']?[\\w.@-]+\\.(?:${EXT})\\b["”']?`, 'gi')
/** Libraries named like files: a criterion may say what it runs on. */
const NOT_A_FILE = /^(node|next|nuxt|vue|express|three|chart|d3|react|ember|backbone|alpine|solid|socket|moment|day)\.js$/i
/** A path on disk (./, ~/, a Mac's /Users/, C:\\), or under one of a project's code folders. A URL path (/api/items, /home/feed) passes, and so do words
 *  that share a folder's name in English ("a backend/network error"). */
const DISK = /(?:^|[\s"'`(])((?:~|\.{1,2})\/[\w./-]*|\/(?:Users|private)\/[\w./-]*|[A-Z]:\\[\w.\\-]*)/g
const CODE_DIR = /(?:^|[\s"'`(])((?:src|lib|components|node_modules|dist|scripts|utils|controllers|migrations)\/[\w./-]*)/g
/** A function call: a name glued to "(". English plurals, "item(s)", aren't. */
const CALL = /(?:^|[^\w$])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\((?!(?:e?s|ies)\))[^)]{0,40}\)?)/g
/** A camelCase or snake_case name next to the word for what it is in code ("the addItem function", "component BookList"). */
const CODE_NAME = '[A-Za-z$]*(?:[a-z][A-Z]|_)[\\w$]*', WHAT = '(?:function|method|class|hook|component|handler|helper|module|variable)'
const NAMED = new RegExp(`(?:^|[^\\w$])(${CODE_NAME}\\s+${WHAT}s?|${WHAT}\\s+[\`'"]?${CODE_NAME})`, 'g')

/** Phrases that say how something should feel, or that it's right, without saying what anyone would see. */
const VAGUE: RegExp[] = [
  new RegExp('\\b(?:works?|working|behaves?|functions?|runs?|performs?|handled?|handles|displays?|shows?|renders?|saves?|loads?|calculated|formatted|validated)'
    + '\\s+(?:correctly|properly|appropriately|well|fine|nicely|gracefully|smoothly|reliably|perfectly)\\b', 'i'),
  /\bas (?:expected|intended|designed)\b/i,
  new RegExp('\\b(?:is|are|be|feels?|looks?|seems?)\\s+(?:(?:more|very|really|fully)\\s+)?(?:intuitive|user[- ]friendly|nice|good|great|better|polished|modern'
    + '|seamless|smooth|robust|fast|performant|clean|pretty|beautiful|elegant|responsive|easy to use)\\b', 'i'),
  /\bintuitive(?:ly)?\b/i, /\buser[- ]friendly\b/i, /\beasy to (?:use|understand|find|read|navigate)\b/i, /\b(?:bug[- ]free|no bugs)\b/i,
  /\b(?:good|great|better|nice|smooth) (?:ux|ui|user experience|experience)\b/i,
  /\b(?:it|everything|this|feature|page|app|form|button|search|list)\s+works?[.!]?$/i,
]
/** "It's right" without saying what right is; as a condition ("only when the password is correct") it's checkable, and passes. */
const RIGHT = /\b(?:is|are|be)\s+(?:correct|proper|appropriate)\b/gi
const AS_CONDITION = /\b(?:when|if|unless|until|while|whether)\s+(?:(?:the|a|an|its|their|your)\s+)?[\w-]+(?:\s+[\w-]+)?\s+(?:is|are|be)\s+(?:correct|proper|appropriate)\b/gi
/** Words in double quotes: what the screen says ("Looks good!"), not a claim about it. The vague phrases aren't looked for there. */
const QUOTED = /"[^"]*"|“[^”]*”/g
const WORDS = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

const all = (re: RegExp, text: string): string[] => [...text.matchAll(re)].map((m) => m[1]!.replace(/[.,;:]+$/, ''))
/** What's wrong with one criterion's words, as sentences the TPM can act on; [] when nothing is. `id`: its id, to name it. */
export function wordingProblems(id: string, text: string): string[] {
  const shown = text.replace(SHOWN_FILE, '$1 it'), said = text.replace(QUOTED, '""')
  const files = [...new Set([...all(FILE, shown).filter((f) => !NOT_A_FILE.test(f)), ...all(DISK, text), ...all(CODE_DIR, text)])]
  const code = [...new Set([...all(CALL, text), ...all(NAMED, text)])]
  const cond = [...said.matchAll(AS_CONDITION)].map((m) => [m.index, m.index + m[0].length])
  const right = [...said.matchAll(RIGHT)].find((m) => !cond.some(([a, b]) => m.index >= a! && m.index < b!))
  const vague = [...VAGUE.map((re) => re.exec(said)?.[0]), right?.[0]].filter((p): p is string => !!p)
  return [
    files.length ? `${id} names a file or path (${files.map((f) => `"${f}"`).join(', ')}). Criteria are checked from outside the code: say what is stored or`
      + ' shown, like "one new book record", not "a line in data/books.json".' : '',
    code.length ? `${id} names code (${code.map((f) => `"${f}"`).join(', ')}). Say what the user sees or what the API answers instead, like "adding Dune shows`
      + ' Dune ×2", not "addItem() is called".' : '',
    vague.length ? `${id} is too vague to check ("${vague[0]}"). Say what is true when it works: "when X happens, Y is true", like "an empty name shows an`
      + ' error and adds nothing".' : !files.length && !code.length && WORDS(text) < 3 ? `${id} is too short to check ("${text}"). Say what is true when it`
      + ' works: "when X happens, Y is true".' : '',
  ].filter(Boolean)
}

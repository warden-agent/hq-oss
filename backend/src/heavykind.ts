// Which shell commands are a build or a full test run: the kind that fills every core for minutes, and takes turns (Bug 76, heavy.ts). Rules only, with no
// imports: HQ asks them (heavy.ts), and so does each engineer's Bash hook when HQ is down and can't be asked (Bug 112, turnwait.mjs).
export type Heavy = 'tests' | 'build'
const unquoted = (s: string): string => s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ' Q ') // a commit message that says "npm test" runs nothing
/** What goes in front of a program without changing which program it is. */
const WRAPPER = new RegExp(String.raw`^(?:[A-Za-z_]\w*=\S*|time|exec|env|command|nohup|nice(?:\s+-n\s*-?\d+|\s+-\d+)?|caffeinate(?:\s+-[a-z]+)*|timeout(?:\s+-\S+)*\s+\S+`
  + String.raw`|npx(?:\s+(?:-y|--yes|--no|--no-install))*|bunx|pnpm\s+(?:exec|dlx)|yarn\s+(?:exec|dlx)|uv\s+run|poetry\s+run|pipenv\s+run|python[\d.]*\s+-m)\s+`)
/** The program each simple command in a shell line runs, with its arguments: split at && || ; | & and brackets, wrappers and the program's folder taken off. */
export function programs(command: string): string[] {
  return unquoted(command).split(/&&|\|\||[;|&\n(){}]/).map((part) => {
    let s = part.trim()
    for (let i = 0; i < 8; i++) { const next = s.replace(/^\S*\/(?=[^\s/]+(?:\s|$))/, '').replace(WRAPPER, ''); if (next === s) break; s = next }
    return s
  }).filter(Boolean)
}
// `npm test`, `yarn build`, `npm --workspace web run test:unit`: a package manager, its own options, then a script named for tests or a build
const PM = String.raw`(?:npm|pnpm|yarn|bun)\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*?(?:(?:run|run-script)\s+)?`
const TESTS = new RegExp(String.raw`^(?:${PM}(?:t|tst|test|e2e)(?:$|[\s:._-])|(?:vitest|jest|mocha|ava|pytest|tox|nox|rspec|phpunit)(?:\s|$)|(?:playwright|cypress)\s+(?:test|run)\b`
  + String.raw`|node\s+(?:\S+\s+)*?--test(?:[\s=]|$)|deno\s+test\b|cargo\s+(?:test|nextest)\b|go\s+test\b|make\s+(?:test|check)\b|gradlew?\s+(?:\S+\s+)*?(?:test|check)\b`
  + String.raw`|mvnw?\s+(?:\S+\s+)*?(?:test|verify)\b|swift\s+test\b|dotnet\s+test\b|mix\s+test\b|(?:rails|rake)\s+test\b)`)
const BUILDS = new RegExp(String.raw`^(?:${PM}build(?:$|[\s:._-])|(?:vite|next|nuxt|astro|ng)\s+build\b|(?:turbo|nx)\s+(?:run\s+)?build\b|webpack(?:\s|$)|tsc\s+(?:-b|--build)\b`
  + String.raw`|cargo\s+build\b|go\s+build\b|make(?:\s+(?:all|build))?$|gradlew?\s+(?:\S+\s+)*?(?:build|assemble)\b|mvnw?\s+(?:\S+\s+)*?(?:package|install)\b|swift\s+build\b`
  + String.raw`|dotnet\s+build\b|xcodebuild\b)`)
const squeezed = (s: string): string => s.trim().replace(/\s+/g, ' ')
// A test run aimed at up to three named test files (no wildcards), or at tests picked by name, is small: engineers do these all the time while they work
const TEST_FILE = /(?:^|\s)(?!-)[^\s*?{]*(?:[._-](?:test|spec)\.[cm]?[jt]sx?|_test\.(?:go|py|rb)|(?:^|\/)test_[\w-]+\.py)(?:::\S+)?(?=\s|$)/g
const BY_NAME = /\s(?:-t|-k|-g|-run|--grep|--filter|--test-name-pattern|--testNamePattern|--testPathPattern)(?:[=\s]|$)/
const narrow = (program: string): boolean => { const files = program.match(TEST_FILE)?.length ?? 0; return (files >= 1 && files <= 3 && !/[*?{]/.test(program)) || BY_NAME.test(program) }
/** Is this shell command a full test run or a build? By the program it runs, or because it is the project's own test command. A guess both ways, and both
 *  are cheap: a small command taken for a big one waits a little, a big one missed runs alongside as before. */
export function heavyKind(command: string, testCmd: string | null): Heavy | null {
  if (testCmd?.trim() && squeezed(command).includes(squeezed(testCmd))) return 'tests'
  const ps = programs(command)
  return ps.some((p) => TESTS.test(p) && !narrow(p)) ? 'tests' : ps.some((p) => BUILDS.test(p)) ? 'build' : null
}
/** A Bash command an agent is about to start: does it take a turn? Not a run_in_background command (a server, not a run), and nothing in plan mode (it's
 *  refused anyway). */
export function heldKind(c: { command: string; background: boolean; plan: boolean }, testCmd: string | null): Heavy | null {
  return c.plan || c.background ? null : heavyKind(c.command, testCmd)
}

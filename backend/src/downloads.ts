// Bugs 412, 415: a download an agent's sandbox stopped, read from what one of its Bash commands printed, so HQ can tell the user which host it
// was. On 2.1.322 Claude Code adds the hosts its proxy refused after a command's output (the hook's `tool_response.stderr` when the command
// exited 0, its `error` when it didn't; real runs, 2026-11-26):
//   <sandbox_violations>
//   deny network-outbound proxy.golang.org:443 (host is not on the allow list)
//   </sandbox_violations>
// A download that reached its host but failed macOS's certificate check (pip, Go: roles.ts systemCerts) says "OSStatus -26276" instead.
// Pure, so it's unit-tested (downloads.test.ts); hooks.ts raises the notice.

/** Where every project's agents may download from (roles.ts PACKAGE_REGISTRIES), in a user's words. */
export const REGISTRY_WORDS = "npm, PyPI, crates.io and Go's module mirror"

export type Stopped = { hosts: string[]; cert: boolean }
const BLOCK = '<sandbox_violations>'
const REFUSED = /^deny network-outbound (\S+):\d+ \(host is not on the allow list\)$/gm
/** The hosts the sandbox refused in a command's output, and whether a download failed macOS's certificate check (`mac`: only a Mac has that
 *  checker). Null when neither happened: nearly every command. */
export function stoppedDownloads(text: string, mac: boolean): Stopped | null {
  const at = text.indexOf(BLOCK), hosts = new Set<string>()
  if (at >= 0) for (const m of text.slice(at).matchAll(REFUSED)) hosts.add(m[1]!.replace(/^\[(.*)\]$/, '$1'))
  const cert = mac && /\bOSStatus -26276\b/.test(text)
  return hosts.size || cert ? { hosts: [...hosts].sort(), cert } : null
}
/** Everything a hook says a Bash command printed: its output when it ended normally, the error when it didn't. */
export function hookText(body: Record<string, unknown>): string {
  const r = body.tool_response
  const out = r && typeof r === 'object' ? ['stdout', 'stderr'].map((k) => (r as Record<string, unknown>)[k]).filter((v) => typeof v === 'string') : []
  return [...out, ...(typeof body.error === 'string' ? [body.error] : [])].join('\n')
}
const list = (xs: string[]): string => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`
const them = (xs: string[]): string => xs.length > 1 ? 'them' : 'it'
/** The notice's words. `registries`: where agents may download from, in words; `own`: the project's own extra hosts (Bug 425: the user allows
 *  them on the notice or in + Project → Downloads). A refused host already on `own` was allowed after the agent started: Claude Code reads its
 *  sandbox's list once, at the start (real 2.1.322, 2026-11-26: a host added to a running session's settings file stays refused), so it gets it
 *  at its next start. */
export function stoppedWords(who: string, s: Stopped, registries: string, own: string[]): string {
  const out: string[] = [], fresh = s.hosts.filter((h) => !own.includes(h)), late = s.hosts.filter((h) => own.includes(h))
  const others = own.filter((h) => !s.hosts.includes(h))
  if (fresh.length) {
    out.push(`${who} was refused a download from ${list(fresh)}: agents' sandbox lets them download only from ${registries}`
      + `${others.length ? `, and ${list(others)} for this project` : ''}. If the project needs ${them(fresh)}, allow ${them(fresh)} for this project here.`)
  }
  if (late.length) {
    out.push(`${fresh.length ? 'It was also' : `${who} was`} refused ${list(late)}, allowed for this project after it started: it gets ${them(late)} at its next start.`)
  }
  if (s.cert) {
    out.push(`${s.hosts.length ? 'Also, a' : `${who}: a`} download failed the Mac's certificate check, which agents' sandbox blocks: `
      + "pip and Go can't download there (uv, npm and cargo can).")
  }
  return out.join(' ')
}
/** Bug 425: the hosts a notice's words name as refused (stoppedWords wrote them), so the page can offer Allow for each and HQ can tell when
 *  every one is allowed. */
export function refusedHosts(words: string): string[] {
  const hosts = new Set<string>()
  for (const m of words.matchAll(/(?:was refused a download from|was also refused|was refused) (.+?)(?:: agents' sandbox|, allowed for this project after it started)/g)) {
    for (const h of m[1]!.split(/, | and /)) if (h && !/\s/.test(h)) hosts.add(h)
  }
  return [...hosts].sort()
}
/** Whether the notice also says a download failed the Mac's certificate check: allowing hosts doesn't help with that. */
export const certIn = (words: string): boolean => words.includes("failed the Mac's certificate check")

/** Bug 425: a host as the user typed it, as HQ keeps it. */
export const normalHost = (host: string): string => host.trim().toLowerCase().replace(/\.$/, '')
/** Names on the user's own network (and the Mac itself): agents stay off them whatever the user types. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'lan', 'home', 'internal', 'intranet', 'corp', 'localdomain', 'arpa', 'home.arpa']
/** Bug 425: why HQ won't allow `host` for a project's agents, in the user's words, or null when it may. Only a plain host name with a dot
 *  (`github.com`, `codeload.github.com`): Claude Code matches it exactly, so it never covers other hosts. No wildcards (`*.com` would open a whole
 *  top-level domain), no IP addresses, no ports or paths, and no names on the local network (`nas`, `printer.local`). */
export function hostProblem(host0: string): string | null {
  const host = normalHost(host0)
  if (!host) return 'Type a host name, like github.com.'
  if (host.includes('*')) return 'HQ allows one host at a time, by its full name (like github.com): no wildcards.'
  const labels = host.split('.')
  if (labels.every((l) => /^\d+$/.test(l)) || /^\[?[0-9a-f.]*:[0-9a-f:.]*\]?$/.test(host)) return 'HQ allows host names, not IP addresses.'
  if (/[/:@\s]/.test(host)) return 'Only the host\'s name, like github.com: no https://, path or port.'
  if (host.length > 253) return 'That host name is too long.'
  if (labels.some((l) => l.length > 63)) return 'That host name is too long: each part between dots has 63 characters at most.'
  if (labels.some((l) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return `${host} isn't a host name: use letters, digits, dots and dashes, like github.com.`
  if (labels.length < 2) return `${host} is a name on your local network (a full host name has a dot, like github.com): HQ keeps agents off your network.`
  if (!/[a-z]/.test(labels.at(-1)!)) return 'HQ allows host names, not IP addresses.'
  if (LOCAL_SUFFIXES.some((x) => host === x || host.endsWith(`.${x}`))) return `${host} is a name on your local network: HQ keeps agents off your network.`
  return null
}
/** Bug 425: a project's extra hosts (repos.network_allowlist, JSON) as HQ uses them: anything saved some other way that breaks the rules is left out. */
export function ownHosts(json: string | null | undefined): string[] {
  try { const v: unknown = JSON.parse(json || '[]'); return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string' && !hostProblem(h)) : [] } catch { return [] }
}

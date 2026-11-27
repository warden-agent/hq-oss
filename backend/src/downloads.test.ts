// Bugs 412, 415: HQ reads which host an agent's sandbox refused (or that a download failed the Mac's certificate check) from what a Bash command
// printed, as real Claude Code 2.1.322 prints it, and says it in words. What must not count: the same words outside Claude Code's block, a
// certificate error on a machine with no such checker, an ordinary command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { certIn, hookText, hostProblem, normalHost, ownHosts, refusedHosts, REGISTRY_WORDS, stoppedDownloads, stoppedWords } from './downloads.ts'

// Copied from real runs (2026-11-26): `go mod download` with proxy.golang.org off the list, a curl to rubygems.org, and pip / Go on a Mac
const GO = 'go: github.com/google/uuid@v1.6.0: Get "https://proxy.golang.org/github.com/google/uuid/@v/v1.6.0.mod": host is not on the allow list'
const BLOCK = (...lines: string[]) => `<sandbox_violations>\n${lines.join('\n')}\n</sandbox_violations>`
const deny = (host: string) => `deny network-outbound ${host}:443 (host is not on the allow list)`
const PIP = "WARNING: Retrying (Retry(total=0, connect=None, read=None, redirect=None, status=None)) after connection broken by 'SSLCertVerificationError('OSStatus -26276')': /simple/six/"
const GO_CERT = 'Get "https://proxy.golang.org/github.com/google/uuid/@v/v1.6.0.mod": tls: failed to verify certificate: x509: OSStatus -26276'

test('the hosts in Claude Code\'s block, each once and in order; an IPv6 host without its brackets', () => {
  assert.deepEqual(stoppedDownloads(`Exit code 1\n${GO}\n\n${BLOCK(deny('proxy.golang.org'), deny('proxy.golang.org'))}`, true), { hosts: ['proxy.golang.org'], cert: false })
  assert.deepEqual(stoppedDownloads(BLOCK(deny('rubygems.org'), deny('index.rubygems.org'), 'deny network-outbound [2001:db8::1]:443 (host is not on the allow list)'), false),
    { hosts: ['2001:db8::1', 'index.rubygems.org', 'rubygems.org'], cert: false })
})

test('what must not count: the words outside the block (a file the agent printed), another kind of violation, an ordinary command', () => {
  assert.equal(stoppedDownloads(`${deny('evil.example')}\nok`, true), null)
  assert.equal(stoppedDownloads(BLOCK('deny file-write-create /Users/me/.npmrc'), true), null)
  assert.equal(stoppedDownloads('added 1 package in 248ms', true), null)
  assert.equal(stoppedDownloads('', true), null)
})

test('a certificate error counts on a Mac only (pip and Go use its checker), and goes with the hosts', () => {
  assert.deepEqual(stoppedDownloads(PIP, true), { hosts: [], cert: true })
  assert.deepEqual(stoppedDownloads(GO_CERT, true), { hosts: [], cert: true })
  assert.equal(stoppedDownloads(GO_CERT, false), null) // a Mac whose agents may use the checker, or Linux: that's another problem
  assert.deepEqual(stoppedDownloads(`${GO_CERT}\n${BLOCK(deny('rubygems.org'))}`, true), { hosts: ['rubygems.org'], cert: true })
})

test('the text comes from the output when the command ended normally and from the error when it didn\'t', () => {
  const v = BLOCK(deny('proxy.golang.org'))
  assert.equal(hookText({ tool_response: { stdout: GO, stderr: v, interrupted: false } }), `${GO}\n${v}`)
  assert.equal(hookText({ error: `Exit code 1\n${GO}\n\n${v}` }), `Exit code 1\n${GO}\n\n${v}`)
  assert.equal(hookText({ tool_response: 'odd' }), '')
  assert.deepEqual(stoppedDownloads(hookText({ tool_response: { stdout: GO, stderr: v } }), true), { hosts: ['proxy.golang.org'], cert: false })
})

test('the words name the agent, the refused hosts and where agents may download from, the project\'s own hosts too, and say the user can allow them', () => {
  assert.equal(stoppedWords('Ana', { hosts: ['rubygems.org'], cert: false }, REGISTRY_WORDS, []),
    "Ana was refused a download from rubygems.org: agents' sandbox lets them download only from npm, PyPI, crates.io and Go's module mirror."
    + ' If the project needs it, allow it for this project here.')
  assert.equal(stoppedWords('Ana', { hosts: ['a.example', 'b.example', 'c.example'], cert: false }, 'npm', ['api.example.com']),
    "Ana was refused a download from a.example, b.example and c.example: agents' sandbox lets them download only from npm, and api.example.com for this project."
    + ' If the project needs them, allow them for this project here.')
  assert.equal(stoppedWords('Ana', { hosts: [], cert: true }, REGISTRY_WORDS, []),
    "Ana: a download failed the Mac's certificate check, which agents' sandbox blocks: pip and Go can't download there (uv, npm and cargo can).")
  assert.match(stoppedWords('Ana', { hosts: ['rubygems.org'], cert: true }, REGISTRY_WORDS, []), /allow it for this project here\. Also, a download failed the Mac's certificate check/)
})

test('Bug 425: a refused host the user allowed after the agent started is said as that (its session keeps the old list), not as allowed', () => {
  assert.equal(stoppedWords('Ana', { hosts: ['github.com'], cert: false }, 'npm', ['github.com']),
    'Ana was refused github.com, allowed for this project after it started: it gets it at its next start.')
  assert.equal(stoppedWords('Ana', { hosts: ['codeload.github.com', 'github.com'], cert: false }, 'npm', ['github.com', 'x.example']),
    "Ana was refused a download from codeload.github.com: agents' sandbox lets them download only from npm, and x.example for this project."
    + ' If the project needs it, allow it for this project here. It was also refused github.com, allowed for this project after it started: it gets it at its next start.')
})

test('Bug 425: the hosts read back from the words, every shape stoppedWords writes; the registries and the project\'s other hosts are not among them', () => {
  const words = (hosts: string[], own: string[], cert = false) => stoppedWords("T-01's engineer", { hosts, cert }, REGISTRY_WORDS, own)
  for (const [hosts, own] of [[['rubygems.org'], []], [['a.example', 'b.example', 'c.example'], ['z.example']], [['github.com'], ['github.com']],
    [['codeload.github.com', 'github.com', 'objects.githubusercontent.com'], ['github.com', 'other.example']], [['2001:db8::1', 'x.example'], []]] as [string[], string[]][]) {
    assert.deepEqual(refusedHosts(words(hosts, own)), [...hosts].sort(), hosts.join(' '))
    assert.deepEqual(refusedHosts(words(hosts, own, true)), [...hosts].sort())
  }
  assert.deepEqual(refusedHosts(words([], [], true)), []); assert.equal(certIn(words([], [], true)), true); assert.equal(certIn(words(['a.example'], [])), false)
  assert.deepEqual(refusedHosts('Ana: Stuck on a test.'), [])
})

test('Bug 425: a host HQ allows is one plain name with a dot; wildcards, IP addresses, ports, paths and local network names are refused in words', () => {
  for (const ok of ['github.com', 'GitHub.com.', ' codeload.github.com ', 'objects.githubusercontent.com', 'repo1.maven.org', 'xn--bcher-kva.example', 'a-b.co.uk', 'x.io']) {
    assert.equal(hostProblem(ok), null, ok)
  }
  assert.equal(normalHost(' GitHub.com. '), 'github.com')
  const no = (h: string, re: RegExp) => assert.match(hostProblem(h) ?? 'allowed', re, h)
  no('', /Type a host name/); no('   ', /Type a host name/)
  for (const h of ['*.com', '*', '*.github.com', 'git*.com']) no(h, /no wildcards/)
  for (const h of ['10.0.0.5', '192.168.1.20', '127.0.0.1', '8.8.8.8', '::1', '[::1]', '2001:db8::1', 'fe80::1']) no(h, /not IP addresses/)
  for (const h of ['https://github.com', 'github.com/foo', 'github.com:443', 'user@github.com', 'git hub.com']) no(h, /Only the host's name/)
  for (const h of ['localhost', 'nas', 'printer.local', 'router.lan', 'db.internal', 'x.home.arpa', 'box.localhost', '1.0.0.10.in-addr.arpa']) no(h, /local network/)
  for (const h of ['-bad.com', 'bad-.com', 'a..com', 'under_score.com', 'café.com']) no(h, /isn't a host name/)
  no(`${['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(60)).join('.')}.com`, /too long/); no(`${'a'.repeat(64)}.com`, /63 characters/)
})

test('Bug 425: the project\'s list as HQ uses it: bad JSON, odd values and entries that break the rules are left out', () => {
  assert.deepEqual(ownHosts('["github.com","*.com",3,"10.0.0.1","x.example"]'), ['github.com', 'x.example'])
  assert.deepEqual(ownHosts('nope'), []); assert.deepEqual(ownHosts(null), []); assert.deepEqual(ownHosts('{"a":1}'), [])
})

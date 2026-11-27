// Bugs 412, 415: an engineer's command is refused a download by its sandbox. Claude Code's hook carries the refused host (real 2.1.322's words) and
// HQ says it in one notice for that engineer, which newer words replace and the same words leave alone; a command with no refusal and the
// TPM's commands (no sandbox) raise nothing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

const block = (...hosts: string[]) => `<sandbox_violations>\n${hosts.map((h) => `deny network-outbound ${h}:443 (host is not on the allow list)`).join('\n')}\n</sandbox_violations>`
const GO = 'go: github.com/google/uuid@v1.6.0: Get "https://proxy.golang.org/github.com/google/uuid/@v/v1.6.0.mod": host is not on the allow list'
/** What Claude Code's hook says of a Bash command once it's over: `error` when it exited non-zero, else its output. */
const bash = (id: string, command: string, o: { stdout?: string; stderr?: string; error?: string }) => hq.hook(id, { hook_event_name: o.error ? 'PostToolUseFailure' : 'PostToolUse',
  tool_name: 'Bash', tool_input: { command }, tool_use_id: `toolu_${id}_${Math.random().toString(36).slice(2)}`,
  ...(o.error ? { error: o.error } : { tool_response: { stdout: o.stdout ?? '', stderr: o.stderr ?? '', interrupted: false } }) })

test('Bugs 412, 415: a download the sandbox refused shows as one notice naming the host and where agents may download from', async () => {
  const dir = hq.repo('b412dl')
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/b412dl\n\ngo 1.22\n'); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'go')
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'b412dl', request: 'Build it' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Ids', size: 'S', spec: 'Ids.' })).json
  await hq.api(`tickets/${t.id}/launch`, {})
  const e = await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  const notices = async () => (await hq.state()).attention.filter((a: any) => a.kind === 'download_refused' && !a.resolved_at)
  const events = async () => (await hq.state()).attention.filter((a: any) => a.kind === 'download_refused').length

  // What must not count: an ordinary command, a failed one, the words printed by the agent itself, the TPM (no sandbox)
  await bash(e.id, 'npm test', { stdout: 'ok 1 - ok' }); await bash(e.id, 'npm test', { error: 'Exit code 1\nnot ok 1' })
  await bash(e.id, 'cat notes.txt', { stdout: 'deny network-outbound evil.example:443 (host is not on the allow list)' })
  await bash(tpm.id, 'go mod download', { error: `Exit code 1\n${GO}\n\n${block('proxy.golang.org')}` })
  assert.deepEqual(await notices(), [])

  // Exit 0 (the block comes in stderr), then the same again: one notice, said once
  await bash(e.id, 'go mod download', { stdout: GO, stderr: block('proxy.golang.org') })
  const [one] = await notices()
  assert.equal(one?.agent_id, e.id); assert.equal(one?.ticket_id, t.id)
  assert.match(one.detail, /^.+ was refused a download from proxy\.golang\.org: agents' sandbox lets them download only from npm, PyPI, crates\.io and Go's module mirror\./)
  assert.match(one.detail, /If the project needs it, allow it for this project here\.$/) // Bug 425: and the notice has the button
  await bash(e.id, 'go mod download', { stdout: GO, stderr: block('proxy.golang.org') })
  assert.equal(await events(), 1, 'the same words again change nothing')

  // A failed command (the block comes in `error`) refused another host: newer words take the notice's place
  await bash(e.id, 'bundle install', { error: `Exit code 1\nCould not reach rubygems.org\n\n${block('rubygems.org', 'index.rubygems.org')}` })
  const now = await notices(); assert.equal(now.length, 1); assert.notEqual(now[0].id, one.id)
  assert.match(now[0].detail, /was refused a download from index\.rubygems\.org and rubygems\.org:/)
})

test('Bug 425: the user allows a refused host for the project; a running engineer keeps its old list, the next one has it; the notice goes once all is done', async () => {
  const dir = hq.repo('b425allow')
  fs.writeFileSync(path.join(dir, 'Gemfile'), "source 'https://rubygems.org'\n"); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'gems')
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'b425allow', request: 'Build it' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Gems', size: 'S', spec: 'Gems.' })).json
  await hq.api(`tickets/${t.id}/launch`, {})
  const live = async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status !== 'exited')
  const e = await waitFor('the engineer', async () => { const a = await live(); return a?.status === 'working' ? a : undefined })
  const allowed = (id: string): string[] => JSON.parse(fs.readFileSync(path.join(hq.hqHome, 'agents', id, 'settings.json'), 'utf8')).sandbox.network.allowedDomains
  assert.ok(!allowed(e.id).includes('github.com'))
  const allow = (host: string, on = true) => hq.api(`repos/${repo.id}/allowed-hosts`, { host, allow: on })
  const list = async () => JSON.parse((await hq.state()).repos.find((r: any) => r.id === repo.id).network_allowlist)
  const notice = async () => (await hq.state()).attention.find((a: any) => a.kind === 'download_refused' && a.agent_id === e.id && !a.resolved_at)

  await bash(e.id, 'bundle install', { error: `Exit code 1\n\n${block('github.com', 'rubygems.org')}` })
  const n = await waitFor('the notice', notice)
  assert.match(n.detail, /refused a download from github\.com and rubygems\.org: .*If the project needs them, allow them for this project here\./)

  // What HQ refuses, in words, and changes nothing for
  for (const [host, re] of [['*.com', /no wildcards/], ['192.168.1.20', /not IP addresses/], ['nas', /local network/], ['printer.local', /local network/],
    ['https://github.com/x', /Only the host's name/], ['', /Type a host name/], ['pypi.org', /already allowed for every project/]] as [string, RegExp][]) {
    const r = await allow(host); assert.equal(r.status, 400, host); assert.match(r.json.error, re)
  }
  assert.equal((await hq.api('repos/nope/allowed-hosts', { host: 'github.com' })).status, 400)
  assert.deepEqual(await list(), [])

  // Allowed (twice: a double click is once). The running engineer keeps the list it started with, so its notice stays; the TPM hears it once
  const r = await allow(' GitHub.com '); assert.equal(r.status, 200); assert.deepEqual(r.json.hosts, ['github.com'])
  assert.equal((await allow('github.com')).status, 200)
  assert.deepEqual(await list(), ['github.com'])
  const told = await waitFor('the TPM told', async () => (await hq.state()).messages.filter((m: any) => m.to_id === tpm.id && m.body.includes('allowed downloads from github.com')))
  assert.equal(told.length, 1); assert.match(told[0].body, new RegExp(`${e.display_name}.* started before that, so it gets it only after a Fresh start`))
  assert.equal((await notice())?.id, n.id, 'rubygems.org is still refused, and the engineer still has its old list')
  assert.ok(!allowed(e.id).includes('github.com'))

  // The same engineer refused github.com again: said as allowed after it started, not as a new refusal
  await bash(e.id, 'bundle install', { error: `Exit code 1\n\n${block('github.com')}` })
  const late = await waitFor('the newer words', async () => { const x = await notice(); return x && x.id !== n.id ? x : undefined })
  assert.match(late.detail, /was refused github\.com, allowed for this project after it started: it gets it at its next start\.$/)
  await bash(e.id, 'bundle install', { error: `Exit code 1\n\n${block('github.com', 'rubygems.org')}` }) // both again, for what follows
  await waitFor('both hosts named', async () => { const x = await notice(); return x?.detail.includes('rubygems.org') ? x : undefined })

  // The engineer ends with rubygems.org still refused: the notice stays (what must not go)
  assert.equal((await hq.api(`agents/${e.id}/stop`, {})).status, 200)
  await waitFor('the engineer stopped', async () => !(await live()))
  assert.ok(await notice(), 'a host the user hasn\'t allowed keeps its notice')
  // ... and once the last host is allowed, with its engineer gone, it goes at once
  assert.equal((await allow('rubygems.org')).status, 200)
  await waitFor('the notice gone', async () => !(await notice()))
  assert.deepEqual(await list(), ['github.com', 'rubygems.org'])

  // The next engineer starts with both
  await hq.api(`tickets/${t.id}/launch`, {})
  const e2 = await waitFor('a new engineer', async () => { const a = await live(); return a && a.id !== e.id ? a : undefined })
  for (const h of ['github.com', 'rubygems.org', 'registry.npmjs.org']) assert.ok(allowed(e2.id).includes(h), h)

  // Taken off again: the list shrinks, a repeat changes nothing, and the next start leaves it out
  const off = await allow('github.com', false); assert.equal(off.status, 200); assert.deepEqual(off.json.hosts, ['rubygems.org'])
  assert.equal((await allow('github.com', false)).status, 200); assert.deepEqual(await list(), ['rubygems.org'])
  assert.ok(allowed(e2.id).includes('github.com'), 'the running engineer keeps its list until its next start')
  assert.equal((await hq.state()).messages.filter((m: any) => m.to_id === tpm.id && m.body.includes('github.com')).length, 1, 'a removal tells the TPM nothing')
  assert.equal((await allow('b425.example')).status, 200) // allowed before anything was refused it: nothing for the TPM to act on
  assert.equal((await hq.state()).messages.filter((m: any) => m.to_id === tpm.id && m.body.includes('allowed downloads from')).length, 2, 'github.com and rubygems.org only')
  const db = hq.db({ readOnly: true })
  try {
    const kinds = db.prepare("SELECT kind, payload FROM events WHERE kind LIKE 'repo.host_%' ORDER BY id").all().map((x: any) => `${x.kind} ${JSON.parse(x.payload).host}`)
    assert.deepEqual(kinds, ['repo.host_allowed github.com', 'repo.host_allowed rubygems.org', 'repo.host_removed github.com', 'repo.host_allowed b425.example'])
  } finally { db.close() }
})

test('Bug 425: a refusal notice of an engineer that has ended goes when the user allows its hosts; one that also failed a certificate check stays', async () => {
  const dir = hq.repo('b425ended')
  await hq.api('settings', { key: 'concurrency_cap', value: 6 }) // the earlier tests' engineers are still running
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'b425ended', request: 'Build it' })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const engineers: any[] = [] // the earlier tests' notices are still open
  const notices = async () => (await hq.state()).attention.filter((a: any) => a.kind === 'download_refused' && !a.resolved_at && engineers.some((x) => x.id === a.agent_id))
  for (const title of ['One', 'Two']) {
    const t = (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: title })).json
    await hq.api(`tickets/${t.id}/launch`, {})
    engineers.push(await waitFor(`engineer ${title}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working')))
  }
  const [one, two] = engineers
  await bash(one.id, 'curl https://b425.example/x', { error: `Exit code 56\n\n${block('b425.example')}` })
  const cert = process.platform === 'darwin' ? '\ntls: failed to verify certificate: x509: OSStatus -26276' : ''
  await bash(two.id, 'go mod download', { error: `Exit code 1${cert}\n\n${block('b425.example')}` })
  await waitFor('two notices', async () => (await notices()).length === 2)
  for (const a of engineers) { assert.equal((await hq.api(`agents/${a.id}/stop`, {})).status, 200) }
  await waitFor('both stopped', async () => (await hq.state()).agents.filter((a: any) => engineers.some((x) => x.id === a.id) && a.status === 'exited').length === 2)
  assert.equal((await hq.api(`repos/${repo.id}/allowed-hosts`, { host: 'b425.example' })).status, 200)
  // On a Mac the second also says pip and Go can't pass the certificate check there, which no host fixes: it stays. Elsewhere there's no such check
  const want = process.platform === 'darwin' ? [two.id] : []
  await waitFor('the notices settled', async () => (await notices()).map((a: any) => a.agent_id).join() === want.join())
})

// Auto mode's one-shot reader (checker.ts) and what HQ keeps of its answers (checks.ts): the rules a finding is held to whatever the reader says, the call
// itself against a stand-in for Claude Code (e2e/fake-claude.mjs in `-p` mode: no model, no tokens), every way the call can end, and the words for the page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-checker-'))
process.env.HQ_HOME = path.join(home, 'hq'); process.env.HOME = home // the stand-in logs each call under HOME
process.env.HQ_CLAUDE_BIN = path.join(import.meta.dirname, '..', 'e2e', 'fake-claude.mjs'); process.env.HQ_CHECK_TIMEOUT_S = '2'
process.env.CLAUDECODE = '1'; process.env.CLAUDE_CODE_ENTRYPOINT = 'cli' // as when the backend was started from inside a Claude Code session
const { migrate } = await import('./db.ts'); migrate()
const { ask, keepFindings, killChecks } = await import('./checker.ts')
const { diffCheckLine, diffCheckOf, diffCheckWords, findingLines, planCheckLine, planCheckOf, planCheckWords } = await import('./checks.ts')

const calls = (): any[] => { try { return fs.readFileSync(path.join(home, 'fake-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] } }
const say = (answer: unknown) => `What the reader reads.\nFAKE-CHECK: ${typeof answer === 'string' ? answer : JSON.stringify(answer)}\n`
const q = (prompt: string, signal?: AbortSignal) => ask({ system: 'You are a second reader.', prompt, ids: ['A1', 'A2'], other: 'extra', signal })
const gone = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }

test('a finding is kept only if it is about a criterion of the ticket or the check\'s own kind, says something, and is one of the first three', () => {
  const f = (about: string, problem = 'No step builds the label, and no test covers it.') => ({ about, problem })
  assert.deepEqual(keepFindings([f('a2'), f('Extra'), f('style'), f('A9'), f('A1', 'Bad.'), null, 'A1', { about: 'A1' }], ['A1', 'A2'], 'extra'), [f('A2'), f('extra')])
  assert.deepEqual(keepFindings([f('A1'), f('A2'), f('extra'), f('A1')], ['A1', 'A2'], 'extra').map((x) => x.about), ['A1', 'A2', 'extra']) // at most three
  assert.deepEqual(keepFindings([f('bug'), f('extra')], [], 'bug'), [f('bug')]) // a ticket with no criteria: only the check's own kind
  assert.deepEqual(keepFindings('not a list', ['A1'], 'extra'), []); assert.equal(keepFindings([f('A1', `x${' long'.repeat(200)}`)], ['A1'], 'extra')[0]!.problem.length, 600)
  assert.equal(findingLines([f('A2', 'One.'), f('extra', 'Two.')]), '- A2: One.\n- extra: Two.')
})
test('one call: no tools, no MCP, the prompt on its input, none of a Claude Code session\'s own variables; the answer is the findings that keep to the rules', async () => {
  const a = await q(say({ verdict: 'send_back', findings: [{ about: 'A2', problem: 'No step shows the total in bold.' }, { about: 'tone', problem: 'I would have written it differently.' }] }))
  assert.ok(a.kind === 'answer', JSON.stringify(a)); assert.deepEqual(a.findings, [{ about: 'A2', problem: 'No step shows the total in bold.' }])
  assert.equal(a.tokens, 1802); assert.equal(a.model, 'opus'); assert.ok(a.ms >= 0)
  const c = calls().at(-1); assert.equal(c.tools, ''); assert.equal(c.system, 'You are a second reader.'); assert.match(c.prompt, /^What the reader reads\./)
  assert.deepEqual(c.claudeEnv, []) // CLAUDECODE and friends would make it a session inside a session
  const ok = await q('Nothing to say about this one.'); assert.ok(ok.kind === 'answer'); assert.deepEqual(ok.findings, [])
  const lost = await q(say({ verdict: 'ok', findings: [{ about: 'A1', problem: 'Said ok, and then listed a finding anyway.' }] }))
  assert.ok(lost.kind === 'answer'); assert.deepEqual(lost.findings, [])
})
test('every way a call can fail is an error with why, never an answer', async () => {
  assert.deepEqual(await q(say('error')), { kind: 'error', why: 'API Error: Overloaded' })
  assert.deepEqual(await q(say('garbage')), { kind: 'error', why: "the answer wasn't in the form HQ asked for" })
  assert.deepEqual(await q(say({ verdict: 'maybe', findings: [] })), { kind: 'error', why: "the answer wasn't in the form HQ asked for" })
  assert.deepEqual(await q(say('crash')), { kind: 'error', why: 'Error: the stand-in fell over' })
  const before = calls().length, slow = await q(say('hang')); assert.deepEqual(slow, { kind: 'error', why: 'no answer within 2 s' })
  assert.ok(gone(calls()[before].pid), 'a call past its time limit is ended, not left behind')
})
test('a call that is stopped, or whose backend goes down, ends at once and says nothing', async () => {
  const c = new AbortController(), before = calls().length, asked = q(say('hang'), c.signal)
  for (const end = Date.now() + 3000; calls().length === before && Date.now() < end;) await new Promise((r) => setTimeout(r, 50))
  c.abort(); assert.deepEqual(await asked, { kind: 'stopped' }); assert.ok(gone(calls()[before].pid))
  const done = new AbortController(); done.abort(); assert.deepEqual(await q('never asked', done.signal), { kind: 'stopped' }); assert.equal(calls().length, before + 1)
  const n = calls().length, down = q(say('hang'))
  for (const end = Date.now() + 3000; calls().length === n && Date.now() < end;) await new Promise((r) => setTimeout(r, 50))
  killChecks(); assert.equal((await down).kind, 'error'); assert.ok(gone(calls()[n].pid)) // the backend's own stop: nobody reads what it says
})

test('what HQ keeps of a check reads back, and says in words what the page and the summary need', () => {
  const cost = { at: 5, ms: 2400, tokens: 1802, model: 'opus' }, findings = [{ about: 'A2', problem: 'No step shows the total in bold.' }]
  assert.equal(planCheckOf(null), null); assert.equal(planCheckOf('not json'), null); assert.equal(planCheckOf('{}'), null); assert.equal(diffCheckOf({ diff_check: null }), null)
  assert.deepEqual(planCheckOf(JSON.stringify({ state: 'ok', ...cost })), { state: 'ok', ...cost })
  assert.equal(planCheckLine([]), null); assert.equal(planCheckLine([{ state: 'ok', ...cost }, { state: 'checking', since: 1 }]), null) // a clean check is no news
  assert.equal(planCheckLine([{ state: 'ok', ...cost }, { state: 'sent_back', findings, ...cost }]), 'its plan was sent back once (A2: No step shows the total in bold.)')
  assert.equal(planCheckLine([{ state: 'unchecked', at: 1, why: "the check couldn't run (API Error: Overloaded)" }]), "its plan wasn't checked: the check couldn't run (API Error: Overloaded)")
  assert.deepEqual(planCheckWords({ state: 'sent_back', findings, ...cost }), { text: 'A fresh reader checked its plan against the criteria and sent it back once:', tone: 'look', findings })
  assert.equal(planCheckWords({ state: 'ok', ...cost })!.tone, 'ok'); assert.equal(planCheckWords({ state: 'checking', since: 1 })!.tone, 'none'); assert.equal(planCheckWords(null), null)
  assert.equal(diffCheckLine(null), null); assert.equal(diffCheckLine({ state: 'ok', why: ['size M'], ...cost }), null)
  assert.equal(diffCheckLine({ state: 'sent_back', why: ['size M'], findings, ...cost }), "HQ's read of its changes sent it back once (A2: No step shows the total in bold.)")
  assert.equal(diffCheckLine({ state: 'unchecked', at: 1, why: ['size M'], error: 'no answer within 180 s' }), "its changes weren't read before it merged: no answer within 180 s")
  assert.equal(diffCheckWords({ state: 'ok', why: ['it is a size M ticket', 'it deleted tests'], ...cost })!.text,
    'A fresh reader read its changes before it merged (it is a size M ticket; it deleted tests) and found nothing wrong.')
  assert.equal(diffCheckWords({ state: 'unchecked', at: 1, why: [], error: 'no answer within 180 s' })!.text, 'Nobody read its changes before it merged: no answer within 180 s.')
})

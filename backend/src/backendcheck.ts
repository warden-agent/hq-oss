// The backend checker (Part 5): after the UI tester's scenarios have all run, a fresh reader judges what the backend did in each one against the project's
// backend criteria. It reads HQ's recordings (Part 3's timelines, made by HQ's code: API calls, server log lines, data diffs, flags), never the app live, and
// nothing it thinks goes back to the tester. It may read the code to know where to look, and a scenario's raw logs when a timeline row isn't enough; it can't
// run anything or change anything.
// Limits are HQ's, not the prompt's: one headless Claude Code call per batch of scenarios (a fresh session each, so context doesn't grow), its only tools
// Read, Grep and Glob, no MCP servers (not even the user's own connectors: --strict-mcp-config), working in a throwaway checkout of main, with the batch's
// recording folders added and nothing else in reach.
// Spike on the real 2.1.322, 2026-11-17: with `--tools Read,Grep,Glob` there is no Bash, Edit or Write; Read inside the working folder works, and Read of
// ~/.hq/ui-token or any other file outside it is refused ("Claude requested permissions to read …") as a permission denial; structured output still works.
import { DEFAULTS } from './config.ts'
import { getSetting, q } from './db.ts'
import { call, PLAIN } from './checker.ts'
import { criteriaOf } from './criteria.ts'
import { features, tickets, type Repo, type Ticket } from './records.ts'
import { autoGen, inCheckout } from './testrun.ts'
import { git } from './repos.ts'
import { mergeBase } from './conflicts.ts'
import { inputs, type Endpoint, type Recorded, type ScenarioRun } from './loopinputs.ts'
import type { Fresh, Source } from './findingrules.ts'

export const BATCH = Number(process.env.HQ_CHECK_BATCH) || 8
const TIMEOUT_MS = (Number(process.env.HQ_BACKEND_CHECK_TIMEOUT_S) || 900) * 1000
const MAX_CRITERIA = 80, MAX_ROWS = 120, MAX_PER_SCENARIO = 3
/** The checker's model: Opus, unless the user has set one for it. */
const model = (): string => (getSetting('models', DEFAULTS.models) as Record<string, string>).checker ?? 'opus'

const repoTickets = (repoId: string): Ticket[] => features().filter((f) => f.repo_id === repoId && f.status !== 'cancelled').flatMap((f) => tickets(f.id))
/** Main as the run leaves it. */
export const ref = (repo: Repo): Promise<string> => git(repo.path, 'rev-parse', '--verify', '--quiet', `${mergeBase(repo).ref}^{commit}`).catch(() => '')
export type Named = { name: string; text: string } // a backend criterion as the checker sees it: "T-03 A4"
/** What the checker said about one scenario: a clean one gets one line; a flagged one its findings with reasoning. */
export type Verdict = { scenario: string; clean: boolean; line: string; findings: { type: Source; criterion?: string; what: string; expected: string; why: string; rows: string[] }[] }

export const CHECKER_SYSTEM = `You check what a web app's backend did while a tester used it, against the backend acceptance criteria. You read recordings, not
the live app: for each scenario, a timeline HQ's code recorded (what the tester did, each API call with its status and time, server log lines, what changed
in the stored data, browser errors). Rows marked ⚠ are flags HQ's code raised: the same call twice in one action, a call much slower than that endpoint's
normal, an error status, a console error, a failed request.

You may read the app's code (the folder you are in) only to know where to look, and a scenario's raw logs (its folder is named in the prompt) when a timeline
row isn't enough. Judge against the criteria, never against what the code happens to do: code that does the wrong thing on purpose is still wrong.

For each scenario:
- Nothing wrong: clean, with one line saying what the backend did.
- Something wrong: a finding per problem (at most ${MAX_PER_SCENARIO}). type "backend" when it breaks a backend criterion (name it exactly as given, like
  "T-03 A4"), "ui" when the problem is what the user saw, "unspecified" when it is plainly wrong but no criterion covers it (two calls racing, stale data in
  another tab, a record nobody asked for). Say what happened, what should have, and why you think so; quote the timeline rows that show it, exactly.
- A flag is not a finding by itself: a slow call the user never noticed, or a 404 the app expects, can be fine. Say why when you let a flag go.
Never invent rows. Never guess at what you can't see in the recordings.`

const SCHEMA = JSON.stringify({ type: 'object', required: ['scenarios'], properties: { scenarios: { type: 'array', items: { type: 'object', required: ['scenario', 'clean', 'line', 'findings'],
  properties: { scenario: { type: 'string' }, clean: { type: 'boolean' }, line: { type: 'string' }, findings: { type: 'array', maxItems: MAX_PER_SCENARIO, items: { type: 'object',
    required: ['type', 'what', 'expected', 'why', 'rows'], properties: { type: { type: 'string', enum: ['ui', 'backend', 'unspecified'] }, criterion: { type: 'string' },
      what: { type: 'string' }, expected: { type: 'string' }, why: { type: 'string' }, rows: { type: 'array', items: { type: 'string' } } } } } } } } } })

/** The project's backend criteria, newest tickets first, named "T-03 A4": every merged ticket's, because the tester used the whole app. */
export function backendCriteria(repoId: string): Named[] {
  return repoTickets(repoId).filter((t) => t.status === 'merged').sort((a, b) => b.updated_at - a.updated_at)
    .flatMap((t) => criteriaOf(t).filter((c) => c.kind === 'backend').map((c) => ({ name: `${t.key} ${c.id}`, text: c.text }))).slice(0, MAX_CRITERIA)
}
/** The choices the TPM made for the user in auto mode, per feature and for the project: "feature decisions". */
export function decisions(repoId: string): string[] {
  const scopes = [`repo:${repoId}`, ...features().filter((f) => f.repo_id === repoId && f.status !== 'cancelled').map((f) => `feature:${f.id}`)]
  return scopes.flatMap((s) => q<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key = 'Decided in auto mode'", s).map((d) => d.text.trim())).filter(Boolean)
}
const rowsOf = (rec: Recorded): string => {
  const md = rec.markdown.split('\n')
  return md.length > MAX_ROWS ? [...md.slice(0, MAX_ROWS), `| … | ${md.length - MAX_ROWS} more rows: see timeline.md in the folder |`].join('\n') : md.join('\n')
}
export function checkerPrompt(o: { criteria: Named[]; decisions: string[]; endpoints: Endpoint[]; batch: { run: ScenarioRun; rec: Recorded }[] }): string {
  return [`## Backend criteria\n${o.criteria.map((c) => `- ${c.name}: ${c.text}`).join('\n') || '- (none: every finding is unspecified)'}`,
    o.decisions.length ? `## Choices made for the user\n${o.decisions.join('\n')}` : '',
    o.endpoints.length ? `## Endpoints and how much work each does\n${o.endpoints.map((e) => `- ${e.method} ${e.path}: ${e.kind}`).join('\n')}` : '',
    ...o.batch.map(({ run: s, rec }) => `## Scenario ${s.scenario.id}: ${s.scenario.title}\nGoal: ${s.scenario.goal}\nRaw logs: ${rec.dir}\n\n${rowsOf(rec)}`),
  ].filter(Boolean).join('\n\n')
}
const line = (s: unknown, max: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
/** What HQ keeps of the checker's answer, whatever it wrote: only scenarios it was given, criteria by their exact names (a finding that names one that
 *  doesn't exist is unspecified), rows only when the timeline has them (no invented evidence), at most three findings a scenario. */
export function keepVerdicts(raw: unknown, batch: { run: ScenarioRun; rec: Recorded }[], names: string[]): Verdict[] {
  const list = Array.isArray((raw as { scenarios?: unknown })?.scenarios) ? (raw as { scenarios: Record<string, unknown>[] }).scenarios : []
  return batch.map(({ run: s, rec }) => {
    const v = list.find((x) => line(x?.scenario, 40) === s.scenario.id)
    if (!v) return { scenario: s.scenario.id, clean: false, line: 'the checker said nothing about it', findings: [] }
    const real = new Set(rec.timeline.map((r) => r.text)), md = rec.markdown
    const findings = (Array.isArray(v.findings) ? v.findings as Record<string, unknown>[] : []).slice(0, MAX_PER_SCENARIO).map((f) => {
      const named = names.find((n) => n.toLowerCase() === line(f.criterion, 40).toLowerCase())
      const type: Source = f.type === 'ui' ? 'ui' : named && f.type === 'backend' ? 'backend' : 'unspecified'
      const rows = (Array.isArray(f.rows) ? f.rows : []).map((r) => line(r, 300)).filter((r) => r && (real.has(r) || md.includes(r) || [...real].some((x) => r.includes(x)))).slice(0, 12)
      return { type, ...(type === 'backend' ? { criterion: named } : {}), what: line(f.what, 400), expected: line(f.expected, 300), why: line(f.why, 600), rows }
    }).filter((f) => f.what.length >= 10)
    return { scenario: s.scenario.id, clean: !findings.length && v.clean === true, line: line(v.line, 200), findings }
  })
}
/** A verdict's findings as the loop keeps them: the scenario's steps are their reproduction, and the flags on the rows they quote are their flags. */
export function freshFrom(v: Verdict, s: ScenarioRun, rec: Recorded): Fresh[] {
  return v.findings.map((f) => {
    const flags = rec.timeline.filter((r) => r.flags.length && f.rows.some((x) => x.includes(r.text) || r.text.includes(x))).flatMap((r) => r.flags)
    return { source: f.type, by: 'checker' as const, what: f.what, expected: f.expected, criterion: f.criterion, steps: s.steps,
      evidence: { scenario: s.scenario.id, goal: s.scenario.goal, recording: rec.id, rows: f.rows.length ? f.rows : [`(no rows quoted) ${f.why}`.slice(0, 300)], flags } }
  })
}

export type CheckedRun = { findings: Fresh[]; verdicts: Verdict[]; note?: string; ms: number; tokens: number }
/** Judges every recorded scenario of a run, a batch at a time. Scenarios with no recording are left out and said once in `note`. */
export async function checkRun(repo: Repo, runId: string, scenarios: ScenarioRun[], gen = autoGen(repo.path)): Promise<CheckedRun | 'stopped'> {
  const recs = scenarios.map((s) => ({ run: s, rec: s.recording ? inputs().recording(repo.id, s.recording) : null })), have = recs.filter((x): x is { run: ScenarioRun; rec: Recorded } => !!x.rec)
  const missing = recs.length - have.length, out: CheckedRun = { findings: [], verdicts: [], ms: 0, tokens: 0 }
  const notes: string[] = missing ? [`${missing} of ${recs.length} scenarios had no recording, so the backend checker couldn't judge them`] : []
  if (!have.length) return { ...out, note: notes.join('; ') || undefined }
  const criteria = backendCriteria(repo.id), names = criteria.map((c) => c.name), dec = decisions(repo.id), endpoints = inputs().endpoints(repo.id), sha = await ref(repo)
  const r = await inCheckout(repo.path, sha, 'checker', gen, { repoId: repo.id, ticketId: null, what: 'checker' }, async (wt, signal) => {
    for (let i = 0; i < have.length; i += BATCH) {
      const batch = have.slice(i, i + BATCH), m = model()
      const c = await call({ cwd: wt, signal, timeoutMs: TIMEOUT_MS, prompt: checkerPrompt({ criteria, decisions: dec, endpoints, batch }),
        args: ['--model', m, '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...batch.flatMap((b) => ['--add-dir', b.rec.dir]),
          ...PLAIN, '--json-schema', SCHEMA, '--system-prompt', CHECKER_SYSTEM] })
      if (c.kind === 'stopped') return 'stopped' as const
      if (c.kind === 'error') { notes.push(`the backend checker couldn't judge ${batch.map((b) => b.run.scenario.id).join(', ')} (${c.why})`); continue }
      out.ms += c.ms; out.tokens += c.tokens
      for (const v of keepVerdicts(c.r.structured_output, batch, names)) {
        out.verdicts.push(v); const b = batch.find((x) => x.run.scenario.id === v.scenario)!; out.findings.push(...freshFrom(v, b.run, b.rec))
      }
    }
    return 'done' as const
  })
  if (r === 'stopped') return 'stopped'
  return { ...out, note: notes.join('; ') || undefined }
}

/** Judges one replay's recording against the one criterion its finding breaks (or the user's rule): did the backend do it right this time? For findings
 *  code can't judge (findingrules.ts judgeInCode). */
export async function checkReplay(repo: Repo, o: { criterion: Named | null; what: string; expected: string; rec: Recorded; steps: ScenarioRun['steps'] }, signal: AbortSignal):
  Promise<{ result: 'fixed' | 'broken' | 'unknown'; why: string } | 'stopped'> {
  const s: ScenarioRun = { scenario: { id: 'replay', kind: 'retry', title: 'Replay of a finding',
    goal: `Before the fix: ${o.what}. Should be: ${o.expected}` }, steps: o.steps, findings: [], recording: o.rec.id, outcome: 'ok' }
  const c = await call({ signal, timeoutMs: TIMEOUT_MS, prompt: checkerPrompt({ criteria: o.criterion ? [o.criterion] : [{ name: 'RULE', text: o.expected }], decisions: [],
    endpoints: inputs().endpoints(repo.id),
    batch: [{ run: s, rec: o.rec }] }), args: ['--model', model(), '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--add-dir', o.rec.dir,
    ...PLAIN, '--json-schema', SCHEMA, '--system-prompt', CHECKER_SYSTEM] })
  if (c.kind === 'stopped') return 'stopped'
  if (c.kind === 'error') return { result: 'unknown', why: `the checker couldn't judge the replay (${c.why})` }
  const v = keepVerdicts(c.r.structured_output, [{ run: s, rec: o.rec }], o.criterion ? [o.criterion.name] : ['RULE'])[0]!
  return v.findings.length ? { result: 'broken', why: v.findings[0]!.what } : v.clean ? { result: 'fixed', why: v.line } : { result: 'unknown', why: v.line }
}

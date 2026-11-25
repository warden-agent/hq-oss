// SQLite (node:sqlite) wrapper with migrations. SQLite is authoritative for live state.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { PATHS } from './config.ts'

export type Row = Record<string, SQLInputValue | null>
export const db = new DatabaseSync(PATHS.db)
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')

const MIGRATIONS: string[] = [
`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, remote TEXT, default_branch TEXT NOT NULL DEFAULT 'main',
  context_doc_path TEXT, token_ref TEXT, network_allowlist TEXT NOT NULL DEFAULT '[]', ignore_patterns TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id), slug TEXT NOT NULL, title TEXT NOT NULL, request_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', tpm_agent_id TEXT, merge_order TEXT NOT NULL DEFAULT '[]', stacked_branches INTEGER NOT NULL DEFAULT 0,
  parent_feature_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, feature_id TEXT NOT NULL REFERENCES features(id), key TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
  size TEXT NOT NULL DEFAULT 'M', status TEXT NOT NULL DEFAULT 'queued', prior_status TEXT, assignee_agent_id TEXT,
  expected_files TEXT NOT NULL DEFAULT '[]', deps TEXT NOT NULL DEFAULT '[]', edit_overrides TEXT NOT NULL DEFAULT '[]',
  branch TEXT, worktree_path TEXT, pr_number INTEGER, pr_url TEXT, pr_state TEXT, plan_round INTEGER NOT NULL DEFAULT 0,
  handoff_updated_at INTEGER, last_handoff_hash TEXT, spec TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, feature_id TEXT, ticket_id TEXT, review_request_id TEXT,
  model_alias TEXT NOT NULL, model_live TEXT, claude_session_id TEXT, transcript_path TEXT, tmux_session TEXT, cwd TEXT,
  token_hash TEXT NOT NULL, token_revoked_at INTEGER, status TEXT NOT NULL DEFAULT 'launching', in_plan_mode INTEGER NOT NULL DEFAULT 0,
  last_event_at INTEGER, takeover_locked_until INTEGER, mod_seen_at INTEGER, last_gate_allow_at INTEGER, paused_reason TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER, launch_prompt TEXT, display_name TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), claude_session_id TEXT, transcript_path TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT, rotated_from TEXT);
CREATE TABLE IF NOT EXISTS review_requests (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, plan_revision_id TEXT NOT NULL, round INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  architect_agent_id TEXT, packet_path TEXT, opened_at INTEGER NOT NULL, answered_at INTEGER, closed_reason TEXT);
CREATE TABLE IF NOT EXISTS plan_revisions (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, agent_id TEXT NOT NULL, round INTEGER NOT NULL, plan_text TEXT NOT NULL, plan_hash TEXT NOT NULL,
  plan_file_path TEXT, submitted_at INTEGER NOT NULL, verdict TEXT, edited_plan_text TEXT, verdict_by TEXT, verdict_at INTEGER, verdict_message TEXT);
CREATE INDEX IF NOT EXISTS plan_revisions_hash ON plan_revisions(ticket_id, plan_hash);
CREATE TABLE IF NOT EXISTS review_issues (
  id TEXT PRIMARY KEY, plan_revision_id TEXT NOT NULL, raised_round INTEGER NOT NULL, severity TEXT NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', engineer_response TEXT, introduced_by_revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, plan_revision_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  user_decision TEXT, note TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER, standards_suggestion TEXT, suggestion_status TEXT);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, ticket_id TEXT, from_agent_id TEXT NOT NULL, to_target TEXT NOT NULL, message_id TEXT NOT NULL,
  asked_at INTEGER NOT NULL, answered_at INTEGER, answer_message_id TEXT);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, feature_id TEXT, channel TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT, reason TEXT NOT NULL,
  in_reply_to TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL, batch_id TEXT, delivered_at INTEGER, delivery_method TEXT, ack_at INTEGER);
CREATE INDEX IF NOT EXISTS messages_to ON messages(to_id, delivered_at);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, handed_at INTEGER, submitted_at INTEGER, acked_at INTEGER, method TEXT);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ticket_id TEXT, agent_id TEXT, status TEXT NOT NULL DEFAULT 'queued', log TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, session_id TEXT, source TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, created_at);
CREATE TABLE IF NOT EXISTS task_progress (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT NOT NULL, subject TEXT, status TEXT, position INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS model_switches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, from_model TEXT, to_model TEXT, source TEXT, requested_model TEXT, expected INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, at INTEGER NOT NULL, context_tokens INTEGER, context_pct REAL, five_hour_pct REAL, seven_day_pct REAL, cost_usd REAL);
CREATE TABLE IF NOT EXISTS file_overlap (
  id TEXT PRIMARY KEY, feature_id TEXT NOT NULL, ticket_a TEXT NOT NULL, ticket_b TEXT NOT NULL, predicted_files TEXT NOT NULL DEFAULT '[]', actual_files TEXT NOT NULL DEFAULT '[]', computed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS worker_slots (idx INTEGER PRIMARY KEY, agent_id TEXT, env TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS git_ops (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, op TEXT NOT NULL, status TEXT NOT NULL, log TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS needs_attention (
  id TEXT PRIMARY KEY, agent_id TEXT, ticket_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER);`,
`CREATE TABLE IF NOT EXISTS docs (scope TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(scope, key));`,
`ALTER TABLE repos ADD COLUMN kind TEXT; ALTER TABLE repos ADD COLUMN sync_ok INTEGER; ALTER TABLE repos ADD COLUMN sync_status TEXT;
ALTER TABLE repos ADD COLUMN sync_detail TEXT; ALTER TABLE repos ADD COLUMN synced_at INTEGER; ALTER TABLE repos ADD COLUMN head TEXT;`,
`ALTER TABLE repos ADD COLUMN can_push INTEGER; ALTER TABLE tickets ADD COLUMN go_ahead INTEGER NOT NULL DEFAULT 0;`,
`CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, command TEXT, status TEXT NOT NULL DEFAULT 'stopped', detail TEXT, port INTEGER, url TEXT,
  frameable INTEGER, branch TEXT, head TEXT, started_at INTEGER, updated_at INTEGER NOT NULL);`, // live preview, one per repo (id = repo id)
// Older open plan rounds (gate.ts used to leave them open when a newer plan arrived): closed as superseded, like gate.ts does now.
`UPDATE plan_revisions SET verdict = 'superseded', verdict_by = 'hq', verdict_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE verdict IS NULL AND id IN (SELECT r.plan_revision_id FROM review_requests r WHERE r.status = 'open'
    AND EXISTS (SELECT 1 FROM review_requests n WHERE n.ticket_id = r.ticket_id AND n.status = 'open' AND n.round > r.round));
UPDATE review_requests SET status = 'abandoned', closed_reason = 'superseded', answered_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE status = 'open' AND EXISTS (SELECT 1 FROM review_requests n WHERE n.ticket_id = review_requests.ticket_id AND n.status = 'open' AND n.round > review_requests.round);`,
// A batch the mod reported getting (received_at), or one HQ gave up on and put back in the queue (dropped_at).
`ALTER TABLE batches ADD COLUMN received_at INTEGER; ALTER TABLE batches ADD COLUMN dropped_at INTEGER;
UPDATE batches SET received_at = handed_at WHERE handed_at IS NOT NULL;`, // older batches: never handed out again
// A finished ticket that would conflict with main: the files (JSON list) and the tickets that merged first (JSON keys). NULL: clean.
`ALTER TABLE tickets ADD COLUMN conflict_files TEXT; ALTER TABLE tickets ADD COLUMN conflict_with TEXT;`,
// Fresh start: the agent asked to write its handoff note (when, then 'continue' | 'park', and the HQ message that asked), and a
// ticket or feature whose agent left a note and stopped, waiting for Resume.
`ALTER TABLE agents ADD COLUMN fresh_start_at INTEGER; ALTER TABLE agents ADD COLUMN fresh_start_then TEXT; ALTER TABLE agents ADD COLUMN fresh_start_msg TEXT;
ALTER TABLE tickets ADD COLUMN parked_at INTEGER; ALTER TABLE features ADD COLUMN tpm_parked_at INTEGER;`,
// Try it: the preview runs a finished ticket's worktree instead of main (NULL: main).
`ALTER TABLE previews ADD COLUMN ticket_id TEXT;`,
// Clear project: set while the repo's agents write their handoff notes, before its board is archived and deleted (NULL: not clearing).
`ALTER TABLE repos ADD COLUMN clearing_at INTEGER;`,
// New project: the default branch has no files yet (set by each sync; 1 + no features → the UI shows the first-request page).
`ALTER TABLE repos ADD COLUMN empty INTEGER;`,
// Launch helper (Bug 37): the recipe the user OK'd (JSON, apprun.ts Recipe), one waiting for their OK, and the helper working it
// out (its agent, where it is: working | needs_ok | trying | failed | cant_start | port_taken, a note for the user, saves so far,
// its throwaway worktree).
`ALTER TABLE previews ADD COLUMN recipe TEXT; ALTER TABLE previews ADD COLUMN draft_recipe TEXT; ALTER TABLE previews ADD COLUMN helper_agent_id TEXT;
ALTER TABLE previews ADD COLUMN helper_state TEXT; ALTER TABLE previews ADD COLUMN helper_note TEXT; ALTER TABLE previews ADD COLUMN helper_saves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE previews ADD COLUMN helper_worktree TEXT;`,
// Bug 42: who holds the recipe's fixed ports when a start was refused (JSON, preview.ts PortHolder[]), so the UI can name them
// and offer to stop them.
`ALTER TABLE previews ADD COLUMN port_holders TEXT;`,
// Bug 43: questions a TPM asks the user with ask_user (choices: JSON list of button answers); open until answered or cancelled.
`CREATE TABLE IF NOT EXISTS asks (id TEXT PRIMARY KEY, feature_id TEXT NOT NULL, agent_id TEXT NOT NULL, question TEXT NOT NULL, choices TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, answered_at INTEGER, answer TEXT);
CREATE INDEX IF NOT EXISTS asks_open ON asks(feature_id, answered_at);`,
// Bug 46: the ticket a Launch helper works out start steps for (Try it on a repo with no steps yet); its first run tries that ticket.
`ALTER TABLE previews ADD COLUMN helper_ticket_id TEXT;`,
// Bug 50: what HQ does itself once the user picks a choice (JSON, asks.ts AskAction), e.g. cancel_ticket's "Remove it".
`ALTER TABLE asks ADD COLUMN action TEXT;`,
// Bug 52: one TPM per project. The TPM belongs to the repo (its box is always on the board); features are the branches it makes,
// with a handle per project (F-1…), and ticket keys count up per project and never repeat (their worktree folder is the key).
// Agents, messages and asks carry the repo, so the project TPM (no feature) is found everywhere a feature's TPM was.
`ALTER TABLE repos ADD COLUMN tpm_agent_id TEXT; ALTER TABLE repos ADD COLUMN tpm_parked_at INTEGER;
ALTER TABLE repos ADD COLUMN next_ticket INTEGER NOT NULL DEFAULT 1; ALTER TABLE repos ADD COLUMN next_feature INTEGER NOT NULL DEFAULT 1;
ALTER TABLE features ADD COLUMN handle TEXT; ALTER TABLE agents ADD COLUMN repo_id TEXT; ALTER TABLE messages ADD COLUMN repo_id TEXT;
UPDATE agents SET repo_id = (SELECT repo_id FROM features WHERE features.id = agents.feature_id) WHERE feature_id IS NOT NULL;
UPDATE agents SET repo_id = (SELECT id FROM previews WHERE previews.helper_agent_id = agents.id) WHERE repo_id IS NULL AND role = 'launcher';
UPDATE messages SET repo_id = (SELECT repo_id FROM features WHERE features.id = messages.feature_id) WHERE feature_id IS NOT NULL;
UPDATE messages SET repo_id = (SELECT repo_id FROM agents WHERE agents.id = messages.from_id) WHERE repo_id IS NULL;
UPDATE messages SET repo_id = (SELECT repo_id FROM agents WHERE agents.id = messages.to_id) WHERE repo_id IS NULL;
UPDATE features SET handle = 'F-' || (SELECT COUNT(*) FROM features g WHERE g.repo_id = features.repo_id
  AND (g.created_at < features.created_at OR (g.created_at = features.created_at AND g.id <= features.id)));
UPDATE repos SET next_feature = 1 + (SELECT COUNT(*) FROM features WHERE features.repo_id = repos.id);
UPDATE repos SET next_ticket = 1 + COALESCE((SELECT MAX(CAST(substr(t.key, instr(t.key, '-') + 1) AS INTEGER)) FROM tickets t
  JOIN features f ON f.id = t.feature_id WHERE f.repo_id = repos.id), 0);
CREATE TABLE asks_new (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, feature_id TEXT, agent_id TEXT NOT NULL, question TEXT NOT NULL,
  choices TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, answered_at INTEGER, answer TEXT, action TEXT);
INSERT INTO asks_new SELECT a.id, COALESCE((SELECT repo_id FROM features f WHERE f.id = a.feature_id), ''), a.feature_id, a.agent_id, a.question,
  a.choices, a.created_at, a.answered_at, a.answer, a.action FROM asks a;
DROP TABLE asks; ALTER TABLE asks_new RENAME TO asks;
CREATE INDEX IF NOT EXISTS asks_open ON asks(repo_id, answered_at);`,
// Auto mode: per project, so not in settings. test_cmd is the user's own (empty: HQ works it out); auto_stopped_why stops new starts
// and merges until Resume; auto_waiting only says why nothing is moving (usage, no tests). A run is one stretch of auto work.
`ALTER TABLE repos ADD COLUMN auto_mode INTEGER NOT NULL DEFAULT 0; ALTER TABLE repos ADD COLUMN auto_stopped_why TEXT;
ALTER TABLE repos ADD COLUMN auto_waiting TEXT; ALTER TABLE repos ADD COLUMN test_cmd TEXT;
ALTER TABLE tickets ADD COLUMN auto_tries INTEGER NOT NULL DEFAULT 0; ALTER TABLE tickets ADD COLUMN auto_parked_why TEXT;
CREATE TABLE auto_runs (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', start_sha TEXT, end_sha TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, summary TEXT);
CREATE INDEX auto_runs_repo ON auto_runs(repo_id, started_at);`,
// Bug 53: migration 18 read the number after the first dash, so keys like T1 counted as 0 and the next ticket could reuse a number.
// Now the last run of digits in any key (T1, T-03, XY-12x), and it only ever raises the counter.
`UPDATE repos SET next_ticket = MAX(next_ticket, 1 + COALESCE((SELECT MAX(CAST(substr(k.s, length(rtrim(k.s, '0123456789')) + 1) AS INTEGER))
  FROM (SELECT rtrim(lower(t.key), 'abcdefghijklmnopqrstuvwxyz-_') AS s, f.repo_id AS repo FROM tickets t JOIN features f ON f.id = t.feature_id) k
  WHERE k.repo = repos.id), 0));`,
// Auto mode repairs a broken main itself: the main a repair ticket is fixing, the test command a run changed, and one waiting for the user's OK.
`ALTER TABLE tickets ADD COLUMN repairs_main TEXT; ALTER TABLE auto_runs ADD COLUMN test_change TEXT; ALTER TABLE repos ADD COLUMN test_cmd_proposed TEXT;`,
// Bug 70: the main a run tested when it started, so a restart doesn't test it again.
`ALTER TABLE auto_runs ADD COLUMN main_checked TEXT;`,
// Bug 84: what a ticket sent back to its engineer (`resolving`) is fixing. NULL: its conflicts with main; 'tests' or 'tests_hung': auto mode's test on main.
`ALTER TABLE tickets ADD COLUMN fixing TEXT;`,
// Bug 107: the saved test command Claude Code refused in an engineer's session (JSON: the command, Claude Code's words, whose engineer ran it, the
// repair ticket HQ opened for it), and on that repair ticket the command it is fixing. A repair of the command has repairs_main too: nothing merges until it's in.
`ALTER TABLE repos ADD COLUMN test_cmd_refused TEXT; ALTER TABLE tickets ADD COLUMN repairs_cmd TEXT;`,
// Bug 110: when the agent's own turn was last interrupted (Escape in its terminal) with no turn ended normally since. Until one does, Claude Code
// drops every prompt a mod submits, so HQ types the agent's messages into its terminal instead (delivery.ts).
`ALTER TABLE agents ADD COLUMN interrupted_at INTEGER;`,
// Bug 126: what HQ ran on a ticket before it merged and how it ended (JSON, records.ts MergeTest), so its box can say so. NULL: merged before HQ kept a record.
`ALTER TABLE tickets ADD COLUMN merge_test TEXT;`,
// Bug 122: why an agent ended, in HQ's words: the reason HQ stopped it (stopAgent's `reason`: 'fresh_start', 'finished', 'user', …), 'lost' when its process
// went without HQ stopping it, or 'session:<Claude Code's reason>' when its session ended by itself. The Agents menu says it beside the time it ended.
`ALTER TABLE agents ADD COLUMN ended_why TEXT;`,
// Acceptance criteria as a list HQ can check (JSON, criteria.ts Criterion[]; '[]' on tickets from before, and on HQ's own repairs), and a finished ticket's
// record: the test its open_pr named for each one, what git flagged, and how each named test did in HQ's own run (JSON, criteria.ts Proof).
`ALTER TABLE tickets ADD COLUMN criteria TEXT NOT NULL DEFAULT '[]'; ALTER TABLE tickets ADD COLUMN proof TEXT;`,
// Auto mode's two readers (checker.ts). How the check of a plan went, kept with the plan (JSON, plancheck.ts PlanCheck), and how the check of a finished
// ticket's changes went, kept with the ticket (JSON, diffcheck.ts DiffCheck). NULL: never checked.
`ALTER TABLE plan_revisions ADD COLUMN check_result TEXT; ALTER TABLE tickets ADD COLUMN diff_check TEXT;`,
// What the tester tried in a browser as an auto run ended, and what it found (JSON, testerrules.ts Tried[]). NULL: nothing was tried.
`ALTER TABLE auto_runs ADD COLUMN tried TEXT;`,
// The UI tester at the end of an auto run (uitester.ts): what it did and found (JSON, uitesterrules.ts UiTest; NULL: not yet), and a project's own switch
// for it ('off'; NULL follows HQ's setting).
`ALTER TABLE auto_runs ADD COLUMN ui_test TEXT; ALTER TABLE repos ADD COLUMN ui_test TEXT;`,
// Bug 72: why a `blocked` agent is blocked: 'dialog' (a dialog or menu waits in its terminal) or 'api_error' (its turn ended with an API error, and
// it sits at its prompt). Agents blocked before this: an open dialog notice wins (the safe reading: nothing is typed there), then an API error's.
`ALTER TABLE agents ADD COLUMN blocked_why TEXT;
UPDATE agents SET blocked_why = CASE WHEN NOT EXISTS (SELECT 1 FROM needs_attention n WHERE n.agent_id = agents.id AND n.resolved_at IS NULL AND n.kind = 'dialog')
  AND EXISTS (SELECT 1 FROM needs_attention n WHERE n.agent_id = agents.id AND n.resolved_at IS NULL AND n.kind = 'api_error') THEN 'api_error' ELSE 'dialog' END
  WHERE status = 'blocked';`,
// Bug 143: the commit a ticket's branch was on when its engineer called open_pr. Auto mode tests and merges that commit and nothing later: a branch that moved
// after it is unfinished again until open_pr names the new commit. NULL: finished before HQ kept it (HQ then tests the branch as it is).
`ALTER TABLE tickets ADD COLUMN finished_sha TEXT;`,
// Bug 145: agents' builds and full test runs that hold a turn (started_at set; until: when its command's own time limit has passed) or wait for one
// (started_at NULL), so a restarted backend still counts them and keeps the line's order (heavy.ts). Bug 312: HQ's own runs too, with agent_id '' (heavy.ts save).
`CREATE TABLE turns (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, who TEXT NOT NULL, what TEXT NOT NULL, lane TEXT NOT NULL,
  asked_at INTEGER NOT NULL, started_at INTEGER, until INTEGER);`,
// Bug 186: what the agent's box said the command was doing ("Running: npm test"), so a restarted backend shows it again. NULL: kept before this column.
`ALTER TABLE turns ADD COLUMN activity TEXT;`,
// Bug 187: why HQ dropped a message unread (delivery.ts dropMessage), so Messages can say so. Before this each reason was dropped for one cause
// only. And HQ's notes to an engineer went out with no feature, so Messages hid them with its box picked: they take the engineer's feature.
`ALTER TABLE messages ADD COLUMN dropped_why TEXT;
UPDATE messages SET dropped_why = CASE reason WHEN 'test_cmd' THEN 'finished' WHEN 'fresh_start' THEN 'fresh_start_over' END WHERE delivery_method = 'dropped';
UPDATE messages SET feature_id = (SELECT feature_id FROM agents WHERE agents.id = messages.to_id)
  WHERE feature_id IS NULL AND from_id = 'hq' AND to_id IN (SELECT id FROM agents WHERE role = 'engineer');`,
// Bug 215: HQ is ending the app's run ('stop': the user's Stop, Clear or Remove; 'restart': to start it again), kept before anything is signalled, so a
// backend restart in the middle finishes the job instead of reading the ended app as a crash. NULL: not ending it.
`ALTER TABLE previews ADD COLUMN stopping TEXT;`,
// Bug 219 (migration 38): a clear under way remembers whether the project's TPM was running when it started (1), so the TPM comes back after the clear even if the
// backend restarted in between. A clear already under way at this migration: its TPM was on if it still runs or stopped after the clear began.
`ALTER TABLE repos ADD COLUMN clear_tpm_was_on INTEGER;
UPDATE repos SET clear_tpm_was_on = 1 WHERE clearing_at IS NOT NULL AND EXISTS (SELECT 1 FROM agents a WHERE a.id = repos.tpm_agent_id
  AND (a.status != 'exited' OR a.ended_at >= repos.clearing_at));`,
// Bug 218 (migration 39 in fix round 3; 37 and 38 are Bugs 215, 219): an agent that left `blocked` kept why it was blocked (agents.ts update now
// clears it): rows from before lose that stale reason.
`UPDATE agents SET blocked_why = NULL WHERE status != 'blocked' AND blocked_why IS NOT NULL;`,
// Bug 226 (migration 40 in fix round 3; 37–39 are Bugs 215, 219, 218): the ports in HQ's preview range a Launch helper was given for its test runs (JSON
// list), so its test servers can't clash with another app on the machine and HQ's previews leave them alone. NULL: no helper, or one started before this.
`ALTER TABLE previews ADD COLUMN helper_ports TEXT;`,
// Bug 337: the line the agent's box shows ("Thinking", the tool it uses, "Waiting on: …"), kept as each patch says it (agents.ts keepLine), so a restarted
// backend shows it again instead of nothing until the agent's next hook. NULL: no line (and agents from before this).
`ALTER TABLE agents ADD COLUMN activity TEXT;`,
// Bug 351 (migration 42 in fix round 7; 41 is Bug 337): HQ's first run of the steps the user OK'd for a Launch helper, by the run's `started_at`, saved with the run
// itself, so a backend restart during that run can still tell the helper how it went. NULL: that run hasn't started yet (or no helper is trying one).
`ALTER TABLE previews ADD COLUMN helper_run INTEGER;`,
// Migration 43: "Have HQ test this" (hqcheck.ts): with auto mode off, the user's check of one finished ticket, kept with it (JSON, hqcheckrules.ts HqCheck) so the
// button and the results survive a backend restart. NULL: never tested this way.
`ALTER TABLE tickets ADD COLUMN hq_check TEXT;`,
// Migration 44 (Bug 373): the checks of a ticket from before its latest one (JSON list, hqcheckrules.ts pastWith), so Test again doesn't wipe the results the
// user sent to its engineer. Its own column: hq_check is saved and sent to every page at each step of a check under way. NULL: none before the latest.
`ALTER TABLE tickets ADD COLUMN hq_checks TEXT;`,
// Migration 45 (Bug 371): with auto mode off, the TPM changed a started ticket's spec or criteria after a plan was handed in: the ticket's plan_round then, so
// only a plan of a later round, approved, lets its engineer build on and finish (replan.ts). A counter, not a time. NULL: no new plan owed.
`ALTER TABLE tickets ADD COLUMN replan_after INTEGER;`,
// Migration 46 (Bug 369): when a switch away from the project began asking its agents for their notes, until all are
// asked (freshstart.ts parkNow), so a restart in the middle finishes the park (finishParks). NULL: no park under way.
`ALTER TABLE repos ADD COLUMN parking_at INTEGER;`,
// Migration 47 (Bug 389): when HQ began picking up the work of a project the user switched back to (freshstart.ts resumeNow), until every
// parked agent is asked, so a restart in the middle finishes the resume (finishResumes). NULL: no resume under way.
`ALTER TABLE repos ADD COLUMN resuming_at INTEGER;`,
]

/** Applies the migrations not applied yet, up to `until` (all of them by default; tests replay one on its own). */
export function migrate(until = MIGRATIONS.length): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: string } | undefined
  const v = row ? Number(row.value) : 0
  for (let i = v; i < until; i++) { db.exec(MIGRATIONS[i]!); db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('schema_version', String(i + 1)) }
}

export const now = (): number => Date.now()
export function q<T = Row>(sql: string, ...params: SQLInputValue[]): T[] { return db.prepare(sql).all(...params) as T[] }
export function one<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined { return db.prepare(sql).get(...params) as T | undefined }
export function run(sql: string, ...params: SQLInputValue[]): void { db.prepare(sql).run(...params) }
/** An INSERT: the new row's id. */
export function insert(sql: string, ...params: SQLInputValue[]): number { return Number(db.prepare(sql).run(...params).lastInsertRowid) }
let depth = 0
/** Runs `fn` as one transaction: all of its writes or none. Synchronous only (an await inside would let other requests'
 *  writes into it); a tx inside a tx joins the outer one. */
export function tx<T>(fn: () => T): T {
  if (fn.constructor.name === 'AsyncFunction') throw new Error('tx() takes a synchronous function')
  if (depth) return fn()
  db.exec('BEGIN IMMEDIATE'); depth++
  try { const r = fn(); if (r instanceof Promise) throw new Error('tx() takes a synchronous function'); db.exec('COMMIT'); return r }
  catch (e) { db.exec('ROLLBACK'); throw e }
  finally { depth-- }
}
export function getSetting<T>(key: string, fallback: T): T { const r = one<{ value: string }>('SELECT value FROM settings WHERE key = ?', key); return r ? (JSON.parse(r.value) as T) : fallback }
export function setSetting(key: string, value: unknown): void { run('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)', key, JSON.stringify(value)) }

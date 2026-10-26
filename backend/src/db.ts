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

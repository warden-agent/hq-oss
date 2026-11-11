// UI server: static frontend, REST API, WebSocket (patches, events, terminals). 127.0.0.1 only, token + Origin checked.
import { stopFrozen } from './bgruns.ts'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { BIND, PORTS, DEFAULTS, CHOICES, ENGINEER_LIMIT, NOTE_CAP, GITHUB_ACCOUNT, uiToken, validSetting } from './config.ts'
import { q, getSetting, setSetting, now, one } from './db.ts'
import { bus, emit, patch, type Patch, type HqEvent } from './events.ts'
import { allAgents, getAgent, pageAgent, stopAgent, update, type Agent } from './agents.ts'
import type { Term } from './terminal.ts'
import { termMessage } from './termws.ts'
import { createFeature, createTicket, launchEngineer, resumeEngineer, startReady, startReadyRepo, fillSlots, cancelTicket, cancelFeature, fixConflicts } from './tickets.ts'
import { messageTpm, restartTpm } from './tpm.ts'
import { freshStart, freshStartAll, parkRepo, resumeRepo } from './freshstart.ts'
import { clearRepo } from './clear.ts'
import { removeRepo } from './remove.ts'
import { repos, features, tickets, getTicket } from './records.ts'
import { pump } from './heavy.ts'
import { addRepo, defaultParent, pickParent, pickRepo, repoAroundProject, syncRepo } from './repos.ts'
import { createProject, githubReady, RepoHere } from './newproject.ts'
import { makePr, mergeTicket } from './mergewatch.ts'
import { answerReview, openReviews, pageReviews, getReview, getRevision, heldCount, isVerdict, VERDICTS } from './gate.ts'
import { interruptAndType, sendMessage, messagesForFeature } from './delivery.ts'
import { openAttention, resolveAttention } from './attention.ts'
import { resumeRole } from './modelguard.ts'
import * as tmux from './tmux.ts'
import { answerAsk, answerOpenAsks, openAsks } from './asks.ts'
import { freePort, NeedsSetup, previews, setPreviewCommand, startPreview, stopPreview } from './preview.ts'
import { approve, dismiss, launchWithoutRecipe, startHelper } from './launchhelper.ts'
import { readJson, asObject, TooLarge } from './util.ts'
import { answerTestCommand, autoCheck, autoResume, autoRetry, autoRuns, setAuto, setTestCmd, undoRun } from './auto.ts'
import { claudeInfo } from './claudecheck.ts'

const TOKEN = uiToken()
const extras = new Map<string, Record<string, unknown>>() // non-column agent fields from patches (activity, steps, context)
/** After a restart the context meters start from each running agent's last measurement, not blank until its next turn. */
function seedExtras(): void {
  for (const r of q<{ agent_id: string; context_tokens: number | null; five_hour_pct: number | null; seven_day_pct: number | null }>(`SELECT u.agent_id, u.context_tokens, u.five_hour_pct,
    u.seven_day_pct FROM usage_samples u JOIN agents a ON a.id = u.agent_id WHERE a.status != 'exited' AND u.id IN (SELECT MAX(id) FROM usage_samples GROUP BY agent_id)`)) {
    extras.set(r.agent_id, { ...(extras.get(r.agent_id) ?? {}), context_tokens: r.context_tokens, five_hour_pct: r.five_hour_pct, seven_day_pct: r.seven_day_pct })
  }
}
bus.on('patch', (p: Patch) => { if (p.entity === 'agent' && p.patch) { const cur = extras.get(p.id) ?? {}; for (const [k, v] of Object.entries(p.patch)) if (['activity', 'last_message', 'steps_done', 'steps_total', 'context_tokens', 'five_hour_pct', 'seven_day_pct'].includes(k)) cur[k] = v; extras.set(p.id, cur) } })
/** What follows a clicked Fresh start: the body's choice, else the user's setting ('wait' parks the work for Resume). */
const afterFresh = (v: unknown): 'continue' | 'park' => v === 'continue' || v === 'park' ? v : getSetting('after_fresh_start', DEFAULTS.after_fresh_start) === 'wait' ? 'park' : 'continue'
const agentView = (a: Agent) => ({ ...pageAgent(a), ...(extras.get(a.id) ?? {}) })

/** Bug 48: the frontend build HQ serves (its hashed script, e.g. index-pXb_ChmJ.js), or null when there's no build. A tab still
 *  running another build reloads itself (App.tsx). */
export function buildId(dist: string): string | null {
  try { return /\/assets\/(index-[\w-]+\.js)/.exec(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'))?.[1] ?? null } catch { return null }
}
let DIST = '', BUILD: string | null = null, builtAt = -1
/** Read again whenever index.html changes: a build while HQ runs serves the new page at once, and a tab that loaded it must not
 *  be told it's out of date (it would reload forever). */
function build(): string | null {
  const at = (() => { try { return fs.statSync(path.join(DIST, 'index.html')).mtimeMs } catch { return 0 } })()
  if (at !== builtAt) { builtAt = at; BUILD = buildId(DIST) }
  return BUILD
}

function snapshot() {
  const agents = allAgents(); for (const id of extras.keys()) if (!agents.some((a) => a.id === id)) extras.delete(id) // agents too old to show
  return { autoRuns: autoRuns(), repos: repos(), features: features(), tickets: tickets(), agents: agents.map(agentView), messages: messagesForFeature(null, 300), reviews: pageReviews(),
    attention: openAttention(), asks: openAsks(), settings: Object.fromEntries(q<{ key: string; value: string }>('SELECT key, value FROM settings').map((r) => [r.key,
      JSON.parse(r.value)])), defaults: { ...DEFAULTS, github_account: GITHUB_ACCOUNT, choices: CHOICES, engineer_limit: ENGINEER_LIMIT, note_cap: NOTE_CAP }, held: heldCount(),
        ports: PORTS, previews: previews(), build: build(), claude: claudeInfo() }
}
const json = (res: http.ServerResponse, code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const cookieToken = (req: http.IncomingMessage): string | null => { const m = /(?:^|;\s*)hq=([^;]+)/.exec(req.headers.cookie ?? ''); return m ? decodeURIComponent(m[1]!) : null }
/** Bearer or the cookie. The ?token= link only opens the page (which sets the cookie), so a token in a URL can't drive the API. */
const authed = (req: http.IncomingMessage): boolean => { const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''); return bearer === TOKEN || cookieToken(req) === TOKEN }
/** What a GET may do: read. Every change is a POST, so a page shown inside HQ (the live preview) can't make one with a link
 *  or an <img> (a cross-origin POST carries an Origin, which originOk refuses). */
const readRoute = ([r0, r1, r2, r3]: (string | undefined)[]): boolean => !r3 && ((['state', 'events', 'docs'].includes(r0 ?? '') && !r1)
  || (r0 === 'reviews' && !r2) || (r0 === 'ticket' && !!r1 && !r2) || (r0 === 'agents' && !!r1 && r2 === 'screen'))
const originOk = (req: http.IncomingMessage): boolean => { const o = req.headers.origin; if (!o) return true; return [`http://127.0.0.1:${PORTS.ui}`, `http://localhost:${PORTS.ui}`, `http://127.0.0.1:5173`, `http://localhost:5173`].includes(o) }

async function api(req: http.IncomingMessage, url: URL, res: http.ServerResponse): Promise<void> {
  const parts = url.pathname.split('/').filter(Boolean).slice(1) // after /api
  let body: Record<string, unknown> = {}
  if (req.method === 'POST') try { body = asObject(await readJson(req)) } catch (e) { return json(res, e instanceof TooLarge ? 413 : 400, { error: (e as Error).message }) }
  const [r0, r1, r2] = parts
  if (req.method !== 'POST' && !readRoute(parts)) return json(res, 405, { error: 'changes must be sent as POST' })
  try {
    if (r0 === 'state') return json(res, 200, snapshot())
    if (r0 === 'repos' && r1 && r2 === 'sync' && req.method === 'POST') return json(res, 200, await syncRepo(r1))
    if (r0 === 'repos' && r1 === 'pick' && req.method === 'POST') { try { return json(res, 200, await pickRepo()) } catch (e) { return json(res, 400, { error: (e as Error).message }) } }
    if (r0 === 'repos' && r1 === 'new-setup' && req.method === 'POST') return json(res, 200, { parent: await defaultParent(), account: GITHUB_ACCOUNT, githubReady: await githubReady() })
    if (r0 === 'repos' && r1 === 'pick-folder' && req.method === 'POST') {
      try { return json(res, 200, await pickParent(String(body.start ?? ''))) } catch (e) { return json(res, 400, { error: (e as Error).message }) }
    }
    if (r0 === 'repos' && r1 === 'new' && req.method === 'POST') {
      try { return json(res, 200, await createProject(String(body.name ?? ''), String(body.parent ?? ''), body.github === true, undefined, body.nested === true)) } catch (e) {
        return e instanceof RepoHere ? json(res, 409, { error: e.message, existing: e.existing }) : json(res, 400, { error: (e as Error).message })
      }
    }
    if (r0 === 'repos' && !r1 && req.method === 'POST') { try { return json(res, 200, await addRepo(String(body.path ?? ''), body.name ? String(body.name) : undefined)) } catch (e) { return json(res, 400, { error: (e as Error).message }) } }
    if (r0 === 'features' && r1 && r2 === 'start-ready' && req.method === 'POST') { try { return json(res, 200, await startReady(r1)) } catch (e) { return json(res, 400, { error: (e as Error).message }) } }
    // The project's TPM (Bug 52): the TPM box's message (it starts the TPM if needed), Start TPM again, and Start for every ready ticket
    if (r0 === 'repos' && r1 && r2 === 'message' && req.method === 'POST') {
      try { const r = await messageTpm(r1, String(body.body ?? '')); return json(res, 200, { agent: agentView(r.agent), message: r.message }) } catch (e) { return json(res, 409, { error: (e as Error).message }) }
    }
    if (r0 === 'repos' && r1 && r2 === 'restart-tpm' && req.method === 'POST') { try { return json(res, 200, agentView(await restartTpm(r1, { why: 'ui' }))) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'repos' && r1 && r2 === 'auto' && req.method === 'POST') { try { return json(res, 200, await setAuto(r1, !!body.on)) } catch (e) { return json(res, 409,
      { error: (e as Error).message }) } }
    if (r0 === 'repos' && r1 && r2 === 'around' && req.method === 'POST') { try { return json(res, 200, { around: await repoAroundProject(r1) }) }
      catch (e) { return json(res, 400, { error: (e as Error).message }) } }
    if (r0 === 'repos' && r1 && r2 === 'auto-check' && req.method === 'POST') { try { return json(res, 200, await autoCheck(r1)) }
      catch (e) { return json(res, 400, { error: (e as Error).message }) } }
    if (r0 === 'repos' && r1 && r2 === 'auto-resume' && req.method === 'POST') { try { return json(res, 200, await autoResume(r1)) }
      catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'repos' && r1 && r2 === 'test-cmd-answer' && req.method === 'POST') {
      try { return json(res, 200, await answerTestCommand(r1, !!body.use)) } catch (e) { return json(res, 409, { error: (e as Error).message }) }
    }
    if (r0 === 'repos' && r1 && r2 === 'test-cmd' && req.method === 'POST') { try { return json(res, 200, setTestCmd(r1, String(body.cmd ?? ''))) } catch (e) { return json(res,
      400, { error: (e as Error).message }) } }
    if (r0 === 'auto-runs' && r1 && r2 === 'undo' && req.method === 'POST') { try { return json(res, 200, await undoRun(r1)) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'tickets' && r1 && r2 === 'auto-retry' && req.method === 'POST') { try { return json(res, 200, autoRetry(r1)) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'repos' && r1 && r2 === 'start-ready' && req.method === 'POST') { try { return json(res, 200, await startReadyRepo(r1)) } catch (e) { return json(res, 400, { error: (e as Error).message }) } }
    if (r0 === 'features' && r1 && r2 === 'cancel' && req.method === 'POST') { try { return json(res, 200, await cancelFeature(r1)) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'features' && req.method === 'POST') return json(res, 200, await createFeature(String(body.repoId), String(body.title), String(body.request)))
    if (r0 === 'tickets' && !r1 && req.method === 'POST') return json(res, 200, createTicket(String(body.featureId), { title: String(body.title), size: String(body.size ?? 'M'), spec: String(body.spec ?? ''), expected_files: (body.expected_files as string[]) ?? [], depends_on: (body.depends_on as string[]) ?? [] }))
    if (r0 === 'tickets' && r1 && r2 === 'cancel') { try { return json(res, 200, await cancelTicket(r1)) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'tickets' && r1 && r2 === 'fix-conflicts') { try { return json(res, 200, await fixConflicts(r1)) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'tickets' && r1 && r2 === 'make-pr') { try { return json(res, 200, await makePr(r1)) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'tickets' && r1 && r2 === 'merge') { try { return json(res, 200, await mergeTicket(r1)) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'tickets' && r1 && r2 === 'launch') { try { return json(res, 200, agentView(await launchEngineer(r1))) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'agents' && r1 && r2 === 'message') {
      const a = getAgent(r1); if (!a) return json(res, 404, {})
      const m = sendMessage({ repoId: a.repo_id, featureId: a.feature_id, channel: 'dm', from: 'user', to: a.id, reason: body.urgent ? 'urgent' : String(body.reason ?? 'fyi'), body: String(body.body ?? '') })
      if (a.role === 'tpm' && a.repo_id) answerOpenAsks(a.repo_id, m.body) // what the user tells the TPM answers what it asked (Bug 43)
      // Typed after Escape (a mod prompt is dropped after an interrupt), but never into a dialog or menu, where Enter picks an option:
      // then the mod delivers it as usual, once the agent is free.
      const typeable = !['blocked', 'paused', 'plan_review', 'exited'].includes(a.status)
      if (body.urgent && typeable) { emit({ agentId: a.id, source: 'ui', kind: 'urgent.interrupt', payload: {} }); await interruptAndType(a, m) }
      return json(res, 200, m)
    }
    if (r0 === 'agents' && r1 && r2 === 'fresh-start') {
      try { await freshStart(r1, { how: 'now', then: afterFresh(body.then) }); return json(res, 200, { ok: true }) } catch (e) { return json(res, 409, { error: (e as Error).message }) }
    }
    if (r0 === 'repos' && r1 && r2 === 'fresh-start-all') return json(res, 200, await freshStartAll(r1, afterFresh(body.then)))
    if (r0 === 'repos' && r1 && r2 === 'park') return json(res, 200, await parkRepo(r1))
    if (r0 === 'repos' && r1 && r2 === 'resume') return json(res, 200, await resumeRepo(r1))
    if (r0 === 'repos' && r1 && r2 === 'clear') { try { return json(res, 200, await clearRepo(r1)) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'repos' && r1 && r2 === 'remove' && req.method === 'POST') { try { return json(res, 200, await removeRepo(r1, typeof body.landing === 'string' ? body.landing : null)) }
      catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'tickets' && r1 && r2 === 'resume') { try { return json(res, 200, agentView(await resumeEngineer(r1))) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'agents' && r1 && r2 === 'stop-frozen-runs' && req.method === 'POST') {
      try { return json(res, 200, await stopFrozen(r1, 'user')) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'agents' && r1 && r2 === 'stop') { await stopAgent(r1, 'user'); return json(res, 200, { ok: true }) }
    if (r0 === 'agents' && r1 && r2 === 'takeover') { update(r1, { takeover_locked_until: body.locked ? now() + 365 * 86_400_000 : 0 }); return json(res, 200, { ok: true }) }
    if (r0 === 'agents' && r1 && r2 === 'type') { const a = getAgent(r1); if (!a) return json(res, 404, {}); update(r1, { takeover_locked_until: now() + getSetting('takeover_lock_s', DEFAULTS.takeover_lock_s) * 1000 }); await tmux.sendKeys(a.tmux_session, String(body.text ?? ''), body.enter !== false); return json(res, 200, { ok: true }) }
    if (r0 === 'agents' && r1 && r2 === 'screen') { const a = getAgent(r1); if (!a) return json(res, 404, {}); return json(res, 200, { text: await tmux.capturePane(a.tmux_session, 200) }) }
    if (r0 === 'reviews' && r1 && !r2) { const rv = getReview(r1); if (!rv) return json(res, 404, {}); return json(res, 200, { ...rv, revision: getRevision(rv.plan_revision_id) }) }
    if (r0 === 'reviews' && r1 && r2 === 'answer') { const verdict = body.verdict; if (!isVerdict(verdict)) return json(res, 400, { error: `unknown verdict '${String(verdict)}' (one of ${VERDICTS.join(', ')})` }); return json(res, 200, answerReview(r1, verdict, { plan: body.plan ? String(body.plan) : undefined, message: body.message ? String(body.message) : undefined, note: typeof body.note === 'string' ? body.note : undefined, by: String(body.by ?? 'user') })) }
    if (r0 === 'reviews' && !r1) return json(res, 200, openReviews())
    if (r0 === 'asks' && r1 && r2 === 'answer') { try { return json(res, 200, await answerAsk(r1, String(body.answer ?? ''))) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'attention' && r1 && r2 === 'resolve') { resolveAttention(r1); return json(res, 200, { ok: true }) }
    if (r0 === 'previews' && r1 && ['start', 'stop', 'command', 'setup', 'approve', 'dismiss', 'free-port'].includes(r2 ?? '')) {
      // Launch with nothing to run yet (no OK'd recipe, no ⚙ command) asks Claude to work it out (Bug 37)
      const start = () => startPreview(r1, null, { ticket: typeof body.ticket === 'string' ? body.ticket : null })
        .catch((e) => { if (e instanceof NeedsSetup) return launchWithoutRecipe(r1, typeof body.ticket === 'string' ? body.ticket : null); throw e })
      const act = { start, stop: () => stopPreview(r1), command: () => setPreviewCommand(r1, typeof body.command === 'string' ? body.command : null),
        setup: () => startHelper(r1, body.why === 'fix' ? 'fix' : 'first'), approve: () => approve(r1), dismiss: () => dismiss(r1),
        'free-port': () => freePort(r1, Array.isArray(body.pids) ? body.pids.map(Number).filter((n: number) => Number.isInteger(n) && n > 1) : []) }[r2 as 'start']
      try { return json(res, 200, await act()) } catch (e) { return json(res, 409, { error: e instanceof Error ? e.message : String(e) }) }
    }
    if (r0 === 'settings' && req.method === 'POST') {
      const bad = validSetting(String(body.key), body.value); if (bad) return json(res, 400, { error: bad })
      setSetting(String(body.key), body.value); patch('setting', String(body.key), { value: body.value }); emit({ agentId: null, source: 'ui', kind: 'settings.changed', payload: { key: body.key } })
      if (body.key === 'concurrency_cap') void fillSlots().catch(() => {})
      if (body.key === 'heavy_at_once') pump() // raised: whoever waits for a turn may go
      return json(res, 200, { ok: true })
    }
    if (r0 === 'roles' && r1 && r2 === 'resume') { resumeRole(r1); return json(res, 200, { ok: true }) }
    if (r0 === 'events') { const agent = url.searchParams.get('agent'); const limit = Number(url.searchParams.get('limit') ?? 200); return json(res, 200, agent ? q('SELECT * FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?', agent, limit) : q('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit)) }
    if (r0 === 'docs') { const scope = url.searchParams.get('scope') ?? ''; return json(res, 200, q('SELECT * FROM docs WHERE scope = ?', scope)) }
    if (r0 === 'ticket' && r1) return json(res, 200, { ...getTicket(r1), handoff: one<{ text: string }>('SELECT text FROM docs WHERE scope = ? AND key = ?', `ticket:${r1}`, 'handoff')?.text ?? '' })
    json(res, 404, { error: 'not found' })
  } catch (e) { json(res, 500, { error: String(e) }) }
}

export function startUiServer(): http.Server {
  seedExtras()
  const dist = path.resolve(import.meta.dirname, '../../frontend/dist'); DIST = dist
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${BIND}:${PORTS.ui}`)
    if (!originOk(req)) { res.writeHead(403); res.end('bad origin'); return }
    if (url.pathname.startsWith('/api/')) { if (!authed(req)) return json(res, 401, { error: 'unauthorized' }); return api(req, url, res) }
    // static: on first visit with ?token=, set the cookie
    const headers: Record<string, string> = {}
    if (url.searchParams.get('token') === TOKEN) headers['set-cookie'] = `hq=${encodeURIComponent(TOKEN)}; Path=/; SameSite=Strict; HttpOnly`
    else if (!authed(req)) { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('HQ: open the URL printed by the backend (it carries the token).'); return }
    let file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname)
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html')
    if (!fs.existsSync(file)) { res.writeHead(200, { ...headers, 'content-type': 'text/html' }); res.end('<h1>HQ backend is running</h1><p>Frontend not built yet. API at /api/state.</p>'); return }
    const ext = path.extname(file); const types: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }
    // The page is checked every load; its scripts are named by their content, so a browser may keep them for good
    const cache = ext === '.html' ? 'no-cache' : url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    res.writeHead(200, { ...headers, 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': cache }); fs.createReadStream(file).pipe(res)
  })
  const wss = new WebSocketServer({ noServer: true })
  srv.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${BIND}:${PORTS.ui}`)
    if (url.pathname !== '/ws' || !originOk(req) || !authed(req)) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => onClient(ws))
  })
  srv.listen(PORTS.ui, BIND); return srv
}

function onClient(ws: WebSocket): void {
  const terms = new Map<string, Term>()
  const send = (obj: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)) }
  send({ type: 'snapshot', data: snapshot() })
  const onPatch = (p: Patch) => send({ type: 'patch', ...p })
  const onEvent = (e: HqEvent) => send({ type: 'event', event: { ...e, payload: e.payload } })
  const onSnapshot = () => send({ type: 'snapshot', data: snapshot() }) // after a clear: whole rows are gone
  bus.on('patch', onPatch); bus.on('event', onEvent); bus.on('resnapshot', onSnapshot)
  ws.on('message', (raw) => {
    let m: Record<string, unknown>; try { m = JSON.parse(String(raw)) } catch { return }
    if (m.type !== 'snapshot') return termMessage(m, terms, send)
    try { send({ type: 'snapshot', data: snapshot() }) } catch (e) { // a throw here would stall this socket (termws.ts)
      emit({ agentId: null, source: 'system', kind: 'backend.error', payload: { server: 'ws', message: 'snapshot', error: String(e) } })
    }
  })
  ws.on('close', () => { bus.off('patch', onPatch); bus.off('event', onEvent); bus.off('resnapshot', onSnapshot); for (const t of terms.values()) t.kill() })
}

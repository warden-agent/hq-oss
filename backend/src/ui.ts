// UI server: static frontend, REST API, WebSocket (patches, events, terminals). 127.0.0.1 only, token + Origin checked.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { BIND, PORTS, DEFAULTS, GITHUB_ACCOUNT, uiToken, validSetting } from './config.ts'
import { q, getSetting, setSetting, now, one } from './db.ts'
import { bus, emit, type Patch, type HqEvent } from './events.ts'
import { allAgents, getAgent, stopAgent, update, type Agent } from './agents.ts'
import { openTerminal, openPreviewTerminal, type Term } from './terminal.ts'
import { createFeature, createTicket, launchEngineer, restartTpm, startReady, fillSlots, cancelTicket, cancelFeature } from './tickets.ts'
import { repos, features, tickets, getTicket } from './records.ts'
import { addRepo, pickRepo, syncRepo } from './repos.ts'
import { mergeTicket } from './mergewatch.ts'
import { answerReview, openReviews, getReview, getRevision, heldCount, isVerdict, VERDICTS } from './gate.ts'
import { sendMessage, messagesForFeature } from './delivery.ts'
import { openAttention, resolveAttention } from './attention.ts'
import { resumeRole } from './modelguard.ts'
import * as tmux from './tmux.ts'
import { previews, previewSession, setPreviewCommand, startPreview, stopPreview } from './preview.ts'
import { readJson, asObject, TooLarge } from './util.ts'

const TOKEN = uiToken()
const extras = new Map<string, Record<string, unknown>>() // non-column agent fields from patches (activity, steps, context)
bus.on('patch', (p: Patch) => { if (p.entity === 'agent' && p.patch) { const cur = extras.get(p.id) ?? {}; for (const [k, v] of Object.entries(p.patch)) if (['activity', 'last_message', 'steps_done', 'steps_total', 'context_tokens', 'five_hour_pct', 'seven_day_pct'].includes(k)) cur[k] = v; extras.set(p.id, cur) } })
const agentView = (a: Agent) => ({ ...a, ...(extras.get(a.id) ?? {}), token_hash: undefined })

function snapshot() {
  const reviews = q(`SELECT r.*, p.plan_text, p.edited_plan_text, p.agent_id, p.verdict, p.verdict_message,
      (SELECT COUNT(*) FROM plan_revisions x WHERE x.ticket_id = r.ticket_id AND x.verdict IN ('revise', 'user_architect')) AS revises_used
    FROM review_requests r JOIN plan_revisions p ON p.id = r.plan_revision_id ORDER BY r.opened_at DESC LIMIT 50`)
  const agents = allAgents(); for (const id of extras.keys()) if (!agents.some((a) => a.id === id)) extras.delete(id) // agents too old to show
  return { repos: repos(), features: features(), tickets: tickets(), agents: agents.map(agentView), messages: messagesForFeature(null, 300), reviews, attention: openAttention(), settings: Object.fromEntries(q<{ key: string; value: string }>('SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)])), defaults: { ...DEFAULTS, github_account: GITHUB_ACCOUNT }, held: heldCount(), ports: PORTS, previews: previews() }
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
    if (r0 === 'repos' && !r1 && req.method === 'POST') { try { return json(res, 200, await addRepo(String(body.path ?? ''), body.name ? String(body.name) : undefined)) } catch (e) { return json(res, 400, { error: (e as Error).message }) } }
    if (r0 === 'features' && r1 && r2 === 'start-ready' && req.method === 'POST') { try { return json(res, 200, await startReady(r1)) } catch (e) { return json(res, 400, { error: (e as Error).message }) } }
    if (r0 === 'features' && r1 && r2 === 'restart-tpm' && req.method === 'POST') { try { return json(res, 200, agentView(await restartTpm(r1))) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'features' && r1 && r2 === 'cancel' && req.method === 'POST') { try { return json(res, 200, await cancelFeature(r1)) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'features' && req.method === 'POST') return json(res, 200, await createFeature(String(body.repoId), String(body.title), String(body.request)))
    if (r0 === 'tickets' && !r1 && req.method === 'POST') return json(res, 200, createTicket(String(body.featureId), { title: String(body.title), size: String(body.size ?? 'M'), spec: String(body.spec ?? ''), expected_files: (body.expected_files as string[]) ?? [], depends_on: (body.depends_on as string[]) ?? [] }))
    if (r0 === 'tickets' && r1 && r2 === 'cancel') { try { return json(res, 200, await cancelTicket(r1)) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'tickets' && r1 && r2 === 'merge') { try { return json(res, 200, await mergeTicket(r1)) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'tickets' && r1 && r2 === 'launch') { try { return json(res, 200, agentView(await launchEngineer(r1))) } catch (e) { return json(res, 409, { error: (e as Error).message }) } }
    if (r0 === 'agents' && r1 && r2 === 'message') { const a = getAgent(r1); if (!a) return json(res, 404, {}); if (body.urgent) { await tmux.sendEscape(a.tmux_session); emit({ agentId: a.id, source: 'ui', kind: 'urgent.interrupt', payload: {} }) } return json(res, 200, sendMessage({ featureId: a.feature_id, channel: 'dm', from: 'user', to: a.id, reason: body.urgent ? 'urgent' : String(body.reason ?? 'fyi'), body: String(body.body ?? '') })) }
    if (r0 === 'agents' && r1 && r2 === 'stop') { await stopAgent(r1, 'user'); return json(res, 200, { ok: true }) }
    if (r0 === 'agents' && r1 && r2 === 'takeover') { update(r1, { takeover_locked_until: body.locked ? now() + 365 * 86_400_000 : 0 }); return json(res, 200, { ok: true }) }
    if (r0 === 'agents' && r1 && r2 === 'type') { const a = getAgent(r1); if (!a) return json(res, 404, {}); update(r1, { takeover_locked_until: now() + getSetting('takeover_lock_s', DEFAULTS.takeover_lock_s) * 1000 }); await tmux.sendKeys(a.tmux_session, String(body.text ?? ''), body.enter !== false); return json(res, 200, { ok: true }) }
    if (r0 === 'agents' && r1 && r2 === 'screen') { const a = getAgent(r1); if (!a) return json(res, 404, {}); return json(res, 200, { text: await tmux.capturePane(a.tmux_session, 200) }) }
    if (r0 === 'reviews' && r1 && !r2) { const rv = getReview(r1); if (!rv) return json(res, 404, {}); return json(res, 200, { ...rv, revision: getRevision(rv.plan_revision_id) }) }
    if (r0 === 'reviews' && r1 && r2 === 'answer') { const verdict = body.verdict; if (!isVerdict(verdict)) return json(res, 400, { error: `unknown verdict '${String(verdict)}' (one of ${VERDICTS.join(', ')})` }); return json(res, 200, answerReview(r1, verdict, { plan: body.plan ? String(body.plan) : undefined, message: body.message ? String(body.message) : undefined, by: String(body.by ?? 'user') })) }
    if (r0 === 'reviews' && !r1) return json(res, 200, openReviews())
    if (r0 === 'attention' && r1 && r2 === 'resolve') { resolveAttention(r1); return json(res, 200, { ok: true }) }
    if (r0 === 'previews' && r1 && ['start', 'stop', 'command'].includes(r2 ?? '')) {
      try { return json(res, 200, r2 === 'start' ? await startPreview(r1) : r2 === 'stop' ? await stopPreview(r1) : await setPreviewCommand(r1, typeof body.command === 'string' ? body.command : null)) } catch (e) { return json(res, 409, { error: (e as Error).message }) }
    }
    if (r0 === 'settings' && req.method === 'POST') { const bad = validSetting(String(body.key), body.value); if (bad) return json(res, 400, { error: bad }); setSetting(String(body.key), body.value); emit({ agentId: null, source: 'ui', kind: 'settings.changed', payload: { key: body.key } }); if (body.key === 'concurrency_cap') void fillSlots().catch(() => {}); return json(res, 200, { ok: true }) }
    if (r0 === 'roles' && r1 && r2 === 'resume') { resumeRole(r1); return json(res, 200, { ok: true }) }
    if (r0 === 'events') { const agent = url.searchParams.get('agent'); const limit = Number(url.searchParams.get('limit') ?? 200); return json(res, 200, agent ? q('SELECT * FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?', agent, limit) : q('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit)) }
    if (r0 === 'docs') { const scope = url.searchParams.get('scope') ?? ''; return json(res, 200, q('SELECT * FROM docs WHERE scope = ?', scope)) }
    if (r0 === 'ticket' && r1) return json(res, 200, { ...getTicket(r1), handoff: one<{ text: string }>('SELECT text FROM docs WHERE scope = ? AND key = ?', `ticket:${r1}`, 'handoff')?.text ?? '' })
    json(res, 404, { error: 'not found' })
  } catch (e) { json(res, 500, { error: String(e) }) }
}

export function startUiServer(): http.Server {
  const dist = path.resolve(import.meta.dirname, '../../frontend/dist')
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
    res.writeHead(200, { ...headers, 'content-type': types[ext] ?? 'application/octet-stream' }); fs.createReadStream(file).pipe(res)
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
  bus.on('patch', onPatch); bus.on('event', onEvent)
  ws.on('message', (raw) => {
    let m: Record<string, unknown>; try { m = JSON.parse(String(raw)) } catch { return }
    const agentId = String(m.agentId ?? '')
    if (m.type === 'term.open') {
      terms.get(agentId)?.kill()
      const cols = Number(m.cols ?? 120), rows = Number(m.rows ?? 36), onData = (d: string) => send({ type: 'term', agentId, data: d })
      const onExit = () => { send({ type: 'term.exit', agentId }); if (terms.get(agentId) === t) terms.delete(agentId) } // a replaced view's late exit leaves its successor alone
      // `preview:<repoId>` is the live preview's server output; anything else is an agent id
      const t = agentId.startsWith('preview:') ? openPreviewTerminal(previewSession(agentId.slice('preview:'.length)), cols, rows, onData, onExit) : openTerminal(agentId, cols, rows, onData, onExit)
      if (t) terms.set(agentId, t)
    }
    else if (m.type === 'term.input') terms.get(agentId)?.write(String(m.data ?? ''), m.typed === true)
    else if (m.type === 'term.resize') terms.get(agentId)?.resize(Number(m.cols), Number(m.rows))
    else if (m.type === 'term.close') { terms.get(agentId)?.kill(); terms.delete(agentId) }
    else if (m.type === 'snapshot') send({ type: 'snapshot', data: snapshot() })
  })
  ws.on('close', () => { bus.off('patch', onPatch); bus.off('event', onEvent); for (const t of terms.values()) t.kill() })
}

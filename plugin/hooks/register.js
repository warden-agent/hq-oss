// HQ mod. Identity: HQ_AGENT_ID (non-secret, env) + its token file (HQ_TOKEN_FILE, else ~/.hq/agents/<id>/token) read in-process.
// Delivers queued message batches with $.prompt.submit (waits for idle), reports telemetry, guards the model.
let backend = ''
let agentId = ''
let token = ''
let pending = null
let polling = false

function post($, path, obj) {
  if (!backend || !token) return Promise.resolve(null)
  return $.http.fetch(backend + '/mod/' + token + '/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }).catch(() => null)
}

async function poll($) {
  if (polling || pending) return
  polling = true
  try {
    const r = await $.http.fetch(backend + '/mod/' + token + '/next?wait=15000', { method: 'GET' })
    if (r && r.ok && r.text) {
      const data = JSON.parse(r.text)
      if (data && data.batch) {
        pending = data.batch
        post($, 'event', { kind: 'batch_received', id: data.batch.id })
        $.ui.log('HQ: delivering ' + data.batch.id + ' (waits for idle)')
        $.prompt.submit({ text: data.batch.raw ? data.batch.text : 'HQ message batch ' + data.batch.id + ':\n' + data.batch.text, asUser: data.batch.asUser ? true : undefined })
          .then(() => { post($, 'event', { kind: 'batch_submitted', id: data.batch.id }); pending = null })
          .catch((err) => { post($, 'event', { kind: 'batch_submit_failed', id: data.batch.id, error: String(err) }); pending = null })
      }
    }
  } catch (err) {
    post($, 'event', { kind: 'poll_error', error: String(err) })
  } finally { polling = false }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    backend = (await $.env.get('HQ_BACKEND')) || ''
    agentId = (await $.env.get('HQ_AGENT_ID')) || ''
    const home = (await $.env.get('HOME')) || ''
    const tokenFile = (await $.env.get('HQ_TOKEN_FILE')) || home + '/.hq/agents/' + agentId + '/token' // HQ_HOME may not be ~/.hq
    try { token = (await $.fs.read(tokenFile)).trim() } catch (err) { token = '' }
    let usage = null
    try { usage = await $.session.usage() } catch (err) { usage = { error: String(err) } }
    await post($, 'event', { kind: 'session.start', sessionId: await $.session.id(), model: await $.session.model(), cwd: await $.session.cwd(), usage, hasToken: !!token })
    $.clock.every(1500, () => poll($))
    return next(e)
  })
  on('plugin.register', async ($, e, next) => {
    const name = e.plugin || e.name || null
    post($, 'event', { kind: 'plugin.register', name })
    if (name && name !== 'hq') return { refuse: 'HQ: only the hq mod may load in an HQ agent' }
    return next(e)
  })
  on('turn.start', async ($, e, next) => { post($, 'event', { kind: 'turn.start', turnId: e.turnId, agentId: e.agentId || null }); return next(e) })
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    post($, 'event', { kind: 'turn.step', model: e.model, agentId: e.agentId || null, usageModel: result && result.usage ? result.usage.model : null,
      usage: result && result.usage ? { input: result.usage.input_tokens, output: result.usage.output_tokens, cacheRead: result.usage.cache_read_input_tokens, cacheWrite: result.usage.cache_creation_input_tokens } : null })
    return result
  })
  on('turn.complete', async ($, e, next) => { post($, 'event', { kind: 'turn.complete', turnId: e.turnId, agentId: e.agentId || null, isAborted: !!e.isAborted, durationMs: e.durationMs, answer: String(e.answer || '').slice(0, 300) }); return next(e) })
  on('session.measure', async ($, e, next) => {
    let usage = null
    try { usage = await $.session.usage() } catch (err) { usage = { error: String(err) } }
    post($, 'event', { kind: 'session.measure', usage })
    return next(e)
  })
  on('session.compact', async ($, e, next) => {
    post($, 'event', { kind: 'session.compact', keys: Object.keys(e) })
    return next(e)
  })
}

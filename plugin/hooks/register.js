// HQ mod. Identity: HQ_AGENT_ID (non-secret, env) + its token file (HQ_TOKEN_FILE, else ~/.hq/agents/<id>/token) read in-process.
// Delivers queued message batches with $.prompt.submit (waits for idle), reports telemetry, guards the model.
let backend = ''
let agentId = ''
let token = ''
let pending = null
let polling = false
let followUp = false // Bug 135: an empty answer may be followed by one ask at once; each tick of the clock allows one more
let reports = [] // Bug 140: batch reports HQ hasn't answered yet: on their way, or `late` (HQ was away, most likely a restart)

function post($, path, obj) {
  if (!backend || !token) return Promise.resolve(null)
  return $.http.fetch(backend + '/mod/' + token + '/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }).catch(() => null)
}

// Bug 140: a report on a batch (got it, it's in, it failed). One that gets no answer is kept and sent again, in order, before the
// mod's next ask (sendLate), marked `late`. `handed` names the hand-out, so HQ can tell a resend that comes after the batch was handed
// out again. A batch that went in while HQ was away is acked by the resend (its prompt's UserPromptSubmit hook was lost as well).
function report($, obj) {
  reports.push(obj)
  return post($, 'event', obj).then((r) => { if (r) reports = reports.filter((x) => x !== obj); else obj.late = true })
}
async function sendLate($) {
  for (const obj of reports.filter((x) => x.late)) {
    if (!(await post($, 'event', obj))) return false
    reports = reports.filter((x) => x !== obj)
  }
  return true
}

// Asks HQ for the next batch. HQ holds the request open until it has one, 15 s at most. Bug 135: the mod asks again as soon as a
// request is dealt with (a wait that ended with nothing, a batch that has gone in), so one is open nearly all the time and a message
// never waits for the clock. The clock is the backstop for the rest: HQ away or refusing, a batch that could not be submitted.
// An empty answer is followed up once per tick only, so answers that come back at once can never turn into a loop.
async function poll($) {
  if (polling || pending) return
  polling = true
  let again = false
  try {
    if (!(await sendLate($))) return // HQ is still away: the next tick tries again
    const r = await $.http.fetch(backend + '/mod/' + token + '/next?wait=15000', { method: 'GET' })
    if (r && r.ok && r.text) {
      const data = JSON.parse(r.text)
      if (data && data.batch) {
        pending = data.batch
        const b = { id: data.batch.id, handed: data.batch.handed }
        report($, { kind: 'batch_received', ...b })
        $.ui.log('HQ: delivering ' + data.batch.id + ' (waits for idle)')
        $.prompt.submit({ text: data.batch.raw ? data.batch.text : 'HQ message batch ' + data.batch.id + ':\n' + data.batch.text, asUser: data.batch.asUser ? true : undefined })
          .then(() => { report($, { kind: 'batch_submitted', ...b }); pending = null; poll($) })
          .catch((err) => { report($, { kind: 'batch_submit_failed', ...b, error: String(err) }); pending = null })
      } else if (followUp) { followUp = false; again = true }
    }
  } catch (err) {
    post($, 'event', { kind: 'poll_error', error: String(err) })
  } finally { polling = false }
  if (again) poll($)
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
    $.clock.every(1500, () => { followUp = true; poll($) })
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
    // tools: what this request asked to run. HQ's model check needs it: the request that calls ExitPlanMode can be reported after the approval (Bug 105)
    post($, 'event', { kind: 'turn.step', model: e.model, agentId: e.agentId || null, usageModel: result && result.usage ? result.usage.model : null,
      tools: result && result.toolUses ? result.toolUses.map((u) => u.name) : [],
      usage: result && result.usage ? { input: result.usage.input_tokens, output: result.usage.output_tokens, cacheRead: result.usage.cache_read_input_tokens, cacheWrite: result.usage.cache_creation_input_tokens } : null })
    return result
  })
  on('turn.complete', async ($, e, next) => {
    // Bug 140: an interrupted turn drops a prompt submitted as it ended (Bug 110: the aborted turn.complete comes right after the
    // submit). HQ hears of neither while it is away, so a report still waiting for it says how the first turn to end after it ended.
    if (!e.agentId) for (const x of reports) if (x.kind === 'batch_submitted' && x.interrupted === undefined) x.interrupted = !!e.isAborted
    post($, 'event', { kind: 'turn.complete', turnId: e.turnId, agentId: e.agentId || null, isAborted: !!e.isAborted, durationMs: e.durationMs, answer: String(e.answer || '').slice(0, 300) })
    return next(e)
  })
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

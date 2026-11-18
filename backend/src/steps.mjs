// A scenario's steps on a Playwright page: what each one does and what it says in the timeline. Shared by HQ's scripted runner (scenariorun.mjs) and
// whatever else replays steps. Plain Node, no imports.
// A step: { action: 'navigate'|'click'|'fill'|'press'|'select'|'check'|'uncheck'|'hover'|'back', role?, name?, text?, value?, url?, label?, field?, css?, nth? }
// `field`: an input named by its label or its placeholder, for one with no role and name to go by. `css`: a Playwright selector, for an element with neither
// (Bug 173) or one inside another (Bug 198: then it is how the step finds it, and the role and name only what it is called). `nth`: which of its matches
// (0 the first, -1 the last; the first when not given).
/** What a step says in the timeline: its own label, else what it does in a few words. */
export function stepLabel(s) {
  if (s.label) return s.label
  const el = `${s.role || s.name ? `${s.role ?? ''}${s.name ? ` "${s.name}"` : ''}`.trim() : s.field ? `"${s.field}"` : s.css ? s.css : s.text ? `"${s.text}"` : ''}${
    s.nth ? ` (${s.nth < 0 ? 'the last' : `match ${s.nth + 1}`})` : ''}`
  if (s.action === 'navigate') return `open ${s.url ?? '/'}`
  if (s.action === 'fill') return `type "${s.text ?? s.value ?? ''}" into ${el || 'the field'}`
  if (s.action === 'press') return `press ${s.text ?? s.value ?? ''}${el ? ` in ${el}` : ''}`
  if (s.action === 'select') return `choose "${s.value ?? ''}" in ${el}`
  return `${s.action} ${el}`.trim()
}
/** The element a step is about: by its selector when it has one (Bug 198: a button inside a row is found inside that row), else by role and name, else an
 *  input by its label or placeholder, else by its text; the match it took (the first when not given). */
const find = (page, s) => (s.css ? page.locator(s.css) : s.role ? page.getByRole(s.role, s.name ? { name: s.name } : {})
  : s.field && !s.name ? page.getByLabel(s.field).or(page.getByPlaceholder(s.field)) : page.getByText(s.name ?? s.text, { exact: false })).nth(s.nth ?? 0)
/** Does one step on the page. Throws, in words a person reads, when it can't be done. */
export async function runStep(page, s, origin, ms) {
  const on = { timeout: ms }
  if (s.action === 'navigate') return void await page.goto(origin + (String(s.url ?? '/').startsWith('/') ? s.url ?? '/' : `/${s.url}`), { timeout: ms * 3 })
  if (s.action === 'back') return void await page.goBack({ timeout: ms * 3 })
  if (s.action === 'press' && !s.role && !s.name && !s.css) return void await page.keyboard.press(s.text ?? s.value)
  if (!s.role && !s.name && !s.text && !s.field && !s.css) throw new Error(`a ${s.action} step needs a role and name, a text, or a selector`)
  const el = find(page, s)
  if (s.action === 'click') return void await el.click(on)
  if (s.action === 'fill') return void await el.fill(s.text ?? s.value ?? '', on)
  if (s.action === 'press') return void await el.press(s.text ?? s.value, on)
  if (s.action === 'select') return void await el.selectOption(s.value ?? s.text, on)
  if (s.action === 'check') return void await el.check(on)
  if (s.action === 'uncheck') return void await el.uncheck(on)
  if (s.action === 'hover') return void await el.hover(on)
  throw new Error(`there is no step "${s.action}"`)
}
/** Is the page as `e` says once the steps are done: { role?, name?, text?, visible }. Waits up to `ms` for it to become so (a list may still be loading). */
export async function holds(page, e, ms) {
  if (!e.role && !e.name && !e.text) return { ok: false, why: 'it names nothing to look for' }
  const el = e.role ? page.getByRole(e.role, e.name ? { name: e.name } : {}).first() : page.getByText(e.text ?? e.name, { exact: false }).first()
  try { await el.waitFor({ state: e.visible ? 'visible' : 'hidden', timeout: ms }); return { ok: true } }
  catch { return { ok: false, why: e.visible ? 'it isn\'t on the page' : 'it is still on the page' } }
}


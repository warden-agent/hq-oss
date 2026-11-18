// A scenario's steps on a Playwright page: what each one does and what it says in the timeline. Shared by HQ's scripted runner (scenariorun.mjs) and
// whatever else replays steps. Plain Node, no imports.
// A step: { action: 'navigate'|'click'|'fill'|'press'|'select'|'check'|'back', role?, name?, text?, value?, url?, label? }
/** What a step says in the timeline: its own label, else what it does in a few words. */
export function stepLabel(s) {
  if (s.label) return s.label
  const el = s.role || s.name ? `${s.role ?? ''}${s.name ? ` "${s.name}"` : ''}`.trim() : s.text ? `"${s.text}"` : ''
  if (s.action === 'navigate') return `open ${s.url ?? '/'}`
  if (s.action === 'fill') return `type "${s.text ?? s.value ?? ''}" into ${el || 'the field'}`
  if (s.action === 'press') return `press ${s.text ?? s.value ?? ''}${el ? ` in ${el}` : ''}`
  if (s.action === 'select') return `choose "${s.value ?? ''}" in ${el}`
  return `${s.action} ${el}`.trim()
}
/** The element a step is about: by role and name, else by its text. */
const find = (page, s) => s.role ? page.getByRole(s.role, s.name ? { name: s.name } : {}).first() : page.getByText(s.name ?? s.text, { exact: false }).first()
/** Does one step on the page. Throws, in words a person reads, when it can't be done. */
export async function runStep(page, s, origin, ms) {
  const on = { timeout: ms }
  if (s.action === 'navigate') return void await page.goto(origin + (String(s.url ?? '/').startsWith('/') ? s.url ?? '/' : `/${s.url}`), { timeout: ms * 3 })
  if (s.action === 'back') return void await page.goBack({ timeout: ms * 3 })
  if (s.action === 'press' && !s.role && !s.name) return void await page.keyboard.press(s.text ?? s.value)
  if (!s.role && !s.name && !s.text) throw new Error(`a ${s.action} step needs a role and name, or a text`)
  const el = find(page, s)
  if (s.action === 'click') return void await el.click(on)
  if (s.action === 'fill') return void await el.fill(s.text ?? s.value ?? '', on)
  if (s.action === 'press') return void await el.press(s.text ?? s.value, on)
  if (s.action === 'select') return void await el.selectOption(s.value ?? s.text, on)
  if (s.action === 'check') return void await el.check(on)
  throw new Error(`there is no step "${s.action}"`)
}


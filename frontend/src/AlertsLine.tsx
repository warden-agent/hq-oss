// "Turn on alerts" (Bug 24; the alerts themselves are in alerts.ts): a line at the top of the ⚠ menu, which is where the user looks
// when its count turns red. The top bar has no room left at 1440 px with a long repo name, not even for a 🔔. Browsers only ask
// for permission after a click.
import { useEffect, useState } from 'react'

const PERM_EVENT = 'hq-alerts-permission'
const current = (): string => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
const ask = () => { Notification.requestPermission().then(() => window.dispatchEvent(new Event(PERM_EVENT)), () => {}) }
/** The browser's answer so far (the event keeps an open menu in step after the user answers). */
function usePermission(): string {
  const [perm, setPerm] = useState(current)
  useEffect(() => { const on = () => setPerm(current()); window.addEventListener(PERM_EVENT, on); return () => window.removeEventListener(PERM_EVENT, on) }, [])
  return perm
}
const BLOCKED = "Your browser is blocking HQ's pop-ups. To get them, allow notifications for this page in the browser's site settings, then reload."

/** The ⚠ menu's first line while alerts are off. */
export function AlertsLine() {
  const perm = usePermission()
  if (perm === 'default') return <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-700/50 p-2 text-amber-200">
    <span className="min-w-0 grow">Get a pop-up when something needs you, even with this tab in the background.</span>
    <button className="btn-sm btn-primary" title="Pops up a notice when a plan is waiting, a ticket is ready to merge or an agent is stuck" onClick={ask}>🔔 Turn on alerts</button></div>
  if (perm === 'denied') return <div className="rounded-md border border-zinc-800 p-2 text-zinc-500">🔕 {BLOCKED}</div>
  return null
}

// Bug 121: the Events tab is what the clicked box's agent did (its prompts, tool calls, turns, tickets) and what HQ did for it,
// newest first. Its history comes from HQ when the tab opens; new lines come over the socket. The backend words every line (eventtext.ts).
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, errText, type Agent } from './api'
import { KEEP, type EventLine, type EventLog } from './eventlog.ts'

const when = (t: number): string => {
  const d = new Date(t), time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

/** `ws` is the socket: a new one (HQ restarted, or came back) reads the history again, so lines from while it was away show up. */
export function Events({ log, agent, ticketKey, ws }: { log: EventLog; agent: Agent | null; ticketKey: string | null; ws: WebSocket | null }) {
  useSyncExternalStore(log.subscribe, log.get)
  const [hist, setHist] = useState<{ agentId: string; lines?: EventLine[]; error?: string } | null>(null)
  const id = agent?.id ?? null
  useEffect(() => {
    if (!id) return
    let gone = false
    api<{ events: EventLine[] }>(`agents/${encodeURIComponent(id)}/events`).then((r) => { if (!gone) setHist({ agentId: id, lines: r.events }) },
      (e: Error) => { if (!gone) setHist({ agentId: id, error: e instanceof TypeError ? 'HQ is out of reach; its history shows once HQ is back.' : errText(e) }) })
    return () => { gone = true }
  }, [id, ws])
  if (!agent) return <div className="p-4 text-sm text-zinc-500">{ticketKey ? `No engineer has worked on ${ticketKey} yet. Its events show here once one starts.`
    : "Click the TPM's box or a ticket's box on the graph to see what its agent did here. Agents with no box (Launch and test setup helpers too) are in the Agents menu."}</div>
  const mine = hist?.agentId === agent.id ? hist : null, seen = new Set<number>()
  const lines = [...log.lines(agent.id), ...(mine?.lines ?? [])].sort((a, b) => b.id - a.id).filter((e) => !seen.has(e.id) && !!seen.add(e.id)).slice(0, KEEP)
  const note = !mine ? 'Loading its history…' : mine.error ? `Couldn't load its history: ${mine.error}` : !lines.length ? 'Nothing recorded for it yet.' : null
  return <div className="flex h-full min-h-0 flex-col gap-2 text-[11px]">
    <p className="text-xs text-zinc-500">What <span className="text-zinc-300">{agent.display_name ?? agent.id}</span> did, newest first: prompts, tool calls,
      turns and tickets. Its screen is in the Agent tab.</p>
    {note && <p className="text-zinc-500">{note}</p>}
    <div className="min-h-0 grow overflow-y-auto" data-testid="events-list">{lines.map((e) => <div key={e.id} className="break-words py-px text-zinc-400">
      <span className="text-zinc-600">{when(e.at)}</span> {e.text}</div>)}</div>
  </div>
}

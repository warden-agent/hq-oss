// What HQ does when something happens elsewhere. Registered once by index.ts at startup, never as a side effect of an import.
import { bus, type HqEvent } from './events.ts'
import { getTicket, setTicket } from './records.ts'
import { releaseFor, releaseSlot } from './slots.ts'
import { checkMerges } from './mergewatch.ts'
import { fillSlots } from './tickets.ts'
import { onTicketMerged } from './preview.ts'

let started = false
export function startListeners(): void {
  if (started) return
  started = true
  const freed = (agentId: string | null) => { if (agentId) releaseSlot(agentId); void fillSlots().catch(() => {}) }
  bus.on('event:agent.stopped', (e: HqEvent) => { freed(e.agentId); releaseFor(e.agentId) })
  bus.on('event:agent.lost', (e: HqEvent) => { freed(e.agentId); releaseFor(e.agentId) })
  bus.on('event:hook.SessionEnd', (e: HqEvent) => {
    if (e.payload.reason === 'clear') return
    freed(e.agentId); setTimeout(() => releaseFor(e.agentId), 5000) // Claude Code may still be exiting
  })
  /** An engineer's question was answered: its ticket goes back to what it was doing. */
  bus.on('event:question.answered', (e: HqEvent) => {
    const t = typeof e.payload.ticket === 'string' ? getTicket(e.payload.ticket) : undefined
    if (t?.status === 'awaiting_answer') setTicket(t.id, { status: t.prior_status ?? 'implementing', prior_status: null })
  })
  bus.on('event:ticket.merged', onTicketMerged)
  bus.on('slot.freed', () => { void fillSlots().catch(() => {}) }) // a finished engineer no longer counts against the limit
  bus.on('repo.synced', () => { void checkMerges().catch(() => {}) }) // a fresh fetch may show a merge
}

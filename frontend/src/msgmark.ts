// The mark after each message in Messages (App.tsx) and what it means on hover. Bug 187: a message HQ dropped unread, or gave up
// delivering, kept its delivered_at (that takes it out of the queue), so it showed "·" like one handed to its agent.

export type MarkKind = 'read' | 'delivered' | 'waiting' | 'dropped' | 'failed'
export type Mark = { kind: MarkKind; text: string; title: string }
type Msg = { to_id: string | null; delivered_at: number | null; delivery_method: string | null; ack_at: number | null; dropped_why?: string | null }

/** Why HQ dropped a message (backend delivery.ts dropMessage). One it can't name (none recorded) is still shown as dropped. */
const WHY: Record<string, string> = {
  finished: 'its engineer finished the ticket (open_pr) before reading it, so the note came too late to act on. HQ tests the ticket with the new command anyway',
  fresh_start_over: 'the fresh start it asked for was already over when it came up',
  replaced: 'HQ asked for the note again in other words before this came up (the reason changed, say a Clear), and sent that request instead', // Bug 338
}
export function deliveryMark(m: Msg): Mark {
  if (m.delivery_method === 'dropped') {
    const why = m.dropped_why ? WHY[m.dropped_why] : undefined
    return { kind: 'dropped', text: '⊘ dropped', title: `Dropped: HQ never gave this to its agent${why ? `. Why: ${why}.` : '.'}` }
  }
  if (m.delivery_method === 'failed') return { kind: 'failed', text: '✕ not delivered', title: "Not delivered: HQ tried three times, then stopped trying. Its ⚠ notice says why." }
  if (m.ack_at) return { kind: 'read', text: '✓', title: 'Delivered: the agent has it' }
  if (m.delivered_at) return { kind: 'delivered', text: '·', title: m.to_id === 'user' ? 'Shown to you here' : 'Handed to the agent; it has not started on it yet' }
  return { kind: 'waiting', text: '⏳', title: 'Waiting: not given to the agent yet' }
}

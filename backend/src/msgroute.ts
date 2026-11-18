// Bug 174: where a message the user writes in an agent's tab goes once that agent has stopped (pure: the UI and the API share it).
// Nothing reads a stopped agent's messages. tpm.ts handOver moves what still waits for it to the session that takes its place,
// and only two kinds of session do: the next engineer on its ticket (tickets.ts startEngineer) and its project's next TPM (tpm.ts launch).
// With neither to come, a message would wait for ever, so there is nowhere to send it.
type AgentLike = { id: string; role: string; status: string; ticket_id?: string | null; repo_id?: string | null }
type TicketLike = { id: string; key: string; status: string; assignee_agent_id: string | null }
type RepoLike = { id: string; name: string; tpm_agent_id: string | null }

/** `live`: the agent itself gets it. `next`: who gets it, in words (the agent has stopped). `none`: why it can't go anywhere. */
export type MessageRoute = { live: true } | { next: string } | { none: string }

/** Tickets that never get another engineer. */
const DONE = ['merged', 'cancelled']

export function messageRoute(a: AgentLike, t: TicketLike | undefined, r: RepoLike | undefined): MessageRoute {
  if (a.status !== 'exited') return { live: true }
  if (a.role === 'engineer' && t && t.id === a.ticket_id) {
    if (t.assignee_agent_id !== a.id) return { none: `A newer engineer has taken over ${t.key}: message it from its own box.` }
    if (!DONE.includes(t.status)) return { next: `the next engineer on ${t.key}` }
    return { none: `${t.key} is ${t.status}, so no engineer will pick a message up.` }
  }
  if (a.role === 'tpm' && r && r.id === a.repo_id) {
    if (r.tpm_agent_id === a.id) return { next: `the next TPM of ${r.name}` }
    return { none: `A newer TPM has taken over ${r.name}: message it from its own box.` }
  }
  return { none: 'Nothing takes its place, so no one would read a message.' }
}

// Auto mode on screen: the switch in the top bar, the dialog that says what happens the moment it goes on, the banner when it stops,
// waits or finishes, and "Do the rest automatically" at every stop (it opens the same dialog). HQ does the work (backend auto.ts).
import { useEffect, useState } from 'react'
import { api, askUntilAnswered, errText, type State } from './api'
import { DO_REST, OPEN_AUTO, OPEN_SUMMARY, openAuto, openSummary, undoConfirm, useBusy } from './board'
import { Backdrop, Md } from './ui'
import { yourTurn } from './needs.ts'
import { Findings } from './Findings'

/** Bug 107: the saved test command Claude Code refused in an engineer's session, if HQ has seen that, and the ticket HQ opened to fix it. */
const refusedCmd = (repo: any): { cmd: string; ticket?: string } | null => { try { return repo.test_cmd_refused ? JSON.parse(repo.test_cmd_refused) : null } catch { return null } }
const runsOf = (all: State, repoId: string): any[] => (all.autoRuns ?? []).filter((r) => r.repo_id === repoId)
const latestRun = (all: State, repoId: string): any => runsOf(all, repoId).filter((r) => r.summary).sort((a, b) => b.started_at - a.started_at)[0]
const finishedNotice = (all: State, repoId: string): any => all.attention.find((a) => a.kind === `auto_finished:${repoId}`)
const switchTip = (base: string): string => `Auto mode: HQ starts tickets, approves plans, tests finished tickets on ${base} and merges them, with nobody pressing`
  + ' anything. The computer stays awake during a run, but closing a laptop\'s lid still sleeps it.' // Bug 210: the project's default branch

/** The top-bar switch. Off is instant: engineers finish their ticket and nothing new starts or merges. */
export function AutoSwitch({ repo }: { all: State; repo: any }) {
  const [busy, run] = useBusy()
  const on = !!repo.auto_mode, stopped = !!repo.auto_stopped_why
  const tone = stopped ? 'border-rose-500/60! text-rose-300!' : repo.auto_waiting ? 'border-amber-500/60! text-amber-300!' : on ? 'border-emerald-500/60! text-emerald-300!' : ''
  const label = stopped ? 'Auto stopped' : repo.auto_waiting ? 'Auto waiting' : on ? 'Auto on' : 'Auto off'
  return <button className={`btn whitespace-nowrap ${tone}`} role="switch" aria-checked={on} disabled={busy} title={`${switchTip(repo.default_branch ?? 'main')}${on ? ' Click to turn it off.' : ''}`}
    onClick={() => on ? run(() => api(`repos/${repo.id}/auto`, { on: false })) : openAuto(repo.id)}>{label}</button>
}
/** The summary and Undo once the banner has gone. Not while a run goes: undoing would pull main out from under it. */
export function LastRunBtn({ all, repo }: { all: State; repo: any }) {
  const last = latestRun(all, repo.id)
  if (!last || last.status === 'undone' || finishedNotice(all, repo.id) || runsOf(all, repo.id).some((r) => r.status === 'running')) return null
  return <button className="btn whitespace-nowrap" title="What auto mode did in its last run. You can undo it from there." onClick={() => openSummary(repo.id)}>Last run</button>
}
export function DoRestBtn({ repoId }: { repoId?: string }) {
  if (!repoId) return null
  return <button className="btn-sm nopan" title="Turn on auto mode: HQ carries on from here by itself" onClick={() => openAuto(repoId)}>{DO_REST}</button>
}

/** What goes on the moment auto mode does: the user sees it before it happens, because finished tickets merge. */
function autoPreview(all: State, repoId: string): string[] {
  const features = all.features.filter((f) => f.repo_id === repoId && f.status !== 'cancelled').map((f) => f.id)
  const tickets = all.tickets.filter((t) => features.includes(t.feature_id)), ids = tickets.map((t) => t.id)
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const plans = all.reviews.filter((r) => r.status === 'open' && ids.includes(r.ticket_id)).length
  const ready = yourTurn(all, repoId).start.length, done = tickets.filter((t) => t.status === 'pr_ready' || t.status === 'pr_open').length
  const base = all.repos.find((r) => r.id === repoId)?.default_branch ?? 'main'
  return [plans ? `${count(plans, 'plan')} approved` : '', ready ? `${count(ready, 'ticket')} started` : '',
    done ? `${count(done, 'finished ticket')} tested on ${base} and merged` : ''].filter(Boolean)
}
/** Turning auto mode on: what happens right now, and how HQ will test. */
export function AutoDialog({ all }: { all: State }) {
  const [repoId, setRepoId] = useState<string | null>(null), [check, setCheck] = useState<{ custom: string | null; found: string | null; sandbox: string | null } | null>(null)
  const [cmd, setCmd] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState(''), [away, setAway] = useState(false)
  const repo = all.repos.find((r) => r.id === repoId), [uiTest, setUiTest] = useState<boolean | null>(null) // null: as the project has it
  const testing = uiTest ?? repo?.ui_test !== 'off'
  const close = () => { setRepoId(null); setCheck(null); setErr(''); setAway(false) }
  useEffect(() => {
    const open = (e: Event) => { setRepoId((e as CustomEvent<string>).detail); setCmd(''); setCheck(null); setErr(''); setAway(false); setUiTest(null) }
    window.addEventListener(OPEN_AUTO, open); return () => window.removeEventListener(OPEN_AUTO, open)
  }, [])
  // Bug 64: HQ may be restarting as the box opens. Closing the box stops the asking, so a late answer can't land on the next open. What was typed meanwhile stays.
  useEffect(() => repoId ? askUntilAnswered(`repos/${repoId}/auto-check`, { away: setAway, answer: (c) => { setCheck(c); setCmd((t) => t || (c.custom ?? '')) },
    refused: (e) => setErr(errText(e)) }) : undefined, [repoId])
  useEffect(() => {
    if (!repoId) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) close() }
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k)
  })
  if (!repo) return null
  const now = autoPreview(all, repo.id), noTests = !!check && !check.found && !cmd.trim(), refused = !repo.auto_mode ? check?.sandbox : null
  const bad = refusedCmd(repo), cantRun = !!cmd.trim() && bad?.cmd === cmd.trim() // while the box holds that command: typing another one takes the line away
  const go = async () => {
    setBusy(true); setErr('')
    try {
      if (check && cmd.trim() !== (check.custom ?? '')) await api(`repos/${repo.id}/test-cmd`, { cmd })
      if (testing !== (repo.ui_test !== 'off')) await api(`repos/${repo.id}/ui-test`, { on: testing })
      await api(`repos/${repo.id}/auto`, { on: true }); close()
    } catch (e) { setErr(errText(e as Error)) } finally { setBusy(false) }
  }
  return <Backdrop onClose={close} canClose={!busy}>
    <form role="dialog" aria-modal="true" aria-label="Turn on auto mode" onSubmit={(e) => { e.preventDefault(); void go() }}
      className="flex max-h-[90vh] w-[480px] max-w-full flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-xs text-zinc-400 shadow-xl">
      <div className="break-words text-sm font-medium text-zinc-100">{repo.auto_mode ? `How HQ tests ${repo.name}` : `Turn on auto mode for ${repo.name}?`}</div>
      {!repo.auto_mode && <div className="text-zinc-300">HQ carries on by itself: it starts tickets, approves plans,
        tests each finished ticket on {repo.default_branch} and merges it. The TPM makes product choices for you and lists them at the end. It only asks about things that are hard to undo.</div>}
      {refused && <div role="alert" className="break-words rounded-md border border-amber-500/40 bg-amber-950/30 p-2 text-amber-200">{refused}</div>}
      {now.length > 0 && !refused && <div className="flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-950/30 p-2"><div className="text-amber-200">Right away:</div>
        <ul className="ml-4 list-disc break-words text-zinc-300">{now.map((x) => <li key={x}>{x}</li>)}</ul></div>}
      <label className="flex flex-col gap-1">Test command
        <input className="input" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder={check ? check.found ?? 'No tests found' : 'Looking…'} aria-label="Test command" /></label>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={testing} onChange={(e) => setUiTest(e.target.checked)}
        aria-label="Test the app in a browser at the end of each run" />
        <span><span className="text-zinc-300">Test the app in a browser at the end of each run.</span> A tester that never sees the code tries about 30 everyday and odd
          things, and the run's summary lists where a person would get stuck. Nothing is changed for you. About $1–2 a run.</span></label>
      {noTests && <div className="text-amber-300/80">HQ found no tests here, so it will build but not merge. The TPM can add tests, or write a command above.</div>}
      {cantRun && <div role="note" className="break-words text-amber-300/80">Claude Code refuses this command in an engineer's session, so engineers can't run the full tests.
        {bad?.ticket ? ` HQ opened ${bad.ticket} to fix it.` : ' With auto mode on, HQ opens a ticket that fixes it.'} Or write
        one that works above: the same line inside a script in the repo (an npm script, for one) does.</div>}
      {repo.kind === 'github' && repo.can_push !== 0 && <div>Merges go to {repo.default_branch} on GitHub as {all.defaults?.github_account ?? 'the HQ account'}.</div>}
      {!refused && <div>Your computer stays awake during a run, but closing a laptop's lid still sleeps it.</div>}
      {away && <div role="status" className="text-amber-300/80">Can't reach HQ. It may be restarting. Trying again…</div>}
      {err && <div role="alert" className="break-words rounded-md border border-rose-500/40 bg-rose-950/30 p-2 text-rose-200">{err}</div>}
      <div className="flex flex-wrap justify-end gap-1.5"><button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
        <button type="submit" className="btn btn-primary" autoFocus disabled={busy || !check || !!refused}>{busy ? 'Saving…' : repo.auto_mode ? 'Save' : 'Turn on auto'}</button></div>
    </form>
  </Backdrop>
}

function SummaryDialog({ run, name, onClose, all }: { run: any; name: string; onClose: () => void; all: State }) {
  const [busy, go] = useBusy(), [err, setErr] = useState('') // shown in this box: the page's error strip is behind it
  const base = all.repos.find((r) => r.id === run.repo_id)?.default_branch ?? 'main'
  const undo = () => go(async () => { setErr(''); if (await undoConfirm(name)) await api(`auto-runs/${run.id}/undo`, {}).then(onClose, (e: Error) => setErr(errText(e))) })
  useEffect(() => { // busy: Undo's are-you-sure is up, and its Escape is only for that
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k)
  })
  return <Backdrop onClose={onClose} canClose={!busy} z="z-[80]">{/* under HQ's dialog: Undo's are-you-sure opens on top */}
    <div role="dialog" aria-modal="true" aria-label={`What auto mode did in ${name}`}
      className="flex max-h-[90vh] w-[560px] max-w-full flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-xs text-zinc-300 shadow-xl">
      <div className="break-words text-sm font-medium text-zinc-100">What auto mode did in {name}</div>
      <div className="break-words"><Md text={run.summary ?? ''} /></div>
      <Findings all={all.findings ?? []} repoId={run.repo_id} />
      {err && <div role="alert" className="break-words rounded-md border border-rose-500/40 bg-rose-950/30 p-2 text-rose-200">{err}</div>}
      <div className="flex flex-wrap justify-end gap-1.5">{(run.status === 'finished' || run.status === 'off') && run.start_sha && run.end_sha !== run.start_sha
        && <button className="btn" disabled={busy} title={`Put ${base} back where this run started. The work stays on its branches.`} onClick={undo}>{busy ? 'Undoing…' : 'Undo this run'}</button>}
        <button className="btn btn-primary" autoFocus disabled={busy} onClick={onClose}>Close</button></div>
    </div>
  </Backdrop>
}
/** Under the top bar, when auto mode has something to say: stopped (and why), waiting, or finished. */
export function AutoBanner({ all, repo }: { all: State; repo: any }) {
  const [busy, run] = useBusy(), [shownId, setShownId] = useState<string | null>(null)
  const done = finishedNotice(all, repo.id), last = latestRun(all, repo.id), shown = runsOf(all, repo.id).find((r) => r.id === shownId)
  const proposed = repo.test_cmd_proposed ? JSON.parse(repo.test_cmd_proposed) as { now: string; left_out: string } : null
  useEffect(() => {
    const open = (e: Event) => { if ((e as CustomEvent<string>).detail === repo.id) setShownId(latestRun(all, repo.id)?.id ?? null) }
    window.addEventListener(OPEN_SUMMARY, open); return () => window.removeEventListener(OPEN_SUMMARY, open)
  })
  /** Read: the alert is done with, here and in the ⚠ menu. Not if a newer run finished behind the dialog: that's still unread. */
  const closeSummary = () => { setShownId(null); if (done && shownId === last?.id) run(() => api(`attention/${done.id}/resolve`, {})) }
  const row = (tone: string, text: string, kids: React.ReactNode) => <div role="status" className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1 text-xs ${tone}`}>
    <span className="min-w-0 grow break-words">{text}</span><span className="flex flex-wrap gap-1">{kids}</span></div>
  return <>
    {repo.auto_stopped_why && row('border-rose-500/40 bg-rose-950/40 text-rose-200', `Auto mode stopped: ${repo.auto_stopped_why}`, <>
      <button className="btn-sm" disabled={busy} title="HQ looks again, and stops again if the reason is still there" onClick={() => run(() => api(`repos/${repo.id}/auto-resume`, {}))}>Resume</button>
      <button className="btn-sm" disabled={busy} onClick={() => run(() => api(`repos/${repo.id}/auto`, { on: false }))}>Turn off</button></>)}
    {!repo.auto_stopped_why && repo.auto_waiting && row('border-amber-500/40 bg-amber-950/30 text-amber-200', repo.auto_waiting,
      /^No tests/.test(repo.auto_waiting) ? <button className="btn-sm" onClick={() => openAuto(repo.id)}>Add a test command</button> : null)}
    {proposed && row('border-amber-500/40 bg-amber-950/30 text-amber-200', `A repair wants to change the test command to: ${proposed.now}. It leaves out: ${proposed.left_out}`, <>
      <button className="btn-sm" disabled={busy} onClick={() => run(() => api(`repos/${repo.id}/test-cmd-answer`, { use: true }))}>Use it</button>
      <button className="btn-sm" disabled={busy} onClick={() => run(() => api(`repos/${repo.id}/test-cmd-answer`, { use: false }))}>Keep the old one</button></>)}
    {done && last && row('border-emerald-500/40 bg-emerald-950/30 text-emerald-200', `Auto mode finished in ${repo.name}.`, <>
      <button className="btn-sm" onClick={() => openSummary(repo.id)}>Read the summary</button>
      <button className="btn-sm" disabled={busy} onClick={() => run(() => api(`attention/${done.id}/resolve`, {}))}>Dismiss</button></>)}
    {shown && <SummaryDialog run={shown} name={repo.name} onClose={closeSummary} all={all} />}
  </>
}

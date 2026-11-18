// The findings loop on screen (Part 5): under a run's summary, what auto mode's testing found that waits for the user. Per finding: Fix or Ignore (and for one no
// criterion covers, Make it a rule or Fine as is), with its wording editable; then Send. Nothing is fixed until Send, and only what's marked goes.
// The backend keeps everything (findings.ts); this only shows it and sends the user's choices.
import { useState } from 'react'
import { api, errText } from './api'
import { SOURCE_WORDS, STATE_WORDS, expectWords, said, stepWords, type Decision, type Kept } from '../../backend/src/findingrules.ts'

type F = Kept & { fid: string; id: string }
const CHOICES: { d: Decision; label: string; tip: string; only?: 'unspecified' | 'specified' }[] = [
  { d: 'fix', label: 'Fix', tip: 'Send it to the TPM for a fix ticket. The next run replays it to check the fix.' },
  { d: 'rule', label: 'Make it a rule', tip: 'Write the rule it breaks. It becomes a criterion of its fix ticket.', only: 'unspecified' },
  { d: 'fine', label: 'Fine as is', tip: 'Nothing to change. HQ won\'t report it again.', only: 'unspecified' },
  { d: 'ignore', label: 'Ignore', tip: 'HQ won\'t report it again.' },
]

function One({ f, repoId, onErr }: { f: F; repoId: string; onErr: (s: string) => void }) {
  const [editing, setEditing] = useState(false), [text, setText] = useState(said(f)), [rule, setRule] = useState(f.rule ?? ''), [busy, setBusy] = useState(false)
  const post = async (body: Record<string, unknown>) => {
    setBusy(true); onErr('')
    try { await api(`repos/${repoId}/findings/${f.fid}`, body); return true } catch (e) { onErr(errText(e as Error)); return false } finally { setBusy(false) } }
  const choose = (d: Decision) => void post({ decision: f.decision === d ? null : d, ...(d === 'rule' ? { rule } : {}) })
  const flagged = f.state === 'flagged', last = f.checks.at(-1)
  return <li className="flex flex-col gap-1.5 rounded-md border border-zinc-700/70 p-2">
    <div className="flex flex-wrap items-baseline gap-x-2 text-zinc-400"><span className="font-mono text-zinc-200">{f.fid}</span><span>{SOURCE_WORDS[f.source]}</span>
      {f.criterion && <span>· breaks {f.criterion}</span>}{f.strikes > 0 && <span className="text-amber-300">· still broken after {f.tickets.at(-1)}</span>}
      {flagged && <span className="text-rose-300">· {STATE_WORDS.flagged}: no more tickets</span>}</div>
    {editing ? <div className="flex flex-col gap-1"><textarea className="input min-h-[3.5rem]" aria-label={`Wording of ${f.fid}`} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap justify-end gap-1"><button className="btn-sm" disabled={busy} onClick={() => { setText(said(f)); setEditing(false) }}>Cancel</button>
        <button className="btn-sm" disabled={busy} onClick={() => void post({ wording: text }).then((ok) => ok && setEditing(false))}>Save wording</button></div></div>
      : <div className="break-words text-zinc-200">{said(f)} <button className="text-sky-300 underline" title="Change the words the TPM gets" onClick={() => setEditing(true)}>Edit</button></div>}
    <div className="break-words text-zinc-400">Should be: {f.expected}</div>
    {f.back && <div className="break-words text-amber-300/90">Back with you: {f.back}.</div>}
    {last && last.result === 'broken' && <div className="break-words text-amber-300/90">Replay after the fix: {last.why}</div>}
    <details><summary className="cursor-pointer text-zinc-500">Steps and evidence</summary>
      <ol className="ml-5 list-decimal break-words text-zinc-300">{f.steps.map((s, i) => <li key={i}>{stepWords(s)}</li>)}
        {f.expect?.map((e, i) => <li key={`e${i}`}>check that {expectWords(e)}</li>)}</ol>
      {f.evidence.rows.length > 0 && <pre className="mt-1 overflow-x-auto whitespace-pre text-[11px] text-zinc-400">{f.evidence.rows.join('\n')}</pre>}</details>
    {f.decision === 'rule' || (f.source === 'unspecified' && !flagged) ? <input className="input" aria-label={`Rule for ${f.fid}`} placeholder="The rule, if you make it one: when X happens, Y is true"
      value={rule} onChange={(e) => setRule(e.target.value)} /> : null}
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`What to do with ${f.fid}`}>
      {CHOICES.filter((c) => !(c.only === 'unspecified' && f.source !== 'unspecified') && !(flagged && c.d !== 'ignore')).map((c) =>
        <button key={c.d} role="radio" aria-checked={f.decision === c.d} title={c.tip} disabled={busy || (c.d === 'rule' && !rule.trim() && f.decision !== 'rule')}
          className={`btn-sm ${f.decision === c.d ? 'border-sky-400! text-sky-200!' : ''}`} onClick={() => choose(c.d)}>{c.label}</button>)}
    </div>
  </li>
}

/** The project's findings that wait for the user, and Send. Nothing when there are none. */
export function Findings({ all, repoId }: { all: F[]; repoId: string }) {
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false), [sent, setSent] = useState('')
  const waiting = all.filter((f) => f.repo_id === repoId && (f.state === 'new' || f.state === 'flagged') && !(f.state === 'flagged' && f.decision === 'ignore'))
    .sort((a, b) => Number(a.fid.slice(2)) - Number(b.fid.slice(2)))
  const marked = waiting.filter((f) => f.decision), toFix = marked.filter((f) => f.decision === 'fix' || f.decision === 'rule').length
  if (!waiting.length && !sent) return null
  const send = async () => {
    setBusy(true); setErr('')
    try { const r = await api<{ sent: string[]; closed: string[] }>(`repos/${repoId}/findings-send`, {})
      setSent(`${r.sent.length ? `Sent ${r.sent.join(', ')} to the TPM for fix tickets.` : ''} ${r.closed.length ? `Closed ${r.closed.join(', ')}.` : ''}`.trim()) }
    catch (e) { setErr(errText(e as Error)) } finally { setBusy(false) }
  }
  return <section aria-label="Findings" className="flex flex-col gap-2 border-t border-zinc-700 pt-2">
    <div className="text-sm font-medium text-zinc-100">Findings waiting for you ({waiting.length})</div>
    {waiting.length > 0 && <div className="text-zinc-400">Mark each one, then Send. Unmarked ones wait for the next time. Nothing is fixed until you send it.</div>}
    <ul className="flex flex-col gap-2">{waiting.map((f) => <One key={f.id} f={f} repoId={repoId} onErr={setErr} />)}</ul>
    {sent && <div role="status" className="text-emerald-300">{sent}</div>}
    {err && <div role="alert" className="break-words rounded-md border border-rose-500/40 bg-rose-950/30 p-2 text-rose-200">{err}</div>}
    {waiting.length > 0 && <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-zinc-500">{marked.length ? `${toFix} to fix, ${marked.length - toFix} to close` : 'Nothing marked yet'}</span>
      <button className="btn btn-primary" disabled={busy || !marked.length} onClick={() => void send()}>{busy ? 'Sending…' : 'Send'}</button></div>}
  </section>
}

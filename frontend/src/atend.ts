// A list that reads newest last (the TPM's Chat). Bug 255: it opened scrolled to the top, so with a few replies the newest was out of view.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Bug 286: what this browser tab sent. Every open tab gets every message, so "from the user" doesn't say it was sent here: one sent
 *  from another tab or window must leave a reader who scrolled up here where they are. `sendHere` wraps the request and keeps the id HQ
 *  answers with; while a request is still out, a new message counts as this tab's too (its patch can come before the answer). */
const sentIds = new Set<string>(); let out = 0
export async function sendHere<T>(go: () => Promise<T>, idOf: (r: T) => unknown): Promise<T> {
  out++
  try { const r = await go(), id = idOf(r); if (typeof id === 'string' || typeof id === 'number') sentIds.add(String(id)); return r } finally { out-- }
}
/** Was the message with this id sent from this tab (or is a send from here still out)? */
export const sentHere = (id: string | number | undefined): boolean => id !== undefined && (out > 0 || sentIds.has(String(id)))

/** It opens scrolled to the end and follows new items there. Once the user scrolls up it leaves them where they are, and `unseen` says
 *  a newer item came in below; scrolling back down, or `toEnd`, follows again. An item sent from this tab (`mine`, see `sentHere`)
 *  always brings the end into view. A resize (the board panned or zoomed) keeps the end in view when it was. Pass the newest item's id; put `ref`
 *  and `onScroll` on the scrolling element. */
export function useAtEnd(newest: string | number | undefined, mine = false) {
  const box = useRef<HTMLDivElement | null>(null), stuck = useRef(true), seen = useRef(newest), watch = useRef<ResizeObserver | null>(null)
  const [unseen, setUnseen] = useState(false)
  const toEnd = useCallback(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; stuck.current = true; setUnseen(false) }, [])
  const ref = useCallback((el: HTMLDivElement | null) => {
    box.current = el; watch.current?.disconnect(); watch.current = null
    if (el && typeof ResizeObserver !== 'undefined') { // the board panned or zoomed: the list's size changed under the user
      watch.current = new ResizeObserver(() => { if (stuck.current) el.scrollTop = el.scrollHeight }); watch.current.observe(el)
    }
  }, [])
  useEffect(() => () => watch.current?.disconnect(), [])
  useLayoutEffect(() => {
    const fresh = newest !== seen.current; seen.current = newest
    if (stuck.current || (fresh && mine)) toEnd(); else if (fresh) setUnseen(true)
  }, [newest, mine, toEnd])
  const onScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; if (stuck.current) setUnseen(false)
  }, [])
  return { ref, onScroll, unseen, toEnd }
}

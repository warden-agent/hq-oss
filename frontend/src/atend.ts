// A list that reads newest last (the TPM's Chat). Bug 255: it opened scrolled to the top, so with a few replies the newest was out of view.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** It opens scrolled to the end and follows new items there. Once the user scrolls up it leaves them where they are, and `unseen` says
 *  a newer item came in below; scrolling back down, or `toEnd`, follows again. An item the user sent themselves (`mine`) always brings
 *  the end into view. A resize (the board panned or zoomed) keeps the end in view when it was. Pass the newest item's id; put `ref`
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

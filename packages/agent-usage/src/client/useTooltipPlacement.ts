/**
 * Places a chart tooltip beside an anchor x without letting it leave the chart: it opens on the
 * side with more room, then is clamped by its measured width, so a long breakdown never clips.
 *
 * @module
 */
import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react"

const GAP = 12

/** Where a tooltip of `tooltipWidth` goes for an anchor in a chart `chartWidth` wide. */
export const tooltipLeft = (anchor: number, tooltipWidth: number, chartWidth: number): number => {
  const preferred = anchor > chartWidth / 2 ? anchor - GAP - tooltipWidth : anchor + GAP
  return Math.max(0, Math.min(preferred, chartWidth - tooltipWidth))
}

/** The tooltip element's ref and its position; spread both onto the tooltip. */
export interface TooltipPlacement {
  readonly ref: RefObject<HTMLDivElement | null>
  readonly style: CSSProperties
}

export const useTooltipPlacement = (anchor: number | null, chartWidth: number, top: number): TooltipPlacement => {
  const ref = useRef<HTMLDivElement | null>(null)
  const [tooltipWidth, setTooltipWidth] = useState(0)
  useLayoutEffect(() => {
    const measured = ref.current?.offsetWidth ?? 0
    if (measured !== tooltipWidth) setTooltipWidth(measured)
  })
  return { ref, style: { left: anchor === null ? 0 : tooltipLeft(anchor, tooltipWidth, chartWidth), top } }
}

/**
 * Escape dismisses a shown tooltip, whether a pointer or focus opened it, without moving focus;
 * the next focus or pointer move shows it again.
 */
export const useDismissOnEscape = (shown: boolean, dismiss: () => void): void => {
  useEffect(() => {
    if (!shown) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [shown, dismiss])
}

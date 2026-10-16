import { createContext } from "react"

/**
 * The active Limits page groups its mast (title and tabs) with the shell header, as the design's header region does;
 * other pages keep their chrome. `setGrouped` asks for the grouped header; `setEmpty` additionally selects the
 * empty-state chrome.
 */
export interface UsageEmptyChrome {
  readonly host: string
  readonly headerOutlet: HTMLElement | null
  readonly setEmpty: (empty: boolean) => void
  readonly setGrouped: (grouped: boolean) => void
}

export const UsageEmptyChromeContext = createContext<UsageEmptyChrome | null>(null)

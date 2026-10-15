import { createContext } from "react"

/** The active empty Limits page groups its mast with the shell header; other pages keep their chrome. */
export interface UsageEmptyChrome {
  readonly host: string
  readonly headerOutlet: HTMLElement | null
  readonly setEmpty: (empty: boolean) => void
}

export const UsageEmptyChromeContext = createContext<UsageEmptyChrome | null>(null)

import { createContext } from "react"

/** What a module asks of the shell's header: the grouped header around its outlet, and the empty-state chrome. */
export interface ModuleHeaderMode {
  readonly grouped: boolean
  readonly empty: boolean
}

/**
 * The shell's header, lent to the module on screen. A module that groups gets the shell's header region with an
 * outlet it may portal its own title and tabs into (`outlet`, null until the grouped header has rendered); `empty`
 * also selects the empty-state chrome. Each module's mode is kept apart, so only the active module's applies.
 */
export interface ShellHeader {
  readonly host: string
  readonly outlet: HTMLElement | null
  readonly setMode: (module: string, mode: Partial<ModuleHeaderMode>) => void
  /**
   * A module whose page arrives after the shell's arrival focus ran (an app's client loads asynchronously) calls this
   * once its page is in the document: if focus still rests on the shell's fallback (`<main>` or the body), the shell
   * focuses that page's link or tab as it meant to.
   */
  readonly settleArrivalFocus: (module: string) => void
}

export const ShellHeaderContext = createContext<ShellHeader | null>(null)

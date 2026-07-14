import type { SessionSummary } from "../api/session.js"
import { createContext, type ReactElement, type ReactNode, useContext, useMemo, useState } from "react"

export type BrowserSessionState =
  | { readonly _tag: "anonymous" }
  | { readonly _tag: "authenticated"; readonly session: SessionSummary }
  | { readonly _tag: "blocked" }
  | { readonly _tag: "checking" }
  | { readonly _tag: "unavailable" }

interface BrowserSessionContextValue {
  readonly setState: (state: BrowserSessionState) => void
  readonly state: BrowserSessionState
}

interface BrowserSessionProviderProps {
  readonly children: ReactNode
}

const BrowserSessionContext = createContext<BrowserSessionContextValue | undefined>(undefined)

/** Hold browser authentication state once for every application route. */
export const BrowserSessionProvider = ({ children }: BrowserSessionProviderProps): ReactElement => {
  const [state, setState] = useState<BrowserSessionState>({ _tag: "checking" })
  const value = useMemo(() => ({ setState, state }), [state])
  return <BrowserSessionContext value={value}>{children}</BrowserSessionContext>
}

/** Read or update the application-wide browser session state. */
export const useBrowserSession = (): BrowserSessionContextValue => {
  const value = useContext(BrowserSessionContext)
  if (value === undefined) throw new Error("Browser session state requires BrowserSessionProvider")
  return value
}

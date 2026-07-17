import type { CsrfToken, SessionSummary } from "../api/session.js"
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState
} from "react"

export type BrowserSessionState =
  | { readonly _tag: "anonymous" }
  | { readonly _tag: "authenticated"; readonly session: SessionSummary }
  | { readonly _tag: "blocked" }
  | { readonly _tag: "checking" }
  | { readonly _tag: "storage-unavailable"; readonly session: SessionSummary | null }
  | { readonly _tag: "unavailable" }

/** Cookie-authenticated reads remain available when only mutation-proof storage failed. */
export const browserReadableSessionKey = (state: BrowserSessionState): string | null => {
  switch (state._tag) {
    case "authenticated":
      return state.session.sessionId
    case "storage-unavailable":
      return state.session?.sessionId ?? null
    case "anonymous":
    case "blocked":
    case "checking":
    case "unavailable":
      return null
  }
}

interface BrowserSessionContextValue {
  readonly beginHydration: () => symbol
  readonly completeHydration: (attempt: symbol, result: BrowserSessionHydrationResult) => void
  readonly establishSession: (csrfToken: CsrfToken, session: SessionSummary) => void
  readonly invalidateSession: (expectedSessionId: string) => void
  readonly state: BrowserSessionState
}

type BrowserSessionHydrationResult =
  | (Extract<BrowserSessionState, { readonly _tag: "authenticated" }> & {
      readonly csrfToken: CsrfToken
    })
  | Exclude<BrowserSessionState, { readonly _tag: "authenticated" | "checking" }>

interface BrowserSessionProviderProps {
  readonly children: ReactNode
}

const BrowserSessionContext = createContext<BrowserSessionContextValue | undefined>(undefined)

const clearMutationProof = (): boolean => {
  try {
    sessionStorage.removeItem("cc_csrf")
    sessionStorage.removeItem("cc_session_id")
    return true
  } catch {
    return false
  }
}

const storeMutationProof = (csrfToken: CsrfToken, sessionId: string): boolean => {
  try {
    sessionStorage.setItem("cc_csrf", csrfToken)
    sessionStorage.setItem("cc_session_id", sessionId)
    return true
  } catch {
    clearMutationProof()
    return false
  }
}

/** Hold browser authentication state once for every application route. */
export const BrowserSessionProvider = ({ children }: BrowserSessionProviderProps): ReactElement => {
  const [state, setState] = useState<BrowserSessionState>({ _tag: "checking" })
  const hydrationAttempt = useRef<symbol | undefined>(undefined)
  const currentSessionId = useRef<string | null>(null)

  const beginHydration = useCallback((): symbol => {
    const attempt = Symbol("browser-session-hydration")
    hydrationAttempt.current = attempt
    return attempt
  }, [])

  const completeHydration = useCallback((attempt: symbol, result: BrowserSessionHydrationResult): void => {
    if (hydrationAttempt.current !== attempt) return
    hydrationAttempt.current = undefined
    if (result._tag === "authenticated") {
      currentSessionId.current = result.session.sessionId
      setState(
        storeMutationProof(result.csrfToken, result.session.sessionId)
          ? { _tag: "authenticated", session: result.session }
          : { _tag: "storage-unavailable", session: result.session }
      )
      return
    }
    currentSessionId.current = result._tag === "storage-unavailable" ? (result.session?.sessionId ?? null) : null
    if (result._tag === "anonymous") {
      setState(clearMutationProof() ? result : { _tag: "storage-unavailable", session: null })
      return
    }
    setState(result)
  }, [])

  const establishSession = useCallback((csrfToken: CsrfToken, session: SessionSummary): void => {
    hydrationAttempt.current = undefined
    currentSessionId.current = session.sessionId
    setState(
      storeMutationProof(csrfToken, session.sessionId)
        ? { _tag: "authenticated", session }
        : { _tag: "storage-unavailable", session }
    )
  }, [])

  const invalidateSession = useCallback((expectedSessionId: string): void => {
    if (currentSessionId.current !== expectedSessionId) return
    hydrationAttempt.current = undefined
    currentSessionId.current = null
    setState(clearMutationProof() ? { _tag: "anonymous" } : { _tag: "storage-unavailable", session: null })
  }, [])

  const value = useMemo(
    () => ({ beginHydration, completeHydration, establishSession, invalidateSession, state }),
    [beginHydration, completeHydration, establishSession, invalidateSession, state]
  )
  return <BrowserSessionContext value={value}>{children}</BrowserSessionContext>
}

/** Read or update the application-wide browser session state. */
export const useBrowserSession = (): BrowserSessionContextValue => {
  const value = useContext(BrowserSessionContext)
  if (value === undefined) throw new Error("Browser session state requires BrowserSessionProvider")
  return value
}

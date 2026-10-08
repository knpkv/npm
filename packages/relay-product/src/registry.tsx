import type * as Effect from "effect/Effect"
import {
  createContext,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react"

import type {
  AgenticProduct,
  ContinuePullRequestConversationRequest,
  PullRequestConversation,
  PullRequestConversationContinuationFailure,
  PullRequestConversationLocator,
  PullRequestConversationLookupFailure,
  PullRequestConversationRedirectFailed,
  RelayAuthenticationFailure,
  RelayProductAdapterContractError,
  RelayProductContinuationReceiptMismatch
} from "./conversation.js"
import type { RelaySelectorState } from "./model.js"

export interface RelayProductDockHost {
  readonly context: ReadonlyArray<{ readonly id: string; readonly label: string; readonly value: string }>
  readonly locatePullRequestConversation: (
    locator: PullRequestConversationLocator
  ) => Effect.Effect<void, RelayProductDockLocateFailure>
  readonly product: AgenticProduct
  readonly selection: RelaySelectorState
}

export interface RelayProductDockMessage {
  readonly id: string
  readonly role: "operator" | "relay" | "system"
  readonly text: string
}

type RelayProductDockContinuationFailure =
  | RelayAuthenticationFailure
  | PullRequestConversationContinuationFailure
  | RelayProductAdapterContractError
  | RelayProductContinuationReceiptMismatch

type RelayProductDockLocateFailure =
  | RelayAuthenticationFailure
  | PullRequestConversationLookupFailure
  | PullRequestConversationRedirectFailed
  | RelayProductAdapterContractError

interface RelayPullRequestDockRegistrationBase {
  readonly context: ReadonlyArray<{ readonly id: string; readonly label: string; readonly value: string }>
  readonly conversation: PullRequestConversation
  readonly selection: RelaySelectorState
}

export type RelayPullRequestDockRegistration = RelayPullRequestDockRegistrationBase &
  (
    | {
        readonly status: "loading"
      }
    | {
        readonly continuePullRequestConversation: (
          request: typeof ContinuePullRequestConversationRequest.Type
        ) => Effect.Effect<void, RelayProductDockContinuationFailure>
        readonly messages: ReadonlyArray<RelayProductDockMessage>
        readonly status: "ready"
      }
    | {
        readonly description: string
        readonly status: "error" | "unavailable"
      }
  )

interface RelayPullRequestDockRegistry {
  readonly register: (registration: RelayPullRequestDockRegistration) => () => void
  readonly registration: RelayPullRequestDockRegistration | null
  /** Whether the Relay panel is open; shared by the header launcher and the panel. */
  readonly open: boolean
  readonly setOpen: (open: boolean | ((current: boolean) => boolean)) => void
  /** The header launcher, where the panel returns focus. */
  readonly launcher: RefObject<HTMLButtonElement | null>
  /** How many panels have claimed Relay's Ctrl/⌘+J under this provider; more than one is a bug. */
  readonly summonClaims: RefObject<number>
}

export class RelayProductDockProviderMissing extends Error {
  readonly _tag = "RelayProductDockProviderMissing"

  constructor() {
    super("Relay product dock provider is missing")
  }
}

const RelayPullRequestDockContext = createContext<RelayPullRequestDockRegistry | undefined>(undefined)

/** Provide one route-lifetime registration slot without loading the dock chrome. */
export const RelayProductDockProvider = ({ children }: { readonly children: ReactNode }): ReactElement => {
  const [registration, setRegistration] = useState<RelayPullRequestDockRegistration | null>(null)
  const [open, setOpen] = useState(false)
  const launcher = useRef<HTMLButtonElement | null>(null)
  const summonClaims = useRef(0)
  const register = useCallback((next: RelayPullRequestDockRegistration) => {
    setRegistration(next)
    return () => {
      setRegistration((current) => (current === next ? null : current))
    }
  }, [])
  const registry = useMemo<RelayPullRequestDockRegistry>(
    () => ({ launcher, open, register, registration, setOpen, summonClaims }),
    [open, register, registration]
  )
  return <RelayPullRequestDockContext value={registry}>{children}</RelayPullRequestDockContext>
}

/** Attach one exact PR controller to the application-level Relay dock for this route lifetime. */
export const useRelayPullRequestDock = (registration: RelayPullRequestDockRegistration): void => {
  const registry = useContext(RelayPullRequestDockContext)
  if (registry === undefined) throw new RelayProductDockProviderMissing()
  useEffect(() => registry.register(registration), [registration, registry.register])
}

/** Read the current route registration from the lightweight provider. */
export const useRelayProductDockRegistration = (): RelayPullRequestDockRegistration | null => {
  const registry = useContext(RelayPullRequestDockContext)
  if (registry === undefined) throw new RelayProductDockProviderMissing()
  return registry.registration
}

/** The Relay panel's open state and the header launcher, shared through the provider. */
export const useRelayProductOpen = (): Pick<RelayPullRequestDockRegistry, "launcher" | "open" | "setOpen"> => {
  const registry = useContext(RelayPullRequestDockContext)
  if (registry === undefined) throw new RelayProductDockProviderMissing()
  return { launcher: registry.launcher, open: registry.open, setOpen: registry.setOpen }
}

/** Two panels under one provider would both bind Ctrl/⌘+J, so a second one fails loudly. */
export class RelayProductSummonClaimed extends Error {
  readonly _tag = "RelayProductSummonClaimed"

  constructor() {
    super("Only one RelayProductPanel may be mounted per RelayProductDockProvider")
  }
}

/** Claim Relay's keyboard summon for this provider; a second claim throws RelayProductSummonClaimed. */
export const useSummonClaim = (): void => {
  const registry = useContext(RelayPullRequestDockContext)
  if (registry === undefined) throw new RelayProductDockProviderMissing()
  const claims = registry.summonClaims
  useEffect(() => {
    claims.current += 1
    if (claims.current > 1) {
      claims.current -= 1
      throw new RelayProductSummonClaimed()
    }
    return () => {
      claims.current -= 1
    }
  }, [claims])
}

import type * as Effect from "effect/Effect"
import { createContext, type ReactElement, type ReactNode, useContext, useEffect, useMemo, useState } from "react"

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
  const registry = useMemo<RelayPullRequestDockRegistry>(
    () => ({
      register: (next) => {
        setRegistration(next)
        return () => {
          setRegistration((current) => (current === next ? null : current))
        }
      },
      registration
    }),
    [registration]
  )
  return <RelayPullRequestDockContext value={registry}>{children}</RelayPullRequestDockContext>
}

/** Attach one exact PR controller to the application-level Relay dock for this route lifetime. */
export const useRelayPullRequestDock = (registration: RelayPullRequestDockRegistration): void => {
  const registry = useContext(RelayPullRequestDockContext)
  if (registry === undefined) throw new RelayProductDockProviderMissing()
  useEffect(() => registry.register(registration), [registration, registry])
}

/** Read the current route registration from the lightweight provider. */
export const useRelayProductDockRegistration = (): RelayPullRequestDockRegistration | null => {
  const registry = useContext(RelayPullRequestDockContext)
  if (registry === undefined) throw new RelayProductDockProviderMissing()
  return registry.registration
}

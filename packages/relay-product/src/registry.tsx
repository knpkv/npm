import type { RlyRelayMarkActivity } from "@knpkv/rly/patterns"
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
  /**
   * Another Relay conversation this host offers (Control Center's release conversation, say): before the
   * pull-request locator where no pull request is registered, after it while finding another one.
   */
  readonly alternate?: RelayProductDockAlternate | undefined
}

/** A host's other Relay conversation, opened by the host (navigating to its own page). */
export interface RelayProductDockAlternate {
  /** The action, naming the conversation: "Open the Release 2.18 conversation". */
  readonly label: string
  readonly onOpen: () => void
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
  /**
   * Whether the product's own Relay run for this pull request (a review, say) is in progress; Relay's
   * mark shows it, and the product still says it in words. A continuation sent from the panel counts on
   * its own, so leave this out unless the product runs Relay elsewhere.
   */
  readonly working?: boolean | undefined
}

/** One thing inside a pull request the next message is about. */
export interface RelayProductDockAbout {
  readonly id: string
  readonly label: string
  readonly onClear: () => void
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
        /**
         * What the next message is about inside this PR (a finding, say), shown as a removable
         * reference on the composer; clearing it sends to the whole pull request.
         */
        readonly about?: RelayProductDockAbout | undefined
        /** One line the panel shows above its composer (another composer on this page, say). */
        readonly notice?: string | undefined
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
  /** Whether the user pinned Relay beside the page; the host lays out its column from this and `open`. */
  readonly pinned: boolean
  readonly setPinned: (pinned: boolean) => void
  /** The header launcher, where the panel returns focus unless something else opened it. */
  readonly launcher: RefObject<HTMLButtonElement | null>
  /** Where closing returns focus: the launcher, or the control that last opened Relay (openFrom). */
  readonly returnTo: RefObject<HTMLElement | null>
  /** Open Relay from a page control (Discuss, say); closing returns focus to that control. */
  readonly openFrom: (control: HTMLElement) => void
  /** Per thread, what its kept draft was written about, so a change survives closing Relay. */
  readonly draftAbout: RefObject<Map<string, string | null>>
  /** How many panels have claimed Relay's Ctrl/⌘+J under this provider; more than one is a bug. */
  readonly summonClaims: RefObject<number>
  /** How many continuations sent from Relay are still waiting on their answer. */
  readonly answering: number
  readonly setAnswering: (update: (current: number) => number) => void
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
  const [pinned, setPinned] = useState(false)
  const [answering, setAnswering] = useState(0)
  const launcher = useRef<HTMLButtonElement | null>(null)
  const summonClaims = useRef(0)
  const returnTo = useRef<HTMLElement | null>(null)
  const draftAbout = useRef(new Map<string, string | null>())
  const openFrom = useCallback((control: HTMLElement) => {
    returnTo.current = control
    setOpen(true)
  }, [])
  const register = useCallback((next: RelayPullRequestDockRegistration) => {
    setRegistration(next)
    return () => {
      setRegistration((current) => (current === next ? null : current))
    }
  }, [])
  const registry = useMemo<RelayPullRequestDockRegistry>(
    () => ({
      answering,
      draftAbout,
      launcher,
      open,
      openFrom,
      pinned,
      register,
      registration,
      returnTo,
      setAnswering,
      setOpen,
      setPinned,
      summonClaims
    }),
    [answering, open, pinned, register, registration]
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

/**
 * The Relay panel's open and pinned state and the header launcher, shared through the provider. A host
 * renders RelayProductPanel in its own column when `open && pinned` and the viewport allows pinning.
 */
export const useRelayProductOpen = (): Pick<
  RelayPullRequestDockRegistry,
  "draftAbout" | "launcher" | "open" | "openFrom" | "pinned" | "returnTo" | "setOpen" | "setPinned"
> => {
  const registry = useContext(RelayPullRequestDockContext)
  if (registry === undefined) throw new RelayProductDockProviderMissing()
  return {
    draftAbout: registry.draftAbout,
    launcher: registry.launcher,
    open: registry.open,
    openFrom: registry.openFrom,
    pinned: registry.pinned,
    returnTo: registry.returnTo,
    setOpen: registry.setOpen,
    setPinned: registry.setPinned
  }
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

/**
 * What Relay is doing, for its mark: `working` while the registered product runs Relay or a continuation
 * sent from Relay waits on its answer, else `idle`. Products have no decision state yet, so never
 * `attention`. The launcher, panel and dock read it; a host need not.
 */
export const useRelayProductActivity = (): RlyRelayMarkActivity => {
  const registry = useContext(RelayPullRequestDockContext)
  if (registry === undefined) throw new RelayProductDockProviderMissing()
  return registry.answering > 0 || registry.registration?.working === true ? "working" : "idle"
}

/**
 * Starts counting Relay as answering; call the returned function once the answer arrives or fails.
 * The registry stays free of the Effect runtime (hosts load it eagerly), so the lazy panel and dock wrap
 * their continuation with `answeringWhile` instead.
 */
export const useRelayProductAnswering = (): (() => () => void) => {
  const registry = useContext(RelayPullRequestDockContext)
  if (registry === undefined) throw new RelayProductDockProviderMissing()
  const { setAnswering } = registry
  return useCallback(() => {
    setAnswering((current) => current + 1)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      setAnswering((current) => current - 1)
    }
  }, [setAnswering])
}

import type { RlyRelayDockState } from "@knpkv/rly/patterns"
import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import {
  type FormEvent,
  Component,
  lazy,
  type ReactElement,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react"

import {
  ContinuePullRequestConversationRequest,
  type PullRequestConversationContinuationFailure,
  type PullRequestConversationLookupFailure,
  type PullRequestConversationRedirectFailed,
  PullRequestConversationLocator,
  pullRequestThreadIdentity,
  type RelayAuthenticationFailure,
  type RelayProductAdapterContractError,
  type RelayProductContinuationReceiptMismatch
} from "./conversation.js"
import {
  type RelayProductDockMessage,
  type RelayProductDockHost,
  type RelayPullRequestDockRegistration,
  RelayProductDockProvider,
  useRelayProductDockRegistration
} from "./registry.js"
import type { RelaySelectorState } from "./model.js"

export class RelayProductDockInvariantViolation extends Data.TaggedError("RelayProductDockInvariantViolation")<{
  readonly boundary: "conversation" | "selector"
}> {}

const LazyRelayDock = lazy(async () => {
  const patterns = await import("@knpkv/rly/patterns")
  return { default: patterns.RelayDock }
})

interface RelayDockChromeBoundaryState {
  readonly failed: boolean
}

/** Keep routed product content mounted when optional Relay chrome cannot load. */
export class RelayProductDockChromeBoundary extends Component<
  { readonly children: ReactNode },
  RelayDockChromeBoundaryState
> {
  override state: RelayDockChromeBoundaryState = { failed: false }

  static getDerivedStateFromError(cause: unknown): RelayDockChromeBoundaryState {
    void cause
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
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

interface RelayProductDockProps {
  readonly children: ReactNode
  readonly host: RelayProductDockHost
}

const actionFailureDescription = (
  failure: RelayProductDockContinuationFailure | RelayProductDockLocateFailure
): string => {
  switch (failure._tag) {
    case "RelayAuthenticationRequired":
      return "Authenticate with this product before using its Relay conversations."
    case "RelayAuthorizationDenied":
      return "This session cannot use Relay for pull-request conversations."
    case "RelayAuthenticationUnavailable":
      return "The product authentication boundary is unavailable."
    case "PullRequestConversationNotFound":
      return `No Relay conversation matches ${failure.repositoryName} PR #${failure.pullRequestId}.`
    case "PullRequestConversationAmbiguous":
      return `${String(failure.matches)} Relay conversations match this pull request; include its account.`
    case "PullRequestConversationLookupFailed":
      return "Relay could not search the product's pull-request conversations."
    case "PullRequestConversationRedirectFailed":
      return "Relay found the conversation but could not open its exact pull-request page."
    case "PullRequestConversationContinuationRejected":
      return failure.reason === "conversation-busy"
        ? "This pull-request conversation already has a run in progress."
        : failure.reason === "selection-unavailable"
          ? "The selected Relay profile or model is no longer available."
          : "This pull-request conversation no longer exists."
    case "PullRequestConversationContinuationFailed":
      return "Relay could not continue this pull-request conversation."
    case "RelayProductAdapterContractError":
      return "The active product does not own this pull-request conversation."
    case "RelayProductContinuationReceiptMismatch":
      return "Relay returned a continuation receipt for another pull-request conversation."
  }
}

const failureFromCause = <Failure extends RelayProductDockContinuationFailure | RelayProductDockLocateFailure>(
  cause: Cause.Cause<Failure>
): string => {
  const failure = cause.reasons.find(Cause.isFailReason)
  return failure === undefined
    ? "Relay ended unexpectedly. No request was accepted."
    : actionFailureDescription(failure.error)
}

interface RunActionState {
  readonly description: string | null
  readonly pending: boolean
}

const useRelayDockAction = (): readonly [
  RunActionState,
  <Failure extends RelayProductDockContinuationFailure | RelayProductDockLocateFailure>(
    effect: Effect.Effect<void, Failure>
  ) => void
] => {
  const [state, setState] = useState<RunActionState>({ description: null, pending: false })
  const request = useRef(0)
  useEffect(
    () => () => {
      request.current += 1
    },
    []
  )
  const run = useCallback(
    <Failure extends RelayProductDockContinuationFailure | RelayProductDockLocateFailure>(
      effect: Effect.Effect<void, Failure>
    ): void => {
      request.current += 1
      const current = request.current
      setState({ description: null, pending: true })
      void Effect.runPromiseExit(effect).then((exit) => {
        if (request.current !== current) return
        setState(
          Exit.isSuccess(exit)
            ? { description: null, pending: false }
            : { description: failureFromCause(exit.cause), pending: false }
        )
      })
    },
    []
  )
  return [state, run]
}

const HostConversationLocator = ({ host }: { readonly host: RelayProductDockHost }): ReactElement => {
  const [accountId, setAccountId] = useState("")
  const [pullRequestId, setPullRequestId] = useState("")
  const [region, setRegion] = useState("")
  const [repositoryName, setRepositoryName] = useState("")
  const [validation, setValidation] = useState<string | null>(null)
  const [action, runAction] = useRelayDockAction()

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const account = accountId.trim()
    const locatorInput =
      account.length === 0
        ? {
            provider: "codecommit",
            pullRequestId: pullRequestId.trim(),
            region: region.trim(),
            repositoryName: repositoryName.trim()
          }
        : {
            accountId: account,
            provider: "codecommit",
            pullRequestId: pullRequestId.trim(),
            region: region.trim(),
            repositoryName: repositoryName.trim()
          }
    const decoded = Schema.decodeUnknownResult(PullRequestConversationLocator)(locatorInput)
    if (Result.isFailure(decoded)) {
      setValidation("Enter a region, repository, and pull-request number.")
      return
    }
    setValidation(null)
    runAction(host.locatePullRequestConversation(decoded.success))
  }

  return (
    <form aria-label="Find a pull request conversation" onSubmit={submit}>
      <h2>Find a pull request conversation</h2>
      <p>Relay opens the exact product page before continuing a PR thread.</p>
      <label>
        <span>Region</span>
        <input onChange={(event) => setRegion(event.currentTarget.value)} value={region} />
      </label>
      <label>
        <span>Repository</span>
        <input onChange={(event) => setRepositoryName(event.currentTarget.value)} value={repositoryName} />
      </label>
      <label>
        <span>Pull request</span>
        <input
          inputMode="numeric"
          onChange={(event) => setPullRequestId(event.currentTarget.value)}
          value={pullRequestId}
        />
      </label>
      <label>
        <span>Account (optional)</span>
        <input onChange={(event) => setAccountId(event.currentTarget.value)} value={accountId} />
      </label>
      {validation === null && action.description === null ? null : (
        <p aria-live="assertive" role="alert">
          {validation ?? action.description}
        </p>
      )}
      <button disabled={action.pending} type="submit">
        {action.pending ? "Opening PR conversation…" : "Open PR conversation"}
      </button>
    </form>
  )
}

const ThreadMessages = ({ messages }: { readonly messages: ReadonlyArray<RelayProductDockMessage> }): ReactElement =>
  messages.length === 0 ? (
    <p>No Relay turns yet. The first message starts this PR's durable thread.</p>
  ) : (
    <ol aria-label="Pull request conversation">
      {messages.map((message) => (
        <li data-relay-message-role={message.role} key={message.id}>
          <strong>{message.role === "relay" ? "Relay" : message.role === "operator" ? "You" : "System"}</strong>
          <p>{message.text}</p>
        </li>
      ))}
    </ol>
  )

export const relaySelectionMatchesRegistration = (
  selection: RelaySelectorState,
  registration: RelayPullRequestDockRegistration
): boolean =>
  selection.profileId === registration.selection.profileId && selection.modelId === registration.selection.modelId

const PullRequestContinuation = ({
  registration,
  selection
}: {
  readonly registration: Extract<RelayPullRequestDockRegistration, { readonly status: "ready" }>
  readonly selection: RelaySelectorState
}): ReactElement => {
  const [message, setMessage] = useState("")
  const [validation, setValidation] = useState<string | null>(null)
  const [action, runAction] = useRelayDockAction()
  const selectionMatchesRegistration = relaySelectionMatchesRegistration(selection, registration)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!selectionMatchesRegistration) {
      setValidation("Rerun Relay with the selected profile or model before continuing this PR thread.")
      return
    }
    const decoded = Schema.decodeUnknownResult(ContinuePullRequestConversationRequest)({
      conversation: registration.conversation,
      message: message.trim(),
      selection
    })
    if (Result.isFailure(decoded)) {
      setValidation("Enter a pull-request request of 8,000 characters or fewer.")
      return
    }
    setValidation(null)
    runAction(
      registration
        .continuePullRequestConversation(decoded.success)
        .pipe(Effect.tap(() => Effect.sync(() => setMessage(""))))
    )
  }

  return (
    <form aria-label="Continue pull request conversation" onSubmit={submit}>
      <label>
        <span>Continue this PR thread</span>
        <textarea
          maxLength={8_000}
          onChange={(event) => setMessage(event.currentTarget.value)}
          placeholder="Ask Relay to verify one concrete part of this pull request…"
          rows={3}
          value={message}
        />
      </label>
      {validation === null && action.description === null ? null : (
        <p aria-live="assertive" role="alert">
          {validation ?? action.description}
        </p>
      )}
      {!selectionMatchesRegistration && validation === null ? (
        <p aria-live="polite">Rerun Relay with the selected profile or model before continuing this PR thread.</p>
      ) : null}
      <button disabled={action.pending || message.trim().length === 0 || !selectionMatchesRegistration} type="submit">
        {action.pending ? "Continuing on this PR…" : "Continue on this PR"}
      </button>
    </form>
  )
}

const relayDockState = (
  host: RelayProductDockHost,
  registration: RelayPullRequestDockRegistration | null
): RlyRelayDockState => {
  if (registration === null) {
    return { content: <HostConversationLocator host={host} />, status: "ready" }
  }
  switch (registration.status) {
    case "loading":
      return {
        description: "Loading the durable conversation for this pull request.",
        status: "loading",
        title: "Loading PR thread"
      }
    case "error":
      return { description: registration.description, status: "error", title: "PR thread unavailable" }
    case "unavailable":
      return { description: registration.description, status: "unavailable", title: "Relay unavailable for this PR" }
    case "ready":
      return { content: <ThreadMessages messages={registration.messages} />, status: "ready" }
  }
}

const selectionIdentity = (registration: RelayPullRequestDockRegistration | null): string =>
  registration === null ? "host" : JSON.stringify(pullRequestThreadIdentity(registration.conversation))

const selectorRevision = (selection: RelaySelectorState): string =>
  JSON.stringify({
    modelId: selection.modelId,
    models: selection.models,
    profileId: selection.profileId,
    profiles: selection.profiles
  })

/** Own one collapsed Relay dock while application pages register exact PR threads underneath it. */
export const RelayProductDock = ({ children, host }: RelayProductDockProps): ReactElement => {
  return (
    <RelayProductDockProvider>
      {children}
      <RelayProductDockChrome host={host} />
    </RelayProductDockProvider>
  )
}

/** Render the chrome for a registration provider; keep this component lazy at product route boundaries. */
export const RelayProductDockChrome = ({ host }: { readonly host: RelayProductDockHost }): ReactElement => {
  const registration = useRelayProductDockRegistration()
  const activeSelection = registration?.selection ?? host.selection
  const identity = selectionIdentity(registration)
  const activeSelectorRevision = selectorRevision(activeSelection)
  const [selection, setSelection] = useState(activeSelection)
  useEffect(() => setSelection(activeSelection), [activeSelectorRevision, identity])

  const setModel = (value: string): void => {
    const option = selection.models.find(({ id }) => id === value)
    if (option === undefined) return
    const pairedProfile = selection.profiles.find(({ id }) => id === option.id)
    setSelection(
      pairedProfile === undefined
        ? { ...selection, modelId: option.id }
        : { ...selection, modelId: option.id, profileId: pairedProfile.id }
    )
  }
  const setProfile = (value: string): void => {
    const option = selection.profiles.find(({ id }) => id === value)
    if (option === undefined) return
    const pairedModel = selection.models.find(({ id }) => id === option.id)
    setSelection(
      pairedModel === undefined
        ? { ...selection, profileId: option.id }
        : { ...selection, modelId: pairedModel.id, profileId: option.id }
    )
  }
  const readyRegistration = registration?.status === "ready" ? registration : null

  return (
    <div
      data-relay-product-dock-chrome=""
      style={{
        insetBlockEnd: "max(var(--rly-space-16), env(safe-area-inset-bottom, 0px))",
        insetInlineEnd: "max(var(--rly-space-16), env(safe-area-inset-right, 0px))",
        position: "fixed",
        zIndex: 80
      }}
    >
      <RelayProductDockChromeBoundary>
        <Suspense fallback={null}>
          <LazyRelayDock
            context={registration?.context ?? host.context}
            defaultOpen={false}
            footer={
              readyRegistration === null ? undefined : (
                <PullRequestContinuation key={identity} registration={readyRegistration} selection={selection} />
              )
            }
            selection={{
              model: {
                onValueChange: setModel,
                options: selection.models.map(({ id, label }) => ({ label, value: id })),
                value: selection.modelId
              },
              profile: {
                onValueChange: setProfile,
                options: selection.profiles.map(({ id, label }) => ({ label, value: id })),
                value: selection.profileId
              }
            }}
            state={relayDockState(host, registration)}
          />
        </Suspense>
      </RelayProductDockChromeBoundary>
    </div>
  )
}

export {
  RelayProductDockProvider,
  RelayProductDockProviderMissing,
  useRelayProductDockRegistration,
  useRelayPullRequestDock
} from "./registry.js"
export type { RelayProductDockHost, RelayProductDockMessage, RelayPullRequestDockRegistration } from "./registry.js"

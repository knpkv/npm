import {
  RelayComposer,
  RelayLauncher,
  RelayPanel,
  RelayTranscript,
  type RlyRelayScope,
  type RlyRelayTranscriptItem,
  useRelayDraft,
  useRelayPresentation,
  useRelayShortcut,
  useRelaySummon
} from "@knpkv/rly/patterns"
import { Button, Select, StatePanel } from "@knpkv/rly/primitives"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react"
import {
  ContinuePullRequestConversationRequest,
  type PullRequestThreadIdentity,
  pullRequestThreadIdentity
} from "./conversation.js"
import { failureFromCause, HostConversationLocator, relaySelectionMatchesRegistration } from "./dock.js"
import type { RelaySelectorState } from "./model.js"
import {
  type RelayProductDockHost,
  type RelayProductDockMessage,
  type RelayPullRequestDockRegistration,
  useRelayProductDockRegistration,
  useRelayProductOpen,
  useSummonClaim
} from "./registry.js"

/**
 * The header button that opens Relay for this product: place it in the app header, before the panel.
 * It shares open state with RelayProductPanel through RelayProductDockProvider.
 */
export const RelayProductLauncher = (): ReactElement => {
  const { launcher, open, setOpen } = useRelayProductOpen()
  return (
    <RelayLauncher
      expanded={open}
      onClick={() => setOpen((current) => !current)}
      ref={launcher}
      shortcut={useRelayShortcut()}
    />
  )
}

/** Inputs for the product panel. */
export interface RelayProductPanelProps {
  readonly host: RelayProductDockHost
  /** The narrowest width this host's page stays usable at beside a pinned Relay (no default: hosts differ). */
  readonly minHostWidth: number
}

/** The scope line: the context's values (product aside), with the head as the exact revision. */
const scopeOf = (context: RelayProductDockHost["context"]): RlyRelayScope => {
  const head = context.find(({ id }) => id === "head")?.value
  const label = context
    .filter(({ id }) => id !== "head" && id !== "product")
    .map(({ value }) => value)
    .join(" ")
  const named = label === "" ? (context.find(({ id }) => id === "product")?.value ?? "Relay") : label
  return head === undefined ? { label: named } : { label: named, revision: head }
}

/** The thread's draft key: its identity's fields in sorted order, so a reordered struct is the same key. */
const threadKey = (identity: PullRequestThreadIdentity): string =>
  JSON.stringify(Object.entries(identity).sort(([left], [right]) => left.localeCompare(right)))

const itemsOf = (messages: ReadonlyArray<RelayProductDockMessage>): ReadonlyArray<RlyRelayTranscriptItem> =>
  messages.map((message): RlyRelayTranscriptItem =>
    message.role === "operator"
      ? { _tag: "You", id: message.id, text: message.text }
      : message.role === "relay"
        ? { _tag: "Relay", id: message.id, text: message.text }
        : { _tag: "Note", id: message.id, text: message.text }
  )

/**
 * Profiles and models pair one to one by id and the active pair matches: one choice sets both, so one
 * preset is offered. Anything else keeps both selects, so no active or extra model is hidden.
 */
const isCoupled = (selection: RelaySelectorState): boolean =>
  selection.profileId === selection.modelId &&
  selection.profiles.length === selection.models.length &&
  selection.profiles.every(({ id }) => selection.models.some((model) => model.id === id))

/** The selector's meaning, so an equal selector re-allocated by the host is not a change. */
const selectorRevision = (selection: RelaySelectorState): string =>
  JSON.stringify([
    selection.profileId,
    selection.modelId,
    selection.profiles.map(({ id, label }) => [id, label]),
    selection.models.map(({ id, label }) => [id, label])
  ])

const sameRun = (left: RelaySelectorState, right: RelaySelectorState): boolean =>
  left.profileId === right.profileId && left.modelId === right.modelId

let requests = 0
const newRequestId = (): string => `relay-product-${(requests += 1)}`

const rerunReason = "Rerun Relay with the selected profile or model before continuing this PR thread."

/**
 * Relay's panel for a product (Relay UX build brief, item 5), on rly's RelayPanel: a registered pull
 * request opens straight into its conversation (RelayTranscript) and composer (RelayComposer, the draft
 * keyed by the complete durable thread identity), sending through the unchanged PR contract. One preset
 * is offered where profiles and models are coupled, decided when the panel opens; a changed preset
 * applies to the next message and, while the thread still needs a rerun, the composer says why instead
 * of failing on send. A host with no registered pull request names its PR-only scope and offers the
 * locator. Mount it once per provider, after RelayProductLauncher; it owns Relay's Ctrl/⌘+J.
 */
export const RelayProductPanel = ({ host, minHostWidth }: RelayProductPanelProps): ReactElement | null => {
  const registration = useRelayProductDockRegistration()
  const { launcher, open, pinned, setOpen, setPinned } = useRelayProductOpen()
  const { canPin, presentation } = useRelayPresentation({ minHostWidth, pinned })
  useSummonClaim()
  const thread = registration === null ? null : threadKey(pullRequestThreadIdentity(registration.conversation))
  // Finding another PR ends when a different thread registers (the locator navigated there).
  const [finding, setFinding] = useState<string | null>(null)
  const locatingFrom = finding !== null && finding === thread
  const { composerRef, regionRef } = useRelaySummon({
    fullscreen: presentation === "fullscreen",
    launcher,
    onOpenChange: setOpen,
    open,
    shortcut: useRelayShortcut()
  })
  if (!open) return null
  const context = registration?.context ?? host.context
  const locating = registration === null || locatingFrom
  return (
    <RelayPanel
      launcher={launcher}
      onClose={() => setOpen(false)}
      options={
        registration === null ? undefined : (
          // Moving to another PR is a different thread; this one's draft stays keyed to it.
          <Button
            aria-pressed={locatingFrom}
            onClick={() => setFinding(locatingFrom ? null : thread)}
            type="button"
            variant="quiet"
          >
            Find another pull request
          </Button>
        )
      }
      {...(canPin ? { pin: { onPinnedChange: setPinned, pinned } } : {})}
      presentation={presentation}
      ref={regionRef}
      scope={scopeOf(context)}
      {...(registration?.status === "ready" && !locating
        ? {
            // Keyed by thread: a different PR starts with its own preset, sending and failure state.
            footer: <Continuation composerRef={composerRef} key={thread} registration={registration} />
          }
        : {})}
    >
      {locating ? (
        <>
          <p>
            {registration === null
              ? "Relay works on pull requests here. Open one, or find it:"
              : "Find another pull request. Your draft for this one is kept."}
          </p>
          <HostConversationLocator host={host} />
        </>
      ) : (
        <Body registration={registration} />
      )}
    </RelayPanel>
  )
}

const Body = ({ registration }: { readonly registration: RelayPullRequestDockRegistration }): ReactElement => {
  switch (registration.status) {
    case "loading":
      return (
        <StatePanel
          description="Loading the durable conversation for this pull request."
          icon="loader"
          title="Loading PR thread"
          tone="progress"
        />
      )
    case "error":
      return (
        <StatePanel description={registration.description} icon="alert" title="PR thread unavailable" tone="critical" />
      )
    case "unavailable":
      return (
        <StatePanel
          description={registration.description}
          icon="alert"
          title="Relay unavailable for this PR"
          tone="caution"
        />
      )
    case "ready":
      return <RelayTranscript items={itemsOf(registration.messages)} streaming={false} />
  }
}

const Continuation = ({
  composerRef,
  registration
}: {
  readonly composerRef: (element: HTMLElement | null) => void
  readonly registration: Extract<RelayPullRequestDockRegistration, { readonly status: "ready" }>
}): ReactElement => {
  const draft = useRelayDraft(threadKey(pullRequestThreadIdentity(registration.conversation)), { newRequestId })
  const [selection, setSelection] = useState(registration.selection)
  const [failure, setFailure] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  // Decided once when the panel opens, so the preset never turns into two selects mid-thread.
  const coupled = useRef(isCoupled(registration.selection)).current
  const revision = selectorRevision(registration.selection)
  // Only a selector that means something different resets a pending choice.
  useEffect(() => setSelection(registration.selection), [revision])

  // A different preset applies to the next message; a selection outside this thread's options needs a
  // rerun first, and the composer says so instead of failing on send.
  const changed = !sameRun(selection, registration.selection)
  const busyReason = sending
    ? "Relay is answering."
    : relaySelectionMatchesRegistration(selection, registration)
      ? undefined
      : rerunReason

  const send = (): void => {
    const submission = draft.submission()
    const decoded = Schema.decodeUnknownResult(ContinuePullRequestConversationRequest)({
      conversation: registration.conversation,
      message: submission.text.trim(),
      selection
    })
    if (Result.isFailure(decoded)) {
      setFailure("Enter a pull-request request of 8,000 characters or fewer.")
      return
    }
    setFailure(null)
    setSending(true)
    void Effect.runPromiseExit(registration.continuePullRequestConversation(decoded.success)).then((exit) => {
      setSending(false)
      if (Exit.isSuccess(exit)) draft.accepted(submission.requestId)
      else setFailure(`${failureFromCause(exit.cause)} Your message is kept.`)
    })
  }

  // Options carry the branded ids; a choice is taken from the option, never from the raw string.
  const chooseProfile = (id: string): void => {
    const profile = selection.profiles.find((option) => option.id === id)
    if (profile === undefined) return
    const model = coupled ? selection.models.find((option) => option.id === id) : undefined
    setSelection({ ...selection, modelId: model?.id ?? selection.modelId, profileId: profile.id })
  }
  const chooseModel = (id: string): void => {
    const model = selection.models.find((option) => option.id === id)
    if (model !== undefined) setSelection({ ...selection, modelId: model.id })
  }
  const runWith = useMemo(() => selection.profiles.map(({ id, label }) => ({ label, value: id })), [selection.profiles])
  const preset = coupled ? (
    <Select aria-label="Run with" onValueChange={chooseProfile} options={runWith} value={selection.profileId} />
  ) : (
    <>
      <Select aria-label="Profile" onValueChange={chooseProfile} options={runWith} value={selection.profileId} />
      <Select
        aria-label="Model"
        onValueChange={chooseModel}
        options={selection.models.map(({ id, label }) => ({ label, value: id }))}
        value={selection.modelId}
      />
    </>
  )
  return (
    <>
      {changed ? <p>Applies to your next message.</p> : null}
      {failure === null ? null : <p role="alert">{failure}</p>}
      <RelayComposer
        busyReason={busyReason}
        onSend={send}
        onValueChange={draft.onValueChange}
        placeholder="Ask Relay to verify one concrete part of this pull request…"
        preset={preset}
        ref={composerRef}
        value={draft.value}
      />
    </>
  )
}

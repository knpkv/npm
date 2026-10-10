/**
 * One Relay conversation in rly's panel, for any `ObjectRef`: its transcript, any confirmation cards, and a
 * composer. It has no product knowledge; the host gives it the conversation, the words and the summon refs.
 *
 * **Mental model**
 *
 * - **The host owns opening.** It runs `useRelaySummon` (and the Ctrl/⌘+J shortcut, or `null` where its own
 *   terminal owns the keys), renders this right after its launcher, and passes `regionRef` and
 *   `composerRef` through. While the panel is open its transcript announces Relay's runs; the host's own
 *   status line announces only while the panel is closed.
 * - **Busy is anything that would make Send lose the message:** no request id yet, a send in flight, a run
 *   answering, or a stream that is not live. The composer says which, and Stop cancels the run in flight.
 * - **Request ids are prepared ahead.** `useRelayDraft` asks for an id the moment Send is pressed; the panel
 *   keeps one ready from `conversations.newRequestId()`, so a browser that can't make one is said up front
 *   rather than at Send. A retried draft keeps its own id, so the server takes it once.
 * - **A stream that ended for good is said, with what to do.** Signed out shows the host's recovery copy and
 *   action beside Retry; a stream that failed offers Retry.
 *
 * @module
 */
import type { ObjectRef } from "@knpkv/relay/wire"
import { objectRefKey } from "@knpkv/relay/wire"
import {
  RelayComposer,
  RelayDecision,
  type RlyRelayDecisionCopy,
  type RlyRelayDecisionReceipt,
  type RlyRelayDecisionState,
  type RlyRelayDecisionTarget,
  RelayPanel,
  type RlyRelayPanelPin,
  type RlyRelayPanelPresentation,
  type RlyRelayScope,
  RelayTranscript,
  useRelayDraft
} from "@knpkv/rly/patterns"
import { Button, StatePanel } from "@knpkv/rly/primitives"
import * as Data from "effect/Data"
import * as Exit from "effect/Exit"
import { type ReactElement, type ReactNode, type RefCallback, type RefObject, useEffect, useRef, useState } from "react"

import type { RelayRequestFailure } from "./relay-client.js"
import type { RelayConversations } from "./relay-conversations.js"
import type { RelayConfirmationCard, RelayConversationState } from "./relay-fold.js"
import { relayTranscriptItems } from "./relay-transcript.js"
import { useRelayConversation } from "./use-relay-conversation.js"
import { useRelayStatus } from "./use-relay-status.js"

/** How the host words one confirmation: rly conjugates nothing, so the host writes every phrase. */
export interface RelayDecisionWords {
  readonly copy: RlyRelayDecisionCopy
  readonly body: string
  readonly target: readonly [RlyRelayDecisionTarget, ...ReadonlyArray<RlyRelayDecisionTarget>]
  readonly tone?: "default" | "danger"
}

export interface RelayConversationPanelProps {
  readonly conversations: RelayConversations
  /** The conversation this panel shows. */
  readonly conversation: ObjectRef
  readonly scope: RlyRelayScope
  readonly title?: string
  readonly presentation: RlyRelayPanelPresentation
  /** Where focus returns when the panel closes: the launcher that opened it. */
  readonly launcher: RefObject<HTMLElement | null>
  readonly onClose: () => void
  /** From the host's `useRelaySummon`. */
  readonly regionRef: RefCallback<HTMLElement>
  readonly composerRef: RefCallback<HTMLElement>
  readonly pin?: RlyRelayPanelPin
  readonly placeholder: string
  /** What signed out means here, and how to sign back in (a link or button), shown with Retry. */
  readonly signedOut: { readonly description: string; readonly action?: ReactNode }
  /** Words for a confirmation card. Without it, a card says this page can't confirm it. */
  readonly decision?: (card: RelayConfirmationCard) => RelayDecisionWords
}

/** Send ran for a new draft before a request id was ready; the busy state makes this unreachable. */
export class RequestIdNotReady extends Data.TaggedError("RequestIdNotReady")<{}> {}

/** A request id kept ready for the next Send, or why there is none. */
type PreparedId =
  { readonly _tag: "Preparing" } | { readonly _tag: "Ready"; readonly id: string } | { readonly _tag: "Unavailable" }

/** Keeps one request id ready from `conversations.newRequestId()`; `take` hands it over and prepares the next. */
const usePreparedRequestId = (conversations: RelayConversations) => {
  const [prepared, setPrepared] = useState<PreparedId>({ _tag: "Preparing" })
  useEffect(() => {
    if (prepared._tag !== "Preparing") return
    let current = true
    void conversations.newRequestId().then((exit) => {
      if (current) setPrepared(Exit.isSuccess(exit) ? { _tag: "Ready", id: exit.value } : { _tag: "Unavailable" })
    })
    return () => {
      current = false
    }
  }, [conversations, prepared._tag])
  const latest = useRef(prepared)
  latest.current = prepared
  /** The ready id, for a draft that has none; Send is busy until there is one, so it never runs without. */
  const take = (): string => {
    const now = latest.current
    if (now._tag !== "Ready") throw new RequestIdNotReady()
    setPrepared({ _tag: "Preparing" })
    return now.id
  }
  return { prepared, take }
}

const decisionState = (card: RelayConfirmationCard, state: RelayConversationState): RlyRelayDecisionState => {
  const row = state.tools.find(({ call }) => call === card.call)
  switch (card.decision) {
    case "pending":
      return { _tag: "Pending" }
    case "declined":
      return { _tag: "Declined" }
    case "expired":
      return { _tag: "Expired" }
    case "confirmed":
      if (row?.state === "ok" && row.receipt !== null) {
        const { link, summary } = row.receipt
        const receipt: RlyRelayDecisionReceipt = link === undefined ? { summary } : { href: link, summary }
        return { _tag: "Done", receipt }
      }
      return row?.state === "failed" ? { _tag: "Failed", cause: row.summary } : { _tag: "Confirmed" }
  }
}

/** What a refused request means, in the server's own words where it gave them. */
const refusalText = (failure: RelayRequestFailure): string => {
  switch (failure._tag) {
    case "RelayUnavailableError":
      return `${failure.message} ${failure.fix}`
    case "RelayBadRequestError":
      return failure.message
    case "RelayConflictError":
      return "Relay is busy with another request."
    case "RelayUnauthorized":
      return "Your session no longer opens Relay here."
    case "RelayTransportFailed":
      return failure.reason === "unreachable" ? "The server didn't answer." : "The server's answer couldn't be read."
  }
}

/** A request that stopped without the server's answer (interrupted, or a defect on this page). */
const stoppedText = "The request stopped before Relay answered."

/** The typed failure in an exit, if it failed with one. */
const failureOf = <E,>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const reason = exit.cause.reasons.find((candidate) => candidate._tag === "Fail")
  return reason !== undefined && reason._tag === "Fail" ? reason.error : undefined
}

/** Why Send would lose the message right now, or undefined when it wouldn't. */
const busyReasonOf = (
  state: RelayConversationState,
  prepared: PreparedId,
  sending: boolean,
  needsId: boolean
): string | undefined => {
  if (state.connection !== "live") return "Relay is reconnecting."
  if (needsId && prepared._tag === "Unavailable") return "This browser can't make request ids, so Relay can't send."
  if (needsId && prepared._tag === "Preparing") return "Getting ready to send…"
  if (sending) return "Sending…"
  if (state.runIds.length > 0) return "Relay is answering."
  return undefined
}

/** One conversation in Relay's panel. Render it right after the host's launcher, only while open. */
export const RelayConversationPanel = (props: RelayConversationPanelProps): ReactElement => {
  const { conversation, conversations } = props
  const state = useRelayConversation(conversations, conversation)
  const status = useRelayStatus(conversations, conversation, true)
  const { prepared, take } = usePreparedRequestId(conversations)
  const draft = useRelayDraft(objectRefKey(conversation), { newRequestId: take })
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  // A refused draft keeps its request id until it is edited: sending it again then needs no new one. Any
  // edit drops the id (useRelayDraft starts a new request), so it drops this too.
  // Edits are counted, so a refusal that lands after an edit made during the send doesn't make the edited
  // draft retryable: that edit already dropped its id.
  const [retryable, setRetryable] = useState(false)
  const edits = useRef(0)
  const needsId = !retryable
  const edit = (text: string): void => {
    if (text !== draft.value) {
      edits.current += 1
      setRetryable(false)
    }
    draft.onValueChange(text)
  }
  // Per confirmation card: a failed answer remounts it, so it can be answered again, and says why; a 409
  // shows the state the server found.
  const [attempts, setAttempts] = useState<Readonly<Record<string, number>>>({})
  const [decisionNotes, setDecisionNotes] = useState<Readonly<Record<string, string>>>({})
  const [found, setFound] = useState<Readonly<Record<string, RlyRelayDecisionState>>>({})

  const send = (): void => {
    const submission = draft.submission()
    const editsAtSend = edits.current
    setSending(true)
    setRefusal(null)
    void conversations.send(conversation, submission).then((exit) => {
      setSending(false)
      if (Exit.isSuccess(exit)) {
        draft.accepted(submission.requestId)
        setRetryable(false)
        return
      }
      // Refused, or stopped without an answer: either way the message and its id are kept for a retry.
      const failure = failureOf(exit)
      setRetryable(edits.current === editsAtSend)
      setRefusal(
        `${failure === undefined ? stoppedText : refusalText(failure)} Your message is kept; send it again to retry.`
      )
    })
  }

  const answer = (card: RelayConfirmationCard, allow: boolean): void => {
    void conversations.decide(conversation, card.call, allow).then((exit) => {
      if (Exit.isSuccess(exit)) return
      const failure = failureOf(exit)
      if (failure?._tag === "RelayConflictError") {
        const state = failure.state
        const shown: RlyRelayDecisionState =
          state._tag === "Decided" ? (state.allow ? { _tag: "Confirmed" } : { _tag: "Declined" }) : { _tag: "Expired" }
        setFound((current) => ({ ...current, [card.call]: shown }))
        return
      }
      const why = failure === undefined ? stoppedText : refusalText(failure)
      setDecisionNotes((current) => ({ ...current, [card.call]: `${why} Answer again.` }))
      setAttempts((current) => ({ ...current, [card.call]: (current[card.call] ?? 0) + 1 }))
    })
  }
  const runId = state.runIds[0]
  const ended = state.connection === "unauthorized" || state.connection === "failed"

  const body =
    state.connection === "unauthorized" ? (
      <StatePanel
        action={
          <>
            {props.signedOut.action}
            <Button onClick={() => conversations.retry(conversation)} type="button" variant="secondary">
              Retry
            </Button>
          </>
        }
        description={props.signedOut.description}
        title="Sign in again to use Relay"
      />
    ) : state.connection === "failed" ? (
      <StatePanel
        action={
          <Button onClick={() => conversations.retry(conversation)} type="button" variant="secondary">
            Retry
          </Button>
        }
        description="Relay's stream stopped on something it couldn't read."
        title="Relay stopped"
        tone="critical"
      />
    ) : (
      <>
        <RelayTranscript items={relayTranscriptItems(state)} streaming={state.runIds.length > 0} />
        {state.confirmations.map((card) => {
          const words = props.decision?.(card)
          return words === undefined ? (
            card.decision === "pending" ? (
              <p key={card.call}>Relay asks to {card.action.verb}. This page can't confirm it.</p>
            ) : null
          ) : (
            <div key={card.call}>
              {decisionNotes[card.call] === undefined ? null : <p role="alert">{decisionNotes[card.call]}</p>}
              <RelayDecision
                body={words.body}
                copy={words.copy}
                id={card.call}
                key={`${card.call}:${String(attempts[card.call] ?? 0)}`}
                onConfirm={() => answer(card, true)}
                onDecline={() => answer(card, false)}
                state={
                  card.decision === "pending" ? (found[card.call] ?? { _tag: "Pending" }) : decisionState(card, state)
                }
                target={words.target}
                {...(words.tone === undefined ? {} : { tone: words.tone })}
              />
            </div>
          )
        })}
      </>
    )

  return (
    <RelayPanel
      activity={status.activity}
      {...(state.connection === "disconnected" ? { freshness: "Reconnecting…" } : {})}
      {...(ended
        ? {}
        : {
            footer: (
              <>
                {state.backend?._tag === "Unavailable" ? (
                  <p role="status">
                    {state.backend.label} can't answer: {state.backend.fix}
                  </p>
                ) : null}
                {refusal === null ? null : <p role="alert">{refusal}</p>}
                <RelayComposer
                  busyReason={busyReasonOf(state, prepared, sending, needsId)}
                  onSend={send}
                  {...(runId === undefined ? {} : { onStop: () => void conversations.cancel(conversation, runId) })}
                  onValueChange={edit}
                  placeholder={props.placeholder}
                  ref={props.composerRef}
                  value={draft.value}
                />
              </>
            )
          })}
      launcher={props.launcher}
      onClose={props.onClose}
      {...(props.pin === undefined ? {} : { pin: props.pin })}
      presentation={props.presentation}
      ref={props.regionRef}
      scope={props.scope}
      {...(props.title === undefined ? {} : { title: props.title })}
    >
      {body}
    </RelayPanel>
  )
}

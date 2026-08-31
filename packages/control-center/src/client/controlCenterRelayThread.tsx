import {
  PullRequestConversationContinuationFailed,
  PullRequestConversationContinuationRejected,
  type ContinuePullRequestConversationRequest,
  type PullRequestConversation,
  pullRequestThreadIdentity,
  type RelayProductDockMessage,
  type RelayPullRequestDockRegistration,
  useRelayPullRequestDock
} from "@knpkv/relay-product"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { useMemo } from "react"

import { DurableAgentPrompt, type DurableAgentProviderId, type PullRequestReviewThreadEvent } from "../api/agent.js"
import type { WorkspaceEntityInspection } from "../api/deliveryGraph.js"
import type { EntityId, WorkspaceId } from "../domain/identifiers.js"
import {
  controlCenterRelayHostSelection,
  decodeControlCenterRelayConversation,
  decodeControlCenterRelaySelector
} from "./controlCenterRelayDock.js"
import type { PullRequestReviewControllerState } from "./entities/usePullRequestReview.js"
import { workspaceEntityPath } from "./workspaceEntityPaths.js"

const eventMessage = (event: PullRequestReviewThreadEvent): RelayProductDockMessage | null => {
  switch (event._tag) {
    case "operator-message":
      return { id: String(event.eventSequence), role: "operator", text: event.prompt }
    case "progress":
      return { id: String(event.eventSequence), role: "relay", text: event.text }
    case "review-report":
      return {
        id: String(event.eventSequence),
        role: "relay",
        text: `${String(event.report.suggestions.length)} suggestions · ${String(event.report.notes.length)} notes`
      }
    case "run-failed":
      return { id: String(event.eventSequence), role: "system", text: `Review failed at ${event.stage}.` }
    case "run-completed":
      return { id: String(event.eventSequence), role: "system", text: `Review completed · ${event.outcome}` }
    case "run-interrupted":
      return { id: String(event.eventSequence), role: "system", text: "Review interrupted by a restart." }
    case "cancellation-requested":
      return { id: String(event.eventSequence), role: "system", text: "Cancellation requested." }
    case "run-queued":
    case "run-started":
    case "suggestion-published":
    case "suggestion-revised":
    case "usage":
      return null
  }
}

const relayMessages = (state: PullRequestReviewControllerState): ReadonlyArray<RelayProductDockMessage> =>
  state._tag === "ready" && state.thread !== undefined
    ? state.thread.events.flatMap((event) => {
        const message = eventMessage(event)
        return message === null ? [] : [message]
      })
    : []

type ReviewProviderSelection = NonNullable<
  Extract<PullRequestReviewControllerState, { readonly _tag: "ready" }>["provider"]
>

const providerPresets = (state: PullRequestReviewControllerState): ReadonlyArray<ReviewProviderSelection> =>
  state._tag === "ready" ? (state.providerPresets ?? (state.provider === null ? [] : [state.provider])) : []

interface ControlCenterRelayContinuationInput {
  readonly conversation: PullRequestConversation
  readonly providerId: typeof DurableAgentProviderId.Type
  readonly request: ContinuePullRequestConversationRequest
  readonly startReview: (
    prompt?: typeof DurableAgentPrompt.Type,
    providerId?: typeof DurableAgentProviderId.Type
  ) => Promise<void>
}

/** Await the durable enqueue so the shared dock can retain input on transport failure. */
export const continueControlCenterRelayConversation = ({
  conversation,
  providerId,
  request,
  startReview
}: ControlCenterRelayContinuationInput): Effect.Effect<void, PullRequestConversationContinuationFailed> => {
  const thread = pullRequestThreadIdentity(conversation)
  const prompt = Schema.decodeUnknownResult(DurableAgentPrompt)(request.message)
  if (Result.isFailure(prompt)) {
    return Effect.fail(
      new PullRequestConversationContinuationFailed({
        product: "control-center",
        thread
      })
    )
  }
  return Effect.tryPromise({
    try: () => startReview(prompt.success, providerId),
    catch: (): PullRequestConversationContinuationFailed =>
      new PullRequestConversationContinuationFailed({ product: "control-center", thread })
  })
}

const selectorFor = (state: PullRequestReviewControllerState) => {
  const presets = providerPresets(state)
  const selected = state._tag === "ready" ? state.provider : null
  return presets.length === 0 || selected === null
    ? controlCenterRelayHostSelection
    : decodeControlCenterRelaySelector({
        modelId: selected.providerId,
        models: presets.map(({ model, providerId }) => ({ id: providerId, label: `${providerId} · ${model}` })),
        profileId: selected.providerId,
        profiles: presets.map(({ providerId, reviewProfile }) => ({
          id: providerId,
          label: reviewProfile.label
        }))
      })
}

interface ControlCenterRelayThreadProps {
  readonly canEnqueue: boolean
  readonly entityId: EntityId
  readonly inspection: WorkspaceEntityInspection
  readonly reviewState: PullRequestReviewControllerState
  readonly startReview: (
    prompt?: typeof DurableAgentPrompt.Type,
    providerId?: ReviewProviderSelection["providerId"]
  ) => Promise<void>
  readonly workspaceId: WorkspaceId
}

/** Register Control Center's existing durable PR event log with the shared shell dock. */
export const ControlCenterRelayThread = ({
  canEnqueue,
  entityId,
  inspection,
  reviewState,
  startReview,
  workspaceId
}: ControlCenterRelayThreadProps): null => {
  const details = inspection.entity.projection.details
  const selection = useMemo(() => selectorFor(reviewState), [reviewState])
  const conversation = useMemo(
    () =>
      decodeControlCenterRelayConversation({
        _tag: "control-center",
        route: { entityId, href: workspaceEntityPath(workspaceId, entityId) },
        selection,
        thread: {
          pluginConnectionId: inspection.source.pluginConnectionId,
          pullRequestId: inspection.source.vendorImmutableId,
          repositoryName: details._tag === "pull-request" ? details.repository : "unavailable",
          workspaceId
        }
      }),
    [
      details,
      entityId,
      inspection.source.pluginConnectionId,
      inspection.source.vendorImmutableId,
      selection,
      workspaceId
    ]
  )
  const registration = useMemo<RelayPullRequestDockRegistration>(() => {
    const base = {
      context: [
        {
          id: "repository",
          label: "Repository",
          value: details._tag === "pull-request" ? details.repository : "Unavailable"
        },
        { id: "pull-request", label: "Pull request", value: `#${inspection.source.vendorImmutableId}` },
        {
          id: "head",
          label: "Current head",
          value: details._tag === "pull-request" ? details.headRevision.slice(0, 12) : "Unavailable"
        }
      ],
      conversation,
      selection
    }
    if (reviewState._tag === "idle" || reviewState._tag === "loading") return { ...base, status: "loading" }
    if (reviewState._tag === "failed") {
      return { ...base, description: "Control Center could not load this durable PR thread.", status: "error" }
    }
    const presets = providerPresets(reviewState)
    if (!canEnqueue || reviewState.provider === null || reviewState.review._tag === "unavailable") {
      return {
        ...base,
        description: canEnqueue
          ? "No available PR-review agent profile is configured."
          : "A workspace owner session is required to continue this PR thread.",
        status: "unavailable"
      }
    }
    return {
      ...base,
      continuePullRequestConversation: (request) => {
        const thread = pullRequestThreadIdentity(conversation)
        if (reviewState.action === "starting" || reviewState.review._tag === "pending") {
          return new PullRequestConversationContinuationRejected({
            product: "control-center",
            reason: "conversation-busy",
            thread
          })
        }
        const selected = presets.find(
          ({ providerId }) =>
            String(providerId) === String(request.selection.modelId) &&
            String(providerId) === String(request.selection.profileId)
        )
        if (selected === undefined) {
          return new PullRequestConversationContinuationRejected({
            product: "control-center",
            reason: "selection-unavailable",
            thread
          })
        }
        return continueControlCenterRelayConversation({
          conversation,
          providerId: selected.providerId,
          request,
          startReview
        })
      },
      messages: relayMessages(reviewState),
      status: "ready"
    }
  }, [canEnqueue, conversation, details, inspection.source.vendorImmutableId, reviewState, selection, startReview])
  useRelayPullRequestDock(registration)
  return null
}

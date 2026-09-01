// @vitest-environment happy-dom

import { type ReactElement, act, useLayoutEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Data from "effect/Data"
import * as Schema from "effect/Schema"

import {
  type AgentProviderCatalog,
  AgentModelId,
  DurableAgentPrompt,
  DurableAgentProviderId,
  PublishedReviewComment,
  PullRequestReviewNotStarted,
  PullRequestReviewPending,
  PullRequestReviewState,
  type PullRequestReviewThreadEvent,
  PullRequestReviewThreadPage,
  ReleaseAgentThreadCursor,
  type ReviewAgentProfile,
  ReviewAgentProfileId,
  ReviewSuggestionPublicationAuthorityBinding,
  ReviewSuggestionPublicationContent,
  ReviewSuggestionPublicationPreview
} from "../../src/api/agent.js"
import {
  continuePullRequestReviewThread,
  installNewestThread,
  loadCompletePullRequestReviewThread,
  loadEarlierPullRequestReviewThread,
  MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS,
  MAXIMUM_REVIEW_THREAD_PAGE_READS,
  mergePullRequestReviewThreads,
  type PullRequestReviewThread
} from "../../src/client/entities/pullRequestReviewThreadReplay.js"
import {
  observePullRequestReviewHistoryLoad,
  publishNewestPullRequestReviewThread,
  PullRequestReviewRequestAborted,
  type PullRequestReviewControllerState,
  type PullRequestReviewTransport,
  usePullRequestReview
} from "../../src/client/entities/usePullRequestReview.js"
import {
  EntityId,
  GovernedActionId,
  JobId,
  PersonId,
  PrReviewSuggestionRevisionId
} from "../../src/domain/identifiers.js"
import { PrReviewPath, PrReviewSubject, PrReviewSuggestionId } from "../../src/domain/prReview.js"
import { PrReviewSuggestionRevisionSequence } from "../../src/domain/prReviewRevision.js"
import { PluginProviderOperationId, PluginProviderReceiptV1 } from "../../src/domain/plugins/actions.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

interface PullRequestReviewThreadRef {
  current: PullRequestReviewThread | null
}

const ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000601")
const OTHER_ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000699")
const BASE_A = "0".repeat(40)
const BASE_B = "1".repeat(40)
const HEAD_A = "a".repeat(40)
const HEAD_B = "b".repeat(40)
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000602")
const SUGGESTION_ID = PrReviewSuggestionId.make(`sha256:${"7".repeat(64)}`)
const REVIEW_REVISION_ID = PrReviewSuggestionRevisionId.make(`sha256:${"9".repeat(64)}`)
const REVIEW_REVISION_SEQUENCE = PrReviewSuggestionRevisionSequence.make(1)
const WRONG_SUGGESTION_ID = PrReviewSuggestionId.make(`sha256:${"8".repeat(64)}`)
const OPERATOR_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000603")
const REVIEW_PROFILE: ReviewAgentProfile = {
  profileId: ReviewAgentProfileId.make("openai-compatible:review-model:sbx"),
  label: "Full-project review · openai-compatible · review-model",
  budgetMillis: 1_200_000,
  networkAccess: "blocked",
  sandbox: "sbx"
}
const CLAUDE_REVIEW_PROFILE: ReviewAgentProfile = {
  profileId: ReviewAgentProfileId.make("claude:default:sbx"),
  label: "Full-project review · claude · default",
  budgetMillis: 1_200_000,
  networkAccess: "provider-enabled",
  sandbox: "sbx"
}
const TARGETED_PROMPT = DurableAgentPrompt.make("Re-check transaction ownership.")
const EMPTY_THREAD = PullRequestReviewThreadPage.make({
  events: [],
  hasMore: false,
  nextCursor: ReleaseAgentThreadCursor.make(0)
})

class LateEnqueueFailure extends Data.TaggedError("LateEnqueueFailure")<{}> {}
class UnexpectedPreview extends Data.TaggedError("UnexpectedPreview")<{}> {}
class UnexpectedPublish extends Data.TaggedError("UnexpectedPublish")<{}> {}

const threadEvent = (sequence: number): PullRequestReviewThreadEvent => ({
  _tag: "operator-message",
  eventSequence: ReleaseAgentThreadCursor.make(sequence),
  jobId: JOB_ID,
  occurredAt: Schema.decodeSync(Schema.DateTimeUtcFromString)("2026-07-24T15:00:00.000Z"),
  prompt: TARGETED_PROMPT
})

const reviewFor = (baseRevision: string, headRevision: string): PullRequestReviewState =>
  new PullRequestReviewNotStarted({
    subject: PrReviewSubject.make({
      providerId: "codecommit",
      repository: "control-center",
      pullRequestId: "212",
      baseRevision,
      headRevision
    })
  })

const completedReviewFor = (baseRevision: string, headRevision: string): PullRequestReviewState =>
  Schema.decodeUnknownSync(PullRequestReviewState)({
    _tag: "completed",
    subject: {
      providerId: "codecommit",
      repository: "control-center",
      pullRequestId: "212",
      baseRevision,
      headRevision
    },
    jobId: JOB_ID,
    providerId: "openai-compatible",
    model: "review-model",
    reviewProfile: REVIEW_PROFILE,
    activity: { events: [], truncated: false },
    requestedAt: "2026-07-24T15:00:00.000Z",
    completedAt: "2026-07-24T15:04:00.000Z",
    outcome: "changes-required",
    report: {
      schemaVersion: 3,
      subject: {
        providerId: "codecommit",
        repository: "control-center",
        pullRequestId: "212",
        baseRevision,
        headRevision
      },
      completion: { status: "complete" },
      suggestions: [
        {
          suggestionId: SUGGESTION_ID,
          state: "draft",
          title: "Authorize before mutating",
          severity: "P1",
          problem: "Mutation happens before authorization",
          impact: "An unauthorized caller can mutate durable state.",
          evidence: {
            path: "src/authorization.ts",
            startLine: 42,
            endLine: 42,
            excerpt: "yield* mutate()"
          },
          recommendation: "Authorize first.",
          anchor: {
            _tag: "line",
            path: "src/authorization.ts",
            line: 42
          },
          relatedLocations: [],
          confidence: {
            level: "high",
            reason: "The execution order is explicit."
          }
        }
      ],
      notes: []
    }
  })

const pendingReviewFor = (baseRevision: string, headRevision: string): PullRequestReviewState =>
  new PullRequestReviewPending({
    subject: PrReviewSubject.make({
      providerId: "codecommit",
      repository: "control-center",
      pullRequestId: "212",
      baseRevision,
      headRevision
    }),
    jobId: JOB_ID,
    providerId: DurableAgentProviderId.make("openai-compatible"),
    model: AgentModelId.make("review-model"),
    reviewProfile: REVIEW_PROFILE,
    activity: { events: [], truncated: false },
    requestedAt: Schema.decodeSync(Schema.DateTimeUtcFromString)("2026-07-24T15:00:00.000Z"),
    state: "running"
  })

const deferred = <Value,>() => {
  let resolveValue: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve
  })
  return {
    promise,
    resolve: (value: Value): void => {
      if (resolveValue === undefined) throw new Error("Deferred resolution unavailable")
      resolveValue(value)
    }
  }
}

const makePublicationFixture = (reviewedHead: string) => {
  const footer = `— ${REVIEW_PROFILE.label} · head ${HEAD_A.slice(0, 12)} · operator ${OPERATOR_ID}`
  const editableContent = ReviewSuggestionPublicationContent.make("Authorize before mutating.")
  const finalContent = ReviewSuggestionPublicationContent.make(`${editableContent}\n\n${footer}`)
  const preview = new ReviewSuggestionPublicationPreview({
    jobId: JOB_ID,
    suggestionId: SUGGESTION_ID,
    revisionId: REVIEW_REVISION_ID,
    subject: PrReviewSubject.make({
      providerId: "codecommit",
      repository: "control-center",
      pullRequestId: "212",
      baseRevision: BASE_A,
      headRevision: HEAD_A
    }),
    suggestionRevision: {
      jobId: JOB_ID,
      suggestionId: SUGGESTION_ID,
      revisionId: REVIEW_REVISION_ID,
      sequence: REVIEW_REVISION_SEQUENCE,
      reviewedHead: HEAD_A
    },
    anchor: {
      _tag: "line",
      path: PrReviewPath.make("src/authorization.ts"),
      line: 42,
      relativeFileVersion: "AFTER"
    },
    editableContent,
    editableContentMaximumLength: 10_100 - footer.length - 2,
    finalContent,
    publicationFooter: footer,
    replacement: null,
    connectedIdentity: {
      accountId: "123456789012",
      arn: "arn:aws:iam::123456789012:user/local-operator"
    },
    authorityBinding: ReviewSuggestionPublicationAuthorityBinding.make(`sha256:${"a".repeat(64)}`),
    proposingAgent: REVIEW_PROFILE,
    publishingOperator: OPERATOR_ID
  })
  const receipt = Schema.decodeUnknownSync(PluginProviderReceiptV1)({
    providerOperationId: PluginProviderOperationId.make("comment-42"),
    status: "succeeded",
    safeSummary: "Posted an inline pull-request comment",
    observedAt: "2026-07-24T15:05:00.000Z"
  })
  const published = new PublishedReviewComment({
    publicationId: GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-000000000604"),
    jobId: JOB_ID,
    suggestionId: SUGGESTION_ID,
    revisionId: REVIEW_REVISION_ID,
    subject: preview.subject,
    suggestionRevision: {
      ...preview.suggestionRevision,
      reviewedHead
    },
    anchor: preview.anchor,
    content: finalContent,
    connectedIdentity: preview.connectedIdentity,
    proposingAgent: REVIEW_PROFILE,
    publishingOperator: OPERATOR_ID,
    receipt,
    publishedAt: receipt.observedAt
  })
  return { preview, published }
}

let mountedRoot: Root | undefined
const ignoreSessionExpired = (): void => undefined

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
})

const Harness = ({
  baseRevision = BASE_A,
  headRevision,
  transport
}: {
  readonly baseRevision?: string | null
  readonly headRevision: string
  readonly transport: PullRequestReviewTransport
}): ReactElement => {
  const controller = usePullRequestReview(
    ENTITY_ID,
    baseRevision,
    headRevision,
    "session-a",
    false,
    ignoreSessionExpired,
    transport
  )
  return (
    <span>
      {controller.state._tag === "ready"
        ? `${controller.state.review._tag}:${controller.state.baseRevision}:${controller.state.headRevision}`
        : controller.state._tag}
    </span>
  )
}

const PublicationHarness = ({
  headRevision,
  onRevisionCommit,
  transport
}: {
  readonly headRevision: string
  readonly onRevisionCommit?: ((headRevision: string) => void) | undefined
  readonly transport: PullRequestReviewTransport
}): ReactElement => {
  const controller = usePullRequestReview(
    ENTITY_ID,
    BASE_A,
    headRevision,
    "session-a",
    false,
    ignoreSessionExpired,
    transport
  )
  useLayoutEffect(() => {
    onRevisionCommit?.(headRevision)
  }, [headRevision, onRevisionCommit])
  return (
    <>
      <span data-head={headRevision} data-publication>
        {controller.publication._tag}
        {controller.publication._tag === "published"
          ? `:${controller.publication.headSuperseded ? "superseded" : "current"}:${controller.publication.publication.receipt.providerOperationId}`
          : controller.publication._tag === "receipt-conflict"
            ? `:${controller.publication.publication.receipt.providerOperationId}`
            : ""}
      </span>
      <span data-suggestion-state>
        {controller.state._tag === "ready" && controller.state.review._tag === "completed"
          ? controller.state.review.report.suggestions[0]?.state
          : ""}
      </span>
      <span data-thread>
        {controller.state._tag === "ready"
          ? String(controller.state.thread?.events.length ?? 0)
          : controller.state._tag}
      </span>
      <button
        data-preview
        onClick={() =>
          controller.previewPublication({
            jobId: JOB_ID,
            revisionId: REVIEW_REVISION_ID,
            suggestionId: SUGGESTION_ID
          })
        }
      />
      <button
        data-preview-wrong
        onClick={() =>
          controller.previewPublication({
            jobId: JOB_ID,
            revisionId: REVIEW_REVISION_ID,
            suggestionId: WRONG_SUGGESTION_ID
          })
        }
      />
      <button
        data-publish
        onClick={() => controller.publishSuggestion(ReviewSuggestionPublicationContent.make("Confirmed content."))}
      />
      <button data-retry onClick={controller.retry} />
    </>
  )
}

const ReviewThreadHarness = ({
  entityId = ENTITY_ID,
  headRevision = HEAD_A,
  onSessionExpired = ignoreSessionExpired,
  providerId,
  sessionKey = "session-a",
  transport
}: {
  readonly entityId?: EntityId
  readonly headRevision?: string
  readonly onSessionExpired?: (sessionKey: string) => void
  readonly providerId?: DurableAgentProviderId
  readonly sessionKey?: string
  readonly transport: PullRequestReviewTransport
}): ReactElement => {
  const controller = usePullRequestReview(entityId, BASE_A, headRevision, sessionKey, true, onSessionExpired, transport)
  return (
    <>
      <span data-history>
        {controller.state._tag === "ready" ? controller.state.historyAction : controller.state._tag}
      </span>
      <span data-thread>
        {controller.state._tag === "ready"
          ? String(controller.state.thread?.events.length ?? 0)
          : controller.state._tag}
      </span>
      <span data-thread-history-loaded>
        {controller.state._tag === "ready"
          ? String(controller.state.thread?.historyLoaded ?? false)
          : controller.state._tag}
      </span>
      <span data-thread-sequences>
        {controller.state._tag === "ready"
          ? (controller.state.thread?.events.map(({ eventSequence }) => eventSequence).join(",") ?? "")
          : controller.state._tag}
      </span>
      <button data-load-earlier onClick={controller.loadEarlier} />
      <button data-start onClick={() => controller.start(TARGETED_PROMPT, providerId)} />
    </>
  )
}

const AwaitableStartHarness = ({
  onFailure,
  transport
}: {
  readonly onFailure: (failure: PullRequestReviewRequestAborted) => void
  readonly transport: PullRequestReviewTransport
}): ReactElement => {
  const controller = usePullRequestReview(ENTITY_ID, BASE_A, HEAD_A, "session-a", true, ignoreSessionExpired, transport)
  return (
    <>
      <span data-start-state>{controller.state._tag}</span>
      <button data-start-awaitable onClick={() => void controller.startAwaitable(TARGETED_PROMPT).catch(onFailure)} />
    </>
  )
}

describe("usePullRequestReview", () => {
  it("retains only the newest durable thread events across repeated refreshes", async () => {
    const signal = new AbortController().signal
    let firstSequence = 1
    const transport = {
      loadThread: vi.fn(() => {
        const events = Array.from({ length: 128 }, (_, index) => threadEvent(firstSequence + index))
        firstSequence += events.length
        return Promise.resolve(
          PullRequestReviewThreadPage.make({
            events,
            hasMore: false,
            nextCursor: events.at(-1)?.eventSequence ?? ReleaseAgentThreadCursor.make(0)
          })
        )
      })
    }

    let thread = await continuePullRequestReviewThread(transport, ENTITY_ID, signal)
    thread = await continuePullRequestReviewThread(transport, ENTITY_ID, signal, thread)
    thread = await continuePullRequestReviewThread(transport, ENTITY_ID, signal, thread)

    expect(thread.events).toHaveLength(MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS)
    expect(thread.events[0]?.eventSequence).toBe(ReleaseAgentThreadCursor.make(129))
    expect(thread.events.at(-1)?.eventSequence).toBe(ReleaseAgentThreadCursor.make(384))
    expect(thread.nextCursor).toBe(ReleaseAgentThreadCursor.make(384))
  })

  it("re-enables explicit history when live replay later truncates a thread opened empty", async () => {
    const pageSize = MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS / 2
    const pages = [
      PullRequestReviewThreadPage.make({
        events: [],
        hasMore: false,
        nextCursor: ReleaseAgentThreadCursor.make(0)
      }),
      PullRequestReviewThreadPage.make({
        events: Array.from({ length: pageSize }, (_, index) => threadEvent(index + 1)),
        hasMore: false,
        nextCursor: ReleaseAgentThreadCursor.make(pageSize)
      }),
      PullRequestReviewThreadPage.make({
        events: Array.from({ length: pageSize }, (_, index) => threadEvent(index + pageSize + 1)),
        hasMore: false,
        nextCursor: ReleaseAgentThreadCursor.make(MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS)
      }),
      PullRequestReviewThreadPage.make({
        events: [threadEvent(MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS + 1)],
        hasMore: false,
        nextCursor: ReleaseAgentThreadCursor.make(MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS + 1)
      })
    ]
    const transport = {
      loadThread: vi.fn(() => Promise.resolve(pages.shift() ?? EMPTY_THREAD))
    }
    const signal = new AbortController().signal

    let thread = await continuePullRequestReviewThread(transport, ENTITY_ID, signal)
    expect(thread.hasEarlier).toBe(false)
    thread = await continuePullRequestReviewThread(transport, ENTITY_ID, signal, thread)
    expect(thread.hasEarlier).toBe(false)
    thread = await continuePullRequestReviewThread(transport, ENTITY_ID, signal, thread)
    expect(thread.hasEarlier).toBe(false)
    thread = await continuePullRequestReviewThread(transport, ENTITY_ID, signal, thread)

    expect(thread.events).toHaveLength(MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS)
    expect(thread.events[0]?.eventSequence).toBe(ReleaseAgentThreadCursor.make(2))
    expect(thread.hasEarlier).toBe(true)
  })

  it("does not expose earlier history for a complete non-empty initial replay", async () => {
    const transport = {
      loadThread: vi.fn(() =>
        Promise.resolve(
          PullRequestReviewThreadPage.make({
            events: Array.from({ length: 13 }, (_, index) => threadEvent(index + 1)),
            hasMore: false,
            nextCursor: ReleaseAgentThreadCursor.make(13)
          })
        )
      )
    }

    const thread = await continuePullRequestReviewThread(transport, ENTITY_ID, new AbortController().signal)

    expect(thread.hasEarlier).toBe(false)
    expect(thread.events).toHaveLength(13)
  })

  it("opens a bounded tail with earlier history without walking its cursor forward", async () => {
    const transport = {
      loadThread: vi.fn(() =>
        Promise.resolve(
          PullRequestReviewThreadPage.make({
            events: [threadEvent(129)],
            hasEarlier: true,
            hasMore: false,
            nextCursor: ReleaseAgentThreadCursor.make(129)
          })
        )
      )
    }

    const thread = await loadCompletePullRequestReviewThread(transport, ENTITY_ID, new AbortController().signal)

    expect(thread.hasEarlier).toBe(true)
    expect(transport.loadThread).toHaveBeenCalledOnce()
    expect(transport.loadThread).toHaveBeenCalledWith(ENTITY_ID, null, expect.any(AbortSignal))
  })

  it("makes a rejected lazy history boundary retryable", async () => {
    const current = {
      _tag: "ready",
      action: "idle",
      baseRevision: BASE_A,
      entityId: ENTITY_ID,
      headRevision: HEAD_A,
      historyAction: "loading",
      provider: null,
      review: reviewFor(BASE_A, HEAD_A),
      sessionKey: "session-a"
    } satisfies PullRequestReviewControllerState
    let state: PullRequestReviewControllerState = current

    observePullRequestReviewHistoryLoad(
      Promise.reject(new Error("browser chunk unavailable")),
      new AbortController().signal,
      current,
      { current },
      (update) => {
        state = update(state)
      }
    )

    await vi.waitFor(() => {
      expect(state._tag === "ready" ? state.historyAction : state._tag).toBe("failed")
    })
  })

  it.each(["history-first", "live-first"] satisfies ReadonlyArray<"history-first" | "live-first">)(
    "merges concurrent backward and live reads when %s resolves",
    async (order) => {
      const history = deferred<PullRequestReviewThread>()
      const live = deferred<PullRequestReviewThread>()
      const target: PullRequestReviewThreadRef = { current: null }
      const signal = new AbortController().signal
      const installHistory = history.promise.then((thread) => installNewestThread(target, thread, signal))
      const installLive = live.promise.then((thread) => installNewestThread(target, thread, signal))
      const historyThread = {
        events: [threadEvent(127), threadEvent(128), threadEvent(129), threadEvent(130)],
        hasEarlier: true,
        historyLoaded: true,
        nextCursor: ReleaseAgentThreadCursor.make(130)
      }
      const liveThread = {
        events: [threadEvent(129), threadEvent(130), threadEvent(131)],
        hasEarlier: true,
        historyLoaded: false,
        nextCursor: ReleaseAgentThreadCursor.make(131)
      }

      if (order === "history-first") {
        history.resolve(historyThread)
        await installHistory
        live.resolve(liveThread)
      } else {
        live.resolve(liveThread)
        await installLive
        history.resolve(historyThread)
      }
      await Promise.all([installHistory, installLive])

      expect(target.current?.events.map(({ eventSequence }) => eventSequence)).toEqual([
        ReleaseAgentThreadCursor.make(127),
        ReleaseAgentThreadCursor.make(128),
        ReleaseAgentThreadCursor.make(129),
        ReleaseAgentThreadCursor.make(130),
        ReleaseAgentThreadCursor.make(131)
      ])
      expect(target.current).toMatchObject({
        hasEarlier: true,
        historyLoaded: true,
        nextCursor: ReleaseAgentThreadCursor.make(131)
      })
    }
  )

  it("fails closed when concurrent reads disagree about one durable event", () => {
    const signal = new AbortController().signal
    const original = {
      events: [threadEvent(1)],
      hasEarlier: false,
      historyLoaded: false,
      nextCursor: ReleaseAgentThreadCursor.make(1)
    }
    const target: PullRequestReviewThreadRef = { current: original }
    const conflicting = threadEvent(1)
    if (conflicting._tag !== "operator-message") {
      throw new Error("Expected operator-message fixture")
    }

    expect(() =>
      installNewestThread(
        target,
        {
          ...original,
          events: [{ ...conflicting, prompt: DurableAgentPrompt.make("Conflicting prompt.") }]
        },
        signal
      )
    ).toThrow("conflicting duplicate events")
  })

  it("rejects stale history from before a retained-window replacement", async () => {
    const staleHistory = deferred<PullRequestReviewThread>()
    const signal = new AbortController().signal
    const target: PullRequestReviewThreadRef = {
      current: {
        events: [threadEvent(1)],
        hasEarlier: false,
        historyLoaded: false,
        nextCursor: ReleaseAgentThreadCursor.make(1),
        replayGeneration: 0
      }
    }
    const staleInstall = staleHistory.promise.then((thread) => installNewestThread(target, thread, signal))

    installNewestThread(
      target,
      {
        events: [threadEvent(131)],
        hasEarlier: true,
        historyLoaded: false,
        nextCursor: ReleaseAgentThreadCursor.make(131),
        replayGeneration: 1,
        replacesRetainedWindow: true
      },
      signal
    )
    staleHistory.resolve({
      events: [threadEvent(1), threadEvent(2)],
      hasEarlier: false,
      historyLoaded: true,
      nextCursor: ReleaseAgentThreadCursor.make(1),
      replayGeneration: 0
    })
    await staleInstall

    expect(target.current?.events.map(({ eventSequence }) => eventSequence)).toEqual([131])
    expect(target.current).toMatchObject({
      hasEarlier: true,
      historyLoaded: false,
      replayGeneration: 1
    })

    installNewestThread(
      target,
      {
        events: [threadEvent(130), threadEvent(131)],
        hasEarlier: true,
        historyLoaded: true,
        nextCursor: ReleaseAgentThreadCursor.make(131),
        replayGeneration: 1
      },
      signal
    )

    expect(target.current?.events.map(({ eventSequence }) => eventSequence)).toEqual([130, 131])
    expect(target.current?.historyLoaded).toBe(true)
  })

  it("keeps the newer of two equal-generation replacement tails", () => {
    const signal = new AbortController().signal
    const target: PullRequestReviewThreadRef = {
      current: {
        events: [threadEvent(1)],
        hasEarlier: false,
        historyLoaded: false,
        nextCursor: ReleaseAgentThreadCursor.make(1),
        replayGeneration: 0
      }
    }

    installNewestThread(
      target,
      {
        events: [threadEvent(100)],
        hasEarlier: true,
        historyLoaded: false,
        nextCursor: ReleaseAgentThreadCursor.make(100),
        replayGeneration: 1,
        replacesRetainedWindow: true
      },
      signal
    )
    installNewestThread(
      target,
      {
        events: [threadEvent(200)],
        hasEarlier: true,
        historyLoaded: false,
        nextCursor: ReleaseAgentThreadCursor.make(200),
        replayGeneration: 1,
        replacesRetainedWindow: true
      },
      signal
    )
    installNewestThread(
      target,
      {
        events: [threadEvent(100)],
        hasEarlier: true,
        historyLoaded: false,
        nextCursor: ReleaseAgentThreadCursor.make(100),
        replayGeneration: 1,
        replacesRetainedWindow: true
      },
      signal
    )

    expect(target.current?.events.map(({ eventSequence }) => eventSequence)).toEqual([200])
    expect(target.current).toMatchObject({
      hasEarlier: true,
      nextCursor: ReleaseAgentThreadCursor.make(200),
      replayGeneration: 1
    })
  })

  it("preserves loaded history when a newer replacement tail overlaps it", () => {
    const signal = new AbortController().signal
    const target: PullRequestReviewThreadRef = {
      current: {
        events: [threadEvent(99), threadEvent(100)],
        hasEarlier: true,
        historyLoaded: true,
        nextCursor: ReleaseAgentThreadCursor.make(100),
        replayGeneration: 1
      }
    }

    installNewestThread(
      target,
      {
        events: [threadEvent(100), threadEvent(101)],
        hasEarlier: true,
        historyLoaded: false,
        nextCursor: ReleaseAgentThreadCursor.make(101),
        replayGeneration: 1,
        replacesRetainedWindow: true
      },
      signal
    )

    expect(target.current?.events.map(({ eventSequence }) => eventSequence)).toEqual([99, 100, 101])
    expect(target.current).toMatchObject({
      hasEarlier: true,
      historyLoaded: true,
      nextCursor: ReleaseAgentThreadCursor.make(101),
      replayGeneration: 1
    })
  })

  it("lets authoritative history clear an optimistic same-boundary cursor", () => {
    const optimistic = {
      events: [threadEvent(1)],
      hasEarlier: true,
      historyLoaded: false,
      nextCursor: ReleaseAgentThreadCursor.make(1)
    }
    const authoritative = {
      ...optimistic,
      hasEarlier: false,
      historyLoaded: true
    }

    expect(mergePullRequestReviewThreads(optimistic, authoritative)).toMatchObject({
      hasEarlier: false,
      historyLoaded: true
    })
    expect(
      mergePullRequestReviewThreads(optimistic, {
        ...optimistic,
        hasEarlier: false
      }).hasEarlier
    ).toBe(true)
  })

  it("publishes merged history after an older refresh snapshot resolves", async () => {
    const live = deferred<PullRequestReviewThread>()
    const history = deferred<PullRequestReviewThread>()
    const target: PullRequestReviewThreadRef = { current: null }
    const signal = new AbortController().signal
    const liveInstall = live.promise.then((thread) => installNewestThread(target, thread, signal))
    const historyInstall = history.promise.then((thread) => installNewestThread(target, thread, signal))
    live.resolve({
      events: [threadEvent(129), threadEvent(130), threadEvent(131)],
      hasEarlier: true,
      historyLoaded: false,
      nextCursor: ReleaseAgentThreadCursor.make(131)
    })
    const refreshSnapshot = await liveInstall
    history.resolve({
      events: [threadEvent(127), threadEvent(128), threadEvent(129), threadEvent(130)],
      hasEarlier: true,
      historyLoaded: true,
      nextCursor: ReleaseAgentThreadCursor.make(130)
    })
    await historyInstall
    const current = {
      _tag: "ready",
      action: "idle",
      baseRevision: BASE_A,
      entityId: ENTITY_ID,
      headRevision: HEAD_A,
      historyAction: "idle",
      provider: null,
      review: reviewFor(BASE_A, HEAD_A),
      sessionKey: "session-a",
      thread: refreshSnapshot
    } satisfies PullRequestReviewControllerState
    let state: PullRequestReviewControllerState = current

    publishNewestPullRequestReviewThread(refreshSnapshot, signal, current, { current }, target, (update) => {
      state = update(state)
    })

    expect(state._tag === "ready" ? state.thread?.events.map(({ eventSequence }) => eventSequence) : []).toEqual([
      ReleaseAgentThreadCursor.make(127),
      ReleaseAgentThreadCursor.make(128),
      ReleaseAgentThreadCursor.make(129),
      ReleaseAgentThreadCursor.make(130),
      ReleaseAgentThreadCursor.make(131)
    ])
    expect(state._tag === "ready" ? state.thread?.historyLoaded : false).toBe(true)
  })

  it("preserves loaded history across heads but clears it for another entity", async () => {
    const reviews = [reviewFor(BASE_A, HEAD_A), reviewFor(BASE_A, HEAD_B), reviewFor(BASE_A, HEAD_B)]
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => Promise.resolve(reviews.shift() ?? reviewFor(BASE_A, HEAD_B))),
      loadThread: vi.fn((entityId, cursor, _signal, direction) => {
        if (entityId === OTHER_ENTITY_ID) {
          return Promise.resolve(
            PullRequestReviewThreadPage.make({
              events: [threadEvent(900)],
              hasMore: false,
              nextCursor: ReleaseAgentThreadCursor.make(900)
            })
          )
        }
        if (direction === "before") {
          return Promise.resolve(
            PullRequestReviewThreadPage.make({
              events: [threadEvent(127), threadEvent(128)],
              hasMore: false,
              nextCursor: ReleaseAgentThreadCursor.make(127)
            })
          )
        }
        return Promise.resolve(
          cursor === null
            ? PullRequestReviewThreadPage.make({
                events: [threadEvent(129), threadEvent(130)],
                hasEarlier: true,
                hasMore: false,
                nextCursor: ReleaseAgentThreadCursor.make(130)
              })
            : PullRequestReviewThreadPage.make({
                events: [threadEvent(131)],
                hasMore: false,
                nextCursor: ReleaseAgentThreadCursor.make(131)
              })
        )
      }),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: () => Promise.resolve({ providers: [] }),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    const render = (entityId: EntityId, headRevision: string) =>
      mountedRoot?.render(<ReviewThreadHarness entityId={entityId} headRevision={headRevision} transport={transport} />)

    await act(async () => render(ENTITY_ID, HEAD_A))
    await act(async () => host.querySelector<HTMLButtonElement>("[data-load-earlier]")?.click())
    expect(host.querySelector("[data-thread-sequences]")?.textContent).toBe("127,128,129,130")

    await act(async () => render(ENTITY_ID, HEAD_B))
    expect(host.querySelector("[data-thread-sequences]")?.textContent).toBe("127,128,129,130,131")
    expect(host.querySelector("[data-thread-history-loaded]")?.textContent).toBe("true")
    expect(transport.loadThread).toHaveBeenCalledWith(
      ENTITY_ID,
      ReleaseAgentThreadCursor.make(130),
      expect.any(AbortSignal)
    )

    await act(async () => render(OTHER_ENTITY_ID, HEAD_B))
    expect(host.querySelector("[data-thread-sequences]")?.textContent).toBe("900")
    expect(host.querySelector("[data-thread-history-loaded]")?.textContent).toBe("false")
    expect(transport.loadThread).toHaveBeenLastCalledWith(OTHER_ENTITY_ID, null, expect.any(AbortSignal))
  })

  it("prepends one explicit backward page while preserving the live cursor", async () => {
    const previous = {
      events: [threadEvent(129), threadEvent(130)],
      hasEarlier: true,
      historyLoaded: false,
      nextCursor: ReleaseAgentThreadCursor.make(130)
    }
    const page = PullRequestReviewThreadPage.make({
      events: [threadEvent(127), threadEvent(128)],
      hasMore: true,
      nextCursor: ReleaseAgentThreadCursor.make(127)
    })
    const transport = {
      loadThread: vi.fn(() => Promise.resolve(page))
    }

    const thread = await loadEarlierPullRequestReviewThread(
      transport,
      ENTITY_ID,
      new AbortController().signal,
      previous
    )

    expect(transport.loadThread).toHaveBeenCalledWith(
      ENTITY_ID,
      ReleaseAgentThreadCursor.make(129),
      expect.any(AbortSignal),
      "before"
    )
    expect(thread.events.map(({ eventSequence }) => eventSequence)).toEqual([
      ReleaseAgentThreadCursor.make(127),
      ReleaseAgentThreadCursor.make(128),
      ReleaseAgentThreadCursor.make(129),
      ReleaseAgentThreadCursor.make(130)
    ])
    expect(thread).toMatchObject({
      hasEarlier: true,
      historyLoaded: true,
      nextCursor: ReleaseAgentThreadCursor.make(130)
    })
  })

  it("rejects a backward page that does not retreat from the requested cursor", async () => {
    const previous = {
      events: [threadEvent(129)],
      hasEarlier: true,
      historyLoaded: false,
      nextCursor: ReleaseAgentThreadCursor.make(129)
    }
    const transport = {
      loadThread: () =>
        Promise.resolve(
          PullRequestReviewThreadPage.make({
            events: [threadEvent(129)],
            hasMore: false,
            nextCursor: ReleaseAgentThreadCursor.make(129)
          })
        )
    }

    await expect(
      loadEarlierPullRequestReviewThread(transport, ENTITY_ID, new AbortController().signal, previous)
    ).rejects.toThrow("history cursor did not retreat")
  })

  it("follows advancing cursors until the durable review thread reaches its tail", async () => {
    const firstPage = PullRequestReviewThreadPage.make({
      events: Array.from({ length: 128 }, (_, index) => threadEvent(index + 1)),
      hasMore: true,
      nextCursor: ReleaseAgentThreadCursor.make(128)
    })
    const tailPage = PullRequestReviewThreadPage.make({
      events: [threadEvent(129)],
      hasMore: false,
      nextCursor: ReleaseAgentThreadCursor.make(129)
    })
    const tailRequested = deferred<void>()
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: () => Promise.resolve(reviewFor(BASE_A, HEAD_A)),
      loadThread: vi.fn((_entityId, after) => {
        if (after === null) return Promise.resolve(firstPage)
        if (after === 128) {
          tailRequested.resolve()
          return Promise.resolve(tailPage)
        }
        return Promise.reject(new Error(`Unexpected cursor ${after}`))
      }),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: () => Promise.resolve({ providers: [] }),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ReviewThreadHarness transport={transport} />))
    await act(async () => tailRequested.promise)

    expect(host.querySelector("[data-thread]")?.textContent).toBe("129")
    expect(transport.loadThread).toHaveBeenCalledTimes(2)
    expect(transport.loadThread).toHaveBeenLastCalledWith(
      ENTITY_ID,
      ReleaseAgentThreadCursor.make(128),
      expect.any(AbortSignal)
    )
  })

  it("falls back to a bounded tail window when replay advances past the page budget", async () => {
    let reads = 0
    const tailEvent = threadEvent(16_385)
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: () => Promise.resolve(reviewFor(BASE_A, HEAD_A)),
      loadThread: vi.fn((_entityId, after) => {
        reads += 1
        if (reads <= MAXIMUM_REVIEW_THREAD_PAGE_READS) {
          const firstSequence = (reads - 1) * 128 + 1
          return Promise.resolve(
            PullRequestReviewThreadPage.make({
              events: Array.from({ length: 128 }, (_, index) => threadEvent(firstSequence + index)),
              hasMore: true,
              nextCursor: ReleaseAgentThreadCursor.make(reads * 128)
            })
          )
        }
        if (after !== null) {
          return Promise.reject(new Error("Expected bounded tail fallback"))
        }
        return Promise.resolve(
          PullRequestReviewThreadPage.make({
            events: [tailEvent],
            hasMore: false,
            nextCursor: tailEvent.eventSequence
          })
        )
      }),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: () => Promise.resolve({ providers: [] }),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ReviewThreadHarness transport={transport} />))

    expect(host.querySelector("[data-thread]")?.textContent).toBe("1")
    expect(transport.loadThread).toHaveBeenCalledTimes(MAXIMUM_REVIEW_THREAD_PAGE_READS + 1)
    expect(transport.loadThread).toHaveBeenLastCalledWith(ENTITY_ID, null, expect.any(AbortSignal))
  })

  it("replaces a retained prefix at the replay budget so backward reads can close the gap", async () => {
    const signal = new AbortController().signal
    const previous: PullRequestReviewThread = {
      events: [threadEvent(1)],
      hasEarlier: false,
      historyLoaded: true,
      nextCursor: ReleaseAgentThreadCursor.make(1)
    }
    const transport = {
      loadThread: vi.fn<PullRequestReviewTransport["loadThread"]>(
        async (_entityId, cursor, _signal, direction = "after") => {
          if (direction === "before" && cursor === 131) {
            return PullRequestReviewThreadPage.make({
              events: [threadEvent(130)],
              hasMore: true,
              nextCursor: ReleaseAgentThreadCursor.make(130)
            })
          }
          if (direction === "before" && cursor === 130) {
            return PullRequestReviewThreadPage.make({
              events: Array.from({ length: 128 }, (_, index) => threadEvent(index + 2)),
              hasMore: true,
              nextCursor: ReleaseAgentThreadCursor.make(2)
            })
          }
          if (direction === "before" && cursor === 2) {
            return PullRequestReviewThreadPage.make({
              events: [threadEvent(1)],
              hasMore: false,
              nextCursor: ReleaseAgentThreadCursor.make(1)
            })
          }
          if (cursor === null) {
            return PullRequestReviewThreadPage.make({
              events: [threadEvent(131)],
              hasEarlier: true,
              hasMore: false,
              nextCursor: ReleaseAgentThreadCursor.make(131)
            })
          }
          return PullRequestReviewThreadPage.make({
            events: [threadEvent(cursor + 1)],
            hasMore: true,
            nextCursor: ReleaseAgentThreadCursor.make(cursor + 1)
          })
        }
      )
    }

    let thread = await continuePullRequestReviewThread(transport, ENTITY_ID, signal, previous)

    expect(thread.events.map(({ eventSequence }) => eventSequence)).toEqual([131])
    expect(thread).toMatchObject({
      hasEarlier: true,
      historyLoaded: false,
      replacesRetainedWindow: true
    })

    thread = await loadEarlierPullRequestReviewThread(transport, ENTITY_ID, signal, thread)
    thread = await loadEarlierPullRequestReviewThread(transport, ENTITY_ID, signal, thread)
    thread = await loadEarlierPullRequestReviewThread(transport, ENTITY_ID, signal, thread)

    expect(thread.events.map(({ eventSequence }) => eventSequence)).toEqual(
      Array.from({ length: 131 }, (_, index) => index + 1)
    )
    expect(thread.hasEarlier).toBe(false)
  })

  it("polls pending reviews from the loaded cursor and appends only new thread events", async () => {
    vi.useFakeTimers()
    const firstPage = PullRequestReviewThreadPage.make({
      events: [threadEvent(1)],
      hasMore: false,
      nextCursor: ReleaseAgentThreadCursor.make(1)
    })
    const nextPage = PullRequestReviewThreadPage.make({
      events: [threadEvent(2)],
      hasMore: false,
      nextCursor: ReleaseAgentThreadCursor.make(2)
    })
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => Promise.resolve(pendingReviewFor(BASE_A, HEAD_A))),
      loadThread: vi.fn((_entityId, after) =>
        after === null
          ? Promise.resolve(firstPage)
          : after === 1
            ? Promise.resolve(nextPage)
            : Promise.reject(new Error(`Unexpected cursor ${after}`))
      ),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: () => Promise.resolve({ providers: [] }),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ReviewThreadHarness transport={transport} />))
    expect(host.querySelector("[data-thread]")?.textContent).toBe("1")

    await act(async () => vi.advanceTimersByTimeAsync(2_000))

    expect(host.querySelector("[data-thread]")?.textContent).toBe("2")
    expect(transport.loadThread).toHaveBeenNthCalledWith(
      2,
      ENTITY_ID,
      ReleaseAgentThreadCursor.make(1),
      expect.any(AbortSignal)
    )
  })

  it("fails closed when a paged review thread repeats its cursor", async () => {
    const page = PullRequestReviewThreadPage.make({
      events: [],
      hasMore: true,
      nextCursor: ReleaseAgentThreadCursor.make(0)
    })
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: () => Promise.resolve(reviewFor(BASE_A, HEAD_A)),
      loadThread: vi.fn(() => Promise.resolve(page)),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: () => Promise.resolve({ providers: [] }),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ReviewThreadHarness transport={transport} />))

    expect(host.querySelector("[data-thread]")?.textContent).toBe("failed")
    expect(transport.loadThread).toHaveBeenCalledTimes(2)
  })

  it("loads the durable thread and forwards an explicit provider preset to enqueue", async () => {
    const thread = PullRequestReviewThreadPage.make({
      events: [
        {
          _tag: "operator-message",
          eventSequence: ReleaseAgentThreadCursor.make(1),
          jobId: JOB_ID,
          occurredAt: Schema.decodeSync(Schema.DateTimeUtcFromString)("2026-07-24T15:00:00.000Z"),
          prompt: TARGETED_PROMPT
        }
      ],
      hasMore: false,
      nextCursor: ReleaseAgentThreadCursor.make(1)
    })
    const transport = {
      enqueue: vi.fn((_entityId, _provider, _prompt, _signal) => Promise.resolve(reviewFor(BASE_A, HEAD_A))),
      load: vi.fn(() => Promise.resolve(reviewFor(BASE_A, HEAD_A))),
      loadThread: vi.fn(() => Promise.resolve(thread)),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: () =>
        Promise.resolve({
          providers: [
            {
              providerId: DurableAgentProviderId.make("openai-compatible"),
              models: [AgentModelId.make("review-model")],
              capabilities: ["pr-review"],
              health: "available",
              reviewProfile: REVIEW_PROFILE
            },
            {
              providerId: DurableAgentProviderId.make("claude"),
              models: [AgentModelId.make("default")],
              capabilities: ["pr-review"],
              health: "available",
              reviewProfile: CLAUDE_REVIEW_PROFILE
            }
          ]
        }),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(
        <ReviewThreadHarness providerId={DurableAgentProviderId.make("claude")} transport={transport} />
      )
    )
    expect(host.querySelector("[data-thread]")?.textContent).toBe("1")
    await act(async () => host.querySelector<HTMLButtonElement>("[data-start]")?.click())

    expect(transport.loadThread).toHaveBeenCalledWith(ENTITY_ID, null, expect.any(AbortSignal))
    expect(transport.enqueue).toHaveBeenCalledWith(
      ENTITY_ID,
      expect.objectContaining({
        providerId: DurableAgentProviderId.make("claude"),
        reviewProfile: CLAUDE_REVIEW_PROFILE
      }),
      TARGETED_PROMPT,
      expect.any(AbortSignal)
    )
  })

  it("rejects an enqueue that settles after its request is aborted", async () => {
    const failures: Array<PullRequestReviewRequestAborted> = []
    let enqueueSignal: AbortSignal | undefined
    let resolveEnqueue: ((review: PullRequestReviewState) => void) | undefined
    const transport = {
      enqueue: vi.fn(
        (_entityId, _provider, _prompt, signal) =>
          new Promise<PullRequestReviewState>((resolve) => {
            enqueueSignal = signal
            resolveEnqueue = resolve
          })
      ),
      load: () => Promise.resolve(reviewFor(BASE_A, HEAD_A)),
      loadThread: () => Promise.resolve(EMPTY_THREAD),
      previewPublication: () => Promise.reject(new UnexpectedPreview()),
      providers: () =>
        Promise.resolve({
          providers: [
            {
              providerId: DurableAgentProviderId.make("openai-compatible"),
              models: [AgentModelId.make("review-model")],
              capabilities: ["pr-review"],
              health: "available",
              reviewProfile: REVIEW_PROFILE
            }
          ]
        }),
      publishSuggestion: () => Promise.reject(new UnexpectedPublish())
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(
        <AwaitableStartHarness onFailure={(failure) => failures.push(failure)} transport={transport} />
      )
    )
    await vi.waitFor(() => expect(host.querySelector("[data-start-state]")?.textContent).toBe("ready"))
    await act(async () => host.querySelector<HTMLButtonElement>("[data-start-awaitable]")?.click())
    expect(transport.enqueue).toHaveBeenCalledOnce()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => mountedRoot?.unmount())
    expect(enqueueSignal?.aborted).toBe(true)
    if (resolveEnqueue === undefined) throw new LateEnqueueFailure()
    await act(async () => {
      resolveEnqueue?.(reviewFor(BASE_A, HEAD_A))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(failures).toHaveLength(1))
    expect(failures[0]).toBeInstanceOf(PullRequestReviewRequestAborted)
    mountedRoot = undefined
  })

  it("keeps the durable review available when provider catalog retries remain unavailable", async () => {
    vi.useFakeTimers()
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => Promise.resolve(completedReviewFor(BASE_A, HEAD_A))),
      loadThread: vi.fn(() => Promise.resolve(EMPTY_THREAD)),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: vi.fn(() => Promise.reject({ _tag: "ServiceUnavailableApiError" })),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ReviewThreadHarness transport={transport} />))
    expect(host.querySelector("[data-thread]")?.textContent).toBe("0")
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(host.querySelector("[data-thread]")?.textContent).toBe("0")
    expect(transport.providers).toHaveBeenCalledTimes(2)
  })

  it("restores provider actions after a transient catalog read failure", async () => {
    vi.useFakeTimers()
    const providerReads: Array<Promise<AgentProviderCatalog>> = [
      Promise.reject({ _tag: "ServiceUnavailableApiError" }),
      Promise.resolve({
        providers: [
          {
            providerId: DurableAgentProviderId.make("openai-compatible"),
            models: [AgentModelId.make("review-model")],
            capabilities: ["pr-review"],
            health: "available",
            reviewProfile: REVIEW_PROFILE
          }
        ]
      })
    ]
    const transport = {
      enqueue: vi.fn((_entityId, _provider, _prompt, _signal) => Promise.resolve(reviewFor(BASE_A, HEAD_A))),
      load: vi.fn(() => Promise.resolve(completedReviewFor(BASE_A, HEAD_A))),
      loadThread: vi.fn(() => Promise.resolve(EMPTY_THREAD)),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: vi.fn(() => providerReads.shift() ?? Promise.reject(new Error("Unexpected provider catalog read"))),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ReviewThreadHarness transport={transport} />))
    expect(host.querySelector("[data-thread]")?.textContent).toBe("0")
    await act(async () => host.querySelector<HTMLButtonElement>("[data-start]")?.click())
    expect(transport.enqueue).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    await act(async () => host.querySelector<HTMLButtonElement>("[data-start]")?.click())

    expect(transport.providers).toHaveBeenCalledTimes(2)
    expect(transport.enqueue).toHaveBeenCalledOnce()
  })

  it.each([
    {
      failure: { _tag: "UnauthorizedApiError" },
      expectedSessionExpirations: 1
    },
    {
      failure: new Error("Invalid provider catalog response"),
      expectedSessionExpirations: 0
    }
  ])(
    "fails a non-recoverable provider catalog read without masking session expiry",
    async ({ expectedSessionExpirations, failure }) => {
      const onSessionExpired = vi.fn()
      const transport = {
        enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
        load: vi.fn(() => Promise.resolve(completedReviewFor(BASE_A, HEAD_A))),
        loadThread: vi.fn(() => Promise.resolve(EMPTY_THREAD)),
        previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
        providers: vi.fn(() => Promise.reject(failure)),
        publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
      } satisfies PullRequestReviewTransport
      const host = document.createElement("div")
      document.body.append(host)
      mountedRoot = createRoot(host)

      await act(async () =>
        mountedRoot?.render(<ReviewThreadHarness onSessionExpired={onSessionExpired} transport={transport} />)
      )

      expect(host.querySelector("[data-thread]")?.textContent).toBe("failed")
      expect(onSessionExpired).toHaveBeenCalledTimes(expectedSessionExpirations)
      if (expectedSessionExpirations === 1) {
        expect(onSessionExpired).toHaveBeenCalledWith("session-a")
      }
    }
  )

  it("recovers from one transient durable review read failure without showing a terminal failure", async () => {
    vi.useFakeTimers()
    const reviewReads = [
      Promise.reject({ _tag: "ServiceUnavailableApiError" }),
      Promise.resolve(completedReviewFor(BASE_A, HEAD_A))
    ]
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => reviewReads.shift() ?? Promise.reject(new Error("Unexpected review read"))),
      loadThread: vi.fn(() => Promise.resolve(EMPTY_THREAD)),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: vi.fn(() => Promise.resolve({ providers: [] })),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ReviewThreadHarness transport={transport} />))
    expect(host.querySelector("[data-thread]")?.textContent).toBe("loading")
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(host.querySelector("[data-thread]")?.textContent).toBe("0")
    expect(transport.load).toHaveBeenCalledTimes(2)
  })

  it("waits until the advertised rate-limit retry instant", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const reviewReads = [
      Promise.reject({
        _tag: "RateLimitedApiError",
        retryAt: Schema.decodeSync(Schema.DateTimeUtcFromString)("1970-01-01T00:00:05.000Z")
      }),
      Promise.resolve(completedReviewFor(BASE_A, HEAD_A))
    ]
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => reviewReads.shift() ?? Promise.reject(new Error("Unexpected review read"))),
      loadThread: vi.fn(() => Promise.resolve(EMPTY_THREAD)),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: vi.fn(() => Promise.resolve({ providers: [] })),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ReviewThreadHarness transport={transport} />))
    await act(async () => vi.advanceTimersByTimeAsync(4_999))

    expect(transport.load).toHaveBeenCalledOnce()

    await act(async () => vi.advanceTimersByTimeAsync(1))

    expect(host.querySelector("[data-thread]")?.textContent).toBe("0")
    expect(transport.load).toHaveBeenCalledTimes(2)
  })

  it("backs off long enough to replenish a three-read retry batch", async () => {
    vi.useFakeTimers()
    const reviewReads = [
      Promise.reject({ _tag: "RateLimitedApiError", retryAt: null }),
      Promise.resolve(reviewFor(BASE_A, HEAD_A))
    ]
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => reviewReads.shift() ?? Promise.reject(new Error("Unexpected review read"))),
      loadThread: vi.fn(() => Promise.resolve(EMPTY_THREAD)),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: vi.fn(() => Promise.resolve({ providers: [] })),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ReviewThreadHarness transport={transport} />))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(transport.load).toHaveBeenCalledOnce()
    expect(transport.loadThread).toHaveBeenCalledOnce()
    expect(transport.providers).toHaveBeenCalledOnce()

    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(host.querySelector("[data-thread]")?.textContent).toBe("0")
    expect(transport.load).toHaveBeenCalledTimes(2)
    expect(transport.loadThread).toHaveBeenCalledTimes(2)
    expect(transport.providers).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      failure: { _tag: "UnauthorizedApiError" },
      expectedHistoryAction: "failed",
      expectedSessionExpirations: 1
    },
    {
      failure: new Error("history unavailable"),
      expectedHistoryAction: "failed",
      expectedSessionExpirations: 0
    }
  ])(
    "handles a rejected backward history read without retaining a stale session",
    async ({ expectedHistoryAction, expectedSessionExpirations, failure }) => {
      const onSessionExpired = vi.fn()
      const pageSize = MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS / 2
      const transport = {
        enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
        load: () => Promise.resolve(reviewFor(BASE_A, HEAD_A)),
        loadThread: vi.fn((_entityId, cursor, _signal, direction) => {
          if (direction === "before") return Promise.reject(failure)
          const firstSequence = cursor === null ? 1 : cursor + 1
          const events =
            firstSequence > MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS
              ? [threadEvent(firstSequence)]
              : Array.from({ length: pageSize }, (_, index) => threadEvent(firstSequence + index))
          return Promise.resolve(
            PullRequestReviewThreadPage.make({
              events,
              hasMore: firstSequence <= MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS,
              nextCursor: events.at(-1)?.eventSequence ?? ReleaseAgentThreadCursor.make(0)
            })
          )
        }),
        previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
        providers: () => Promise.resolve({ providers: [] }),
        publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
      } satisfies PullRequestReviewTransport
      const host = document.createElement("div")
      document.body.append(host)
      mountedRoot = createRoot(host)

      await act(async () =>
        mountedRoot?.render(<ReviewThreadHarness onSessionExpired={onSessionExpired} transport={transport} />)
      )
      await act(async () => host.querySelector<HTMLButtonElement>("[data-load-earlier]")?.click())

      expect(host.querySelector("[data-history]")?.textContent).toBe(expectedHistoryAction)
      expect(onSessionExpired).toHaveBeenCalledTimes(expectedSessionExpirations)
      if (expectedSessionExpirations === 1) {
        expect(onSessionExpired).toHaveBeenCalledWith("session-a")
      }
    }
  )

  it("gates publication, quarantines a mismatched receipt, and resets on scope change", async () => {
    const { preview, published } = makePublicationFixture(HEAD_B)
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn((_entityId, _signal) => Promise.resolve(completedReviewFor(BASE_A, HEAD_A))),
      loadThread: () => Promise.resolve(EMPTY_THREAD),
      previewPublication: vi.fn(() => Promise.resolve(preview)),
      providers: () => Promise.reject(new Error("Unexpected provider read")),
      publishSuggestion: vi.fn(() => Promise.resolve(published))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<PublicationHarness headRevision={HEAD_A} transport={transport} />))
    await act(async () => host.querySelector<HTMLButtonElement>("[data-preview-wrong]")?.click())
    expect(transport.previewPublication).not.toHaveBeenCalled()
    await act(async () => host.querySelector<HTMLButtonElement>("[data-preview]")?.click())
    expect(transport.previewPublication).toHaveBeenCalledWith(
      ENTITY_ID,
      { jobId: JOB_ID, revisionId: REVIEW_REVISION_ID, suggestionId: SUGGESTION_ID },
      expect.any(AbortSignal)
    )
    expect(host.querySelector("[data-publication]")?.textContent).toBe("preview")

    await act(async () => host.querySelector<HTMLButtonElement>("[data-publish]")?.click())
    expect(transport.publishSuggestion).toHaveBeenCalledWith(
      ENTITY_ID,
      {
        jobId: JOB_ID,
        suggestionId: SUGGESTION_ID,
        revisionId: REVIEW_REVISION_ID
      },
      ReviewSuggestionPublicationContent.make("Confirmed content."),
      preview.authorityBinding,
      expect.any(AbortSignal)
    )
    expect(host.querySelector("[data-publication]")?.textContent).toBe("receipt-conflict:comment-42")

    await act(async () => mountedRoot?.render(<PublicationHarness headRevision={HEAD_B} transport={transport} />))
    expect(host.querySelector("[data-publication]")?.textContent).toBe("idle")
  })

  it("classifies an in-flight receipt against the source revision at the commit boundary", async () => {
    const { preview, published } = makePublicationFixture(HEAD_A)
    const publication = deferred<PublishedReviewComment>()
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn((_entityId, _signal) => Promise.resolve(completedReviewFor(BASE_A, HEAD_A))),
      loadThread: () => Promise.resolve(EMPTY_THREAD),
      previewPublication: vi.fn(() => Promise.resolve(preview)),
      providers: () => Promise.reject(new Error("Unexpected provider read")),
      publishSuggestion: vi.fn(() => publication.promise)
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<PublicationHarness headRevision={HEAD_A} transport={transport} />))
    await act(async () => host.querySelector<HTMLButtonElement>("[data-preview]")?.click())
    await act(async () => host.querySelector<HTMLButtonElement>("[data-publish]")?.click())
    expect(host.querySelector("[data-publication]")?.textContent).toBe("publishing")

    const revisionCommitted = deferred<void>()
    mountedRoot.render(
      <PublicationHarness
        headRevision={HEAD_B}
        onRevisionCommit={() => {
          publication.resolve(published)
          revisionCommitted.resolve()
        }}
        transport={transport}
      />
    )
    await revisionCommitted.promise
    await act(async () => Promise.resolve())
    expect(host.querySelector("[data-publication]")?.textContent).toBe("published:superseded:comment-42")
  })

  it("keeps an in-flight receipt current when the source revision is unchanged", async () => {
    const { preview, published } = makePublicationFixture(HEAD_A)
    const publication = deferred<PublishedReviewComment>()
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn((_entityId, _signal) => Promise.resolve(completedReviewFor(BASE_A, HEAD_A))),
      loadThread: () => Promise.resolve(EMPTY_THREAD),
      previewPublication: vi.fn(() => Promise.resolve(preview)),
      providers: () => Promise.reject(new Error("Unexpected provider read")),
      publishSuggestion: vi.fn(() => publication.promise)
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<PublicationHarness headRevision={HEAD_A} transport={transport} />))
    await act(async () => host.querySelector<HTMLButtonElement>("[data-preview]")?.click())
    await act(async () => host.querySelector<HTMLButtonElement>("[data-publish]")?.click())
    await act(async () => publication.resolve(published))

    expect(host.querySelector("[data-publication]")?.textContent).toBe("published:current:comment-42")
    expect(host.querySelector("[data-suggestion-state]")?.textContent).toBe("published")
  })

  it("refreshes the durable thread after a successful publication", async () => {
    const { preview, published } = makePublicationFixture(HEAD_A)
    let threadReads = 0
    const publishedEvent: PullRequestReviewThreadEvent = {
      _tag: "suggestion-published",
      eventSequence: ReleaseAgentThreadCursor.make(1),
      jobId: JOB_ID,
      occurredAt: Schema.decodeSync(Schema.DateTimeUtcFromString)("2026-07-24T15:05:00.000Z"),
      suggestionId: SUGGESTION_ID,
      revisionId: REVIEW_REVISION_ID
    }
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => Promise.resolve(completedReviewFor(BASE_A, HEAD_A))),
      loadThread: vi.fn((_entityId, _after) => {
        threadReads += 1
        return threadReads <= 2
          ? Promise.resolve(EMPTY_THREAD)
          : Promise.resolve(
              PullRequestReviewThreadPage.make({
                events: [publishedEvent],
                hasMore: false,
                nextCursor: ReleaseAgentThreadCursor.make(1)
              })
            )
      }),
      previewPublication: vi.fn(() => Promise.resolve(preview)),
      providers: () => Promise.reject(new Error("Unexpected provider read")),
      publishSuggestion: vi.fn(() => Promise.resolve(published))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<PublicationHarness headRevision={HEAD_A} transport={transport} />))
    await act(async () => host.querySelector<HTMLButtonElement>("[data-preview]")?.click())
    await act(async () => host.querySelector<HTMLButtonElement>("[data-publish]")?.click())

    expect(host.querySelector("[data-thread]")?.textContent).toBe("1")
    expect(transport.loadThread).toHaveBeenCalledTimes(3)
  })

  it("refreshes the active stable thread when publication finishes after the head changes", async () => {
    const { preview, published } = makePublicationFixture(HEAD_A)
    const publication = deferred<PublishedReviewComment>()
    const headBLoaded = deferred<void>()
    let reviewReads = 0
    let threadReads = 0
    const publishedEvent: PullRequestReviewThreadEvent = {
      _tag: "suggestion-published",
      eventSequence: ReleaseAgentThreadCursor.make(1),
      jobId: JOB_ID,
      occurredAt: Schema.decodeSync(Schema.DateTimeUtcFromString)("2026-07-24T15:05:00.000Z"),
      suggestionId: SUGGESTION_ID,
      revisionId: REVIEW_REVISION_ID
    }
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => {
        reviewReads += 1
        return Promise.resolve(completedReviewFor(BASE_A, reviewReads === 1 ? HEAD_A : HEAD_B))
      }),
      loadThread: vi.fn(() => {
        threadReads += 1
        if (threadReads === 4) headBLoaded.resolve()
        return Promise.resolve(
          threadReads < 5
            ? EMPTY_THREAD
            : PullRequestReviewThreadPage.make({
                events: [publishedEvent],
                hasMore: false,
                nextCursor: ReleaseAgentThreadCursor.make(1)
              })
        )
      }),
      previewPublication: vi.fn(() => Promise.resolve(preview)),
      providers: () => Promise.reject(new Error("Unexpected provider read")),
      publishSuggestion: vi.fn(() => publication.promise)
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<PublicationHarness headRevision={HEAD_A} transport={transport} />))
    await act(async () => host.querySelector<HTMLButtonElement>("[data-preview]")?.click())
    await act(async () => host.querySelector<HTMLButtonElement>("[data-publish]")?.click())
    await act(async () => mountedRoot?.render(<PublicationHarness headRevision={HEAD_B} transport={transport} />))
    await act(async () => headBLoaded.promise)
    expect(host.querySelector("[data-thread]")?.textContent).toBe("0")

    await act(async () => publication.resolve(published))

    expect(host.querySelector("[data-publication]")?.textContent).toBe("published:superseded:comment-42")
    expect(host.querySelector("[data-thread]")?.textContent).toBe("1")
    expect(transport.loadThread).toHaveBeenCalledTimes(5)
  })

  it("does not let an older scope load overwrite a newer publication refresh", async () => {
    const { preview, published } = makePublicationFixture(HEAD_A)
    const publication = deferred<PublishedReviewComment>()
    const staleThread = deferred<PullRequestReviewThreadPage>()
    const staleThreadRequested = deferred<void>()
    const refreshedThread = deferred<void>()
    let reviewReads = 0
    let threadReads = 0
    const publishedEvent: PullRequestReviewThreadEvent = {
      _tag: "suggestion-published",
      eventSequence: ReleaseAgentThreadCursor.make(1),
      jobId: JOB_ID,
      occurredAt: Schema.decodeSync(Schema.DateTimeUtcFromString)("2026-07-24T15:05:00.000Z"),
      suggestionId: SUGGESTION_ID,
      revisionId: REVIEW_REVISION_ID
    }
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => {
        reviewReads += 1
        return Promise.resolve(reviewReads === 1 ? completedReviewFor(BASE_A, HEAD_A) : reviewFor(BASE_A, HEAD_A))
      }),
      loadThread: vi.fn(() => {
        threadReads += 1
        if (threadReads <= 2) return Promise.resolve(EMPTY_THREAD)
        if (threadReads === 3) {
          staleThreadRequested.resolve()
          return staleThread.promise
        }
        refreshedThread.resolve()
        return Promise.resolve(
          PullRequestReviewThreadPage.make({
            events: [publishedEvent],
            hasMore: false,
            nextCursor: ReleaseAgentThreadCursor.make(1)
          })
        )
      }),
      previewPublication: vi.fn(() => Promise.resolve(preview)),
      providers: () => Promise.reject(new Error("Unexpected provider read")),
      publishSuggestion: vi.fn(() => publication.promise)
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<PublicationHarness headRevision={HEAD_A} transport={transport} />))
    await act(async () => host.querySelector<HTMLButtonElement>("[data-preview]")?.click())
    await act(async () => host.querySelector<HTMLButtonElement>("[data-publish]")?.click())
    await act(async () => host.querySelector<HTMLButtonElement>("[data-retry]")?.click())
    await act(async () => staleThreadRequested.promise)

    await act(async () => publication.resolve(published))
    await act(async () => refreshedThread.promise)
    await act(async () =>
      staleThread.resolve(
        PullRequestReviewThreadPage.make({
          events: [],
          hasMore: false,
          nextCursor: ReleaseAgentThreadCursor.make(0)
        })
      )
    )

    expect(host.querySelector("[data-thread]")?.textContent).toBe("1")
    expect(transport.loadThread).toHaveBeenCalledTimes(4)
  })

  it("rechecks the durable tail after a pending poll observes terminal review state", async () => {
    vi.useFakeTimers()
    let reviewReads = 0
    let threadReads = 0
    const terminalEvent: PullRequestReviewThreadEvent = {
      _tag: "run-completed",
      eventSequence: ReleaseAgentThreadCursor.make(2),
      jobId: JOB_ID,
      occurredAt: Schema.decodeSync(Schema.DateTimeUtcFromString)("2026-07-24T15:05:00.000Z"),
      outcome: "success"
    }
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => {
        reviewReads += 1
        return Promise.resolve(
          reviewReads === 1 ? pendingReviewFor(BASE_A, HEAD_A) : completedReviewFor(BASE_A, HEAD_A)
        )
      }),
      loadThread: vi.fn((_entityId, _after) => {
        threadReads += 1
        return Promise.resolve(
          threadReads === 1
            ? PullRequestReviewThreadPage.make({
                events: [threadEvent(1)],
                hasMore: false,
                nextCursor: ReleaseAgentThreadCursor.make(1)
              })
            : threadReads === 2
              ? PullRequestReviewThreadPage.make({
                  events: [],
                  hasMore: false,
                  nextCursor: ReleaseAgentThreadCursor.make(1)
                })
              : PullRequestReviewThreadPage.make({
                  events: [terminalEvent],
                  hasMore: false,
                  nextCursor: ReleaseAgentThreadCursor.make(2)
                })
        )
      }),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: () => Promise.resolve({ providers: [] }),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ReviewThreadHarness transport={transport} />))
    await act(async () => vi.advanceTimersByTimeAsync(2_000))

    expect(host.querySelector("[data-thread]")?.textContent).toBe("2")
    expect(transport.loadThread).toHaveBeenNthCalledWith(
      3,
      ENTITY_ID,
      ReleaseAgentThreadCursor.make(1),
      expect.any(AbortSignal)
    )
  })

  it("rechecks the durable tail when the initial snapshot is already terminal", async () => {
    let threadReads = 0
    const terminalEvent: PullRequestReviewThreadEvent = {
      _tag: "run-completed",
      eventSequence: ReleaseAgentThreadCursor.make(2),
      jobId: JOB_ID,
      occurredAt: Schema.decodeSync(Schema.DateTimeUtcFromString)("2026-07-24T15:05:00.000Z"),
      outcome: "success"
    }
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: () => Promise.resolve(completedReviewFor(BASE_A, HEAD_A)),
      loadThread: vi.fn((_entityId, _after) => {
        threadReads += 1
        return Promise.resolve(
          threadReads === 1
            ? PullRequestReviewThreadPage.make({
                events: [threadEvent(1)],
                hasMore: false,
                nextCursor: ReleaseAgentThreadCursor.make(1)
              })
            : PullRequestReviewThreadPage.make({
                events: [terminalEvent],
                hasMore: false,
                nextCursor: ReleaseAgentThreadCursor.make(2)
              })
        )
      }),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: () => Promise.resolve({ providers: [] }),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ReviewThreadHarness transport={transport} />))

    expect(host.querySelector("[data-thread]")?.textContent).toBe("2")
    expect(transport.loadThread).toHaveBeenNthCalledWith(1, ENTITY_ID, null, expect.any(AbortSignal))
    expect(transport.loadThread).toHaveBeenNthCalledWith(
      2,
      ENTITY_ID,
      ReleaseAgentThreadCursor.make(1),
      expect.any(AbortSignal)
    )
  })

  it("does not refresh the durable thread when publication fails", async () => {
    const { preview } = makePublicationFixture(HEAD_A)
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => Promise.resolve(completedReviewFor(BASE_A, HEAD_A))),
      loadThread: vi.fn(() => Promise.resolve(EMPTY_THREAD)),
      previewPublication: vi.fn(() => Promise.resolve(preview)),
      providers: () => Promise.reject(new Error("Unexpected provider read")),
      publishSuggestion: vi.fn(() => Promise.reject(new Error("Provider rejected publication")))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<PublicationHarness headRevision={HEAD_A} transport={transport} />))
    await act(async () => host.querySelector<HTMLButtonElement>("[data-preview]")?.click())
    await act(async () => host.querySelector<HTMLButtonElement>("[data-publish]")?.click())

    expect(host.querySelector("[data-publication]")?.textContent).toBe("failed")
    expect(host.querySelector("[data-thread]")?.textContent).toBe("0")
    expect(transport.loadThread).toHaveBeenCalledTimes(2)
  })

  it("never presents a prior immutable head while the refreshed head loads", async () => {
    const requestA = deferred<PullRequestReviewState>()
    const requestB = deferred<PullRequestReviewState>()
    const requests = [requestA.promise, requestB.promise]
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => requests.shift() ?? Promise.reject(new Error("Unexpected review read"))),
      loadThread: () => Promise.resolve(EMPTY_THREAD),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: () => Promise.reject(new Error("Unexpected provider read")),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<Harness headRevision={HEAD_A} transport={transport} />))
    await act(async () => requestA.resolve(reviewFor(BASE_A, HEAD_A)))
    expect(host.textContent).toBe(`not-started:${BASE_A}:${HEAD_A}`)

    await act(async () => mountedRoot?.render(<Harness headRevision={HEAD_A} transport={transport} />))
    expect(host.textContent).toBe(`not-started:${BASE_A}:${HEAD_A}`)
    expect(transport.load).toHaveBeenCalledOnce()

    await act(async () => mountedRoot?.render(<Harness headRevision={HEAD_B} transport={transport} />))
    expect(host.textContent).toBe("loading")

    await act(async () => requestB.resolve(reviewFor(BASE_A, HEAD_B)))
    expect(host.textContent).toBe(`not-started:${BASE_A}:${HEAD_B}`)
    expect(transport.load).toHaveBeenCalledTimes(2)
  })

  it("drops prior review state when the base changes under the same head", async () => {
    const requestA = deferred<PullRequestReviewState>()
    const requestB = deferred<PullRequestReviewState>()
    const requests = [requestA.promise, requestB.promise]
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => requests.shift() ?? Promise.reject(new Error("Unexpected review read"))),
      loadThread: () => Promise.resolve(EMPTY_THREAD),
      previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
      providers: () => Promise.reject(new Error("Unexpected provider read")),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(<Harness baseRevision={BASE_A} headRevision={HEAD_A} transport={transport} />)
    )
    await act(async () => requestA.resolve(reviewFor(BASE_A, HEAD_A)))
    expect(host.textContent).toBe(`not-started:${BASE_A}:${HEAD_A}`)

    await act(async () =>
      mountedRoot?.render(<Harness baseRevision={BASE_B} headRevision={HEAD_A} transport={transport} />)
    )
    expect(host.textContent).toBe("loading")

    await act(async () => requestB.resolve(reviewFor(BASE_B, HEAD_A)))
    expect(host.textContent).toBe(`not-started:${BASE_B}:${HEAD_A}`)
    expect(transport.load).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      label: "base",
      requestedBase: BASE_B,
      requestedHead: HEAD_A,
      responseBase: BASE_A,
      responseHead: HEAD_A
    },
    {
      label: "head",
      requestedBase: BASE_A,
      requestedHead: HEAD_B,
      responseBase: BASE_A,
      responseHead: HEAD_A
    }
  ])(
    "rejects a response for a mismatched immutable $label revision",
    async ({ requestedBase, requestedHead, responseBase, responseHead }) => {
      const transport = {
        enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
        load: vi.fn(() => Promise.resolve(reviewFor(responseBase, responseHead))),
        loadThread: () => Promise.resolve(EMPTY_THREAD),
        previewPublication: () => Promise.reject(new Error("Unexpected publication preview")),
        providers: () => Promise.reject(new Error("Unexpected provider read")),
        publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
      } satisfies PullRequestReviewTransport
      const host = document.createElement("div")
      document.body.append(host)
      mountedRoot = createRoot(host)

      await act(async () =>
        mountedRoot?.render(<Harness baseRevision={requestedBase} headRevision={requestedHead} transport={transport} />)
      )
      expect(host.textContent).toBe("failed")
    }
  )
})

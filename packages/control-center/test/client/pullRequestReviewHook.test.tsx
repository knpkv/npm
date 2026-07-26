// @vitest-environment happy-dom

import { type ReactElement, act, useLayoutEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Schema from "effect/Schema"

import {
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
  type PullRequestReviewTransport,
  usePullRequestReview
} from "../../src/client/entities/usePullRequestReview.js"
import { EntityId, GovernedActionId, JobId, PersonId } from "../../src/domain/identifiers.js"
import { PrReviewPath, PrReviewSubject, PrReviewSuggestionId } from "../../src/domain/prReview.js"
import { PluginProviderOperationId, PluginProviderReceiptV1 } from "../../src/domain/plugins/actions.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000601")
const BASE_A = "0".repeat(40)
const BASE_B = "1".repeat(40)
const HEAD_A = "a".repeat(40)
const HEAD_B = "b".repeat(40)
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000602")
const SUGGESTION_ID = PrReviewSuggestionId.make(`sha256:${"7".repeat(64)}`)
const WRONG_SUGGESTION_ID = PrReviewSuggestionId.make(`sha256:${"8".repeat(64)}`)
const OPERATOR_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000603")
const REVIEW_PROFILE: ReviewAgentProfile = {
  profileId: ReviewAgentProfileId.make("openai-compatible:review-model:sbx"),
  label: "Full-project review · openai-compatible · review-model",
  budgetMillis: 1_200_000,
  networkAccess: "blocked",
  sandbox: "sbx"
}
const TARGETED_PROMPT = DurableAgentPrompt.make("Re-check transaction ownership.")
const EMPTY_THREAD = PullRequestReviewThreadPage.make({
  events: [],
  hasMore: false,
  nextCursor: ReleaseAgentThreadCursor.make(0)
})

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
            suggestionId: SUGGESTION_ID
          })
        }
      />
      <button
        data-preview-wrong
        onClick={() =>
          controller.previewPublication({
            jobId: JOB_ID,
            suggestionId: WRONG_SUGGESTION_ID
          })
        }
      />
      <button
        data-publish
        onClick={() => controller.publishSuggestion(ReviewSuggestionPublicationContent.make("Confirmed content."))}
      />
    </>
  )
}

const ReviewThreadHarness = ({ transport }: { readonly transport: PullRequestReviewTransport }): ReactElement => {
  const controller = usePullRequestReview(ENTITY_ID, BASE_A, HEAD_A, "session-a", true, ignoreSessionExpired, transport)
  return (
    <>
      <span data-thread>
        {controller.state._tag === "ready"
          ? String(controller.state.thread?.events.length ?? 0)
          : controller.state._tag}
      </span>
      <button data-start onClick={() => controller.start(TARGETED_PROMPT)} />
    </>
  )
}

describe("usePullRequestReview", () => {
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
        if (after === 0) return Promise.resolve(firstPage)
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
        after === 0
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
    expect(transport.loadThread).toHaveBeenCalledOnce()
  })

  it("loads the durable thread and forwards a targeted request to enqueue", async () => {
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
            }
          ]
        }),
      publishSuggestion: () => Promise.reject(new Error("Unexpected suggestion publication"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ReviewThreadHarness transport={transport} />))
    expect(host.querySelector("[data-thread]")?.textContent).toBe("1")
    await act(async () => host.querySelector<HTMLButtonElement>("[data-start]")?.click())

    expect(transport.loadThread).toHaveBeenCalledWith(
      ENTITY_ID,
      ReleaseAgentThreadCursor.make(0),
      expect.any(AbortSignal)
    )
    expect(transport.enqueue).toHaveBeenCalledWith(
      ENTITY_ID,
      expect.objectContaining({ reviewProfile: REVIEW_PROFILE }),
      TARGETED_PROMPT,
      expect.any(AbortSignal)
    )
  })

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
      { jobId: JOB_ID, suggestionId: SUGGESTION_ID },
      expect.any(AbortSignal)
    )
    expect(host.querySelector("[data-publication]")?.textContent).toBe("preview")

    await act(async () => host.querySelector<HTMLButtonElement>("[data-publish]")?.click())
    expect(transport.publishSuggestion).toHaveBeenCalledWith(
      ENTITY_ID,
      { jobId: JOB_ID, suggestionId: SUGGESTION_ID },
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
      suggestionId: SUGGESTION_ID
    }
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => Promise.resolve(completedReviewFor(BASE_A, HEAD_A))),
      loadThread: vi.fn((_entityId, _after) => {
        threadReads += 1
        return threadReads === 1
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
    expect(transport.loadThread).toHaveBeenCalledTimes(2)
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
      suggestionId: SUGGESTION_ID
    }
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => {
        reviewReads += 1
        return Promise.resolve(completedReviewFor(BASE_A, reviewReads === 1 ? HEAD_A : HEAD_B))
      }),
      loadThread: vi.fn(() => {
        threadReads += 1
        if (threadReads === 2) headBLoaded.resolve()
        return Promise.resolve(
          threadReads < 3
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
    expect(transport.loadThread).toHaveBeenCalledTimes(3)
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
    expect(transport.loadThread).toHaveBeenCalledOnce()
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

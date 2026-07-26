// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AgentModelId,
  DurableAgentProviderId,
  MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH,
  PublishedReviewComment,
  PullRequestReviewState,
  PullRequestReviewThreadPage,
  PullRequestReviewUnavailable,
  ReleaseAgentThreadCursor,
  type ReviewAgentProfile,
  ReviewAgentProfileId,
  ReviewSuggestionPublicationAuthorityBinding,
  ReviewSuggestionPublicationContent,
  ReviewSuggestionPublicationPreview
} from "../../src/api/agent.js"
import { PullRequestReviewPanel } from "../../src/client/entities/PullRequestReviewPanel.js"
import type { PullRequestReviewControllerState } from "../../src/client/entities/usePullRequestReview.js"
import { EntityId, GovernedActionId, JobId, PersonId } from "../../src/domain/identifiers.js"
import { PluginProviderOperationId, PluginProviderReceiptV1 } from "../../src/domain/plugins/actions.js"
import { PrReviewPath, PrReviewSubject, PrReviewSuggestionId } from "../../src/domain/prReview.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000701")
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000702")
const SUGGESTION_ID = PrReviewSuggestionId.make(`sha256:${"7".repeat(64)}`)
const FILE_SUGGESTION_ID = PrReviewSuggestionId.make(`sha256:${"6".repeat(64)}`)
const ANCHOR_PATH = PrReviewPath.make("src/authorization.ts")
const ANCHOR_LINE = 42
const OPERATOR_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000703")
const SUBJECT = PrReviewSubject.make({
  providerId: "codecommit",
  repository: "control-center",
  pullRequestId: "212",
  baseRevision: "1".repeat(40),
  headRevision: "2".repeat(40)
})
const REVIEW_PROFILE: ReviewAgentProfile = {
  profileId: ReviewAgentProfileId.make("openai-compatible:review-model:sbx"),
  label: "Full-project review · openai-compatible · review-model",
  budgetMillis: 1_200_000,
  networkAccess: "blocked",
  sandbox: "sbx"
}
const EDITABLE_CONTENT = ReviewSuggestionPublicationContent.make(
  "Authorize before mutating.\n\n```suggestion\nyield* authorize()\nyield* mutate()\n```"
)
const PUBLICATION_FOOTER = `— ${REVIEW_PROFILE.label} · head ${SUBJECT.headRevision.slice(0, 12)} · operator ${OPERATOR_ID}`
const FINAL_CONTENT = ReviewSuggestionPublicationContent.make(`${EDITABLE_CONTENT}\n\n${PUBLICATION_FOOTER}`)
const PREVIEW = new ReviewSuggestionPublicationPreview({
  jobId: JOB_ID,
  suggestionId: SUGGESTION_ID,
  subject: SUBJECT,
  suggestionRevision: {
    jobId: JOB_ID,
    suggestionId: SUGGESTION_ID,
    reviewedHead: SUBJECT.headRevision
  },
  anchor: {
    _tag: "line",
    path: ANCHOR_PATH,
    line: ANCHOR_LINE,
    relativeFileVersion: "AFTER"
  },
  editableContent: EDITABLE_CONTENT,
  editableContentMaximumLength: 10_100 - PUBLICATION_FOOTER.length - 2,
  finalContent: FINAL_CONTENT,
  publicationFooter: PUBLICATION_FOOTER,
  replacement: "yield* authorize()\nyield* mutate()",
  connectedIdentity: {
    accountId: "123456789012",
    arn: "arn:aws:iam::123456789012:user/local-operator"
  },
  authorityBinding: ReviewSuggestionPublicationAuthorityBinding.make(`sha256:${"a".repeat(64)}`),
  proposingAgent: REVIEW_PROFILE,
  publishingOperator: OPERATOR_ID
})
const RECEIPT = Schema.decodeSync(PluginProviderReceiptV1)({
  providerOperationId: PluginProviderOperationId.make("comment-42"),
  status: "succeeded",
  safeSummary: "Posted an inline pull-request comment",
  observedAt: "2026-07-24T15:05:00.000Z"
})
const PUBLICATION = new PublishedReviewComment({
  publicationId: GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-000000000704"),
  jobId: JOB_ID,
  suggestionId: SUGGESTION_ID,
  subject: SUBJECT,
  suggestionRevision: PREVIEW.suggestionRevision,
  anchor: PREVIEW.anchor,
  content: FINAL_CONTENT,
  connectedIdentity: PREVIEW.connectedIdentity,
  proposingAgent: REVIEW_PROFILE,
  publishingOperator: OPERATOR_ID,
  receipt: RECEIPT,
  publishedAt: RECEIPT.observedAt
})
const REVIEW_STATE = {
  _tag: "ready",
  baseRevision: SUBJECT.baseRevision,
  entityId: ENTITY_ID,
  headRevision: SUBJECT.headRevision,
  sessionKey: "session-a",
  action: "idle",
  provider: {
    providerId: DurableAgentProviderId.make("openai-compatible"),
    model: AgentModelId.make("review-model"),
    reviewProfile: REVIEW_PROFILE
  },
  review: Schema.decodeUnknownSync(PullRequestReviewState)({
    _tag: "completed",
    subject: SUBJECT,
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
      subject: SUBJECT,
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
            path: ANCHOR_PATH,
            startLine: ANCHOR_LINE,
            endLine: ANCHOR_LINE,
            excerpt: "yield* mutate()"
          },
          recommendation: "Authorize first.",
          anchor: {
            _tag: "line",
            path: ANCHOR_PATH,
            line: ANCHOR_LINE
          },
          relatedLocations: [],
          replacement: {
            reviewedHead: SUBJECT.headRevision,
            unifiedDiff: [
              "diff --git a/src/authorization.ts b/src/authorization.ts",
              "index 1111111..2222222 100644",
              "--- a/src/authorization.ts",
              "+++ b/src/authorization.ts",
              "@@ -42,1 +42,2 @@",
              "-yield* mutate()",
              "+yield* authorize()",
              "+yield* mutate()",
              "@@ -45,1 +45,1 @@",
              "-counter",
              "+++ counter",
              "diff --git a/src/literal.ts b/src/literal.ts",
              "index 3333333..4444444 100644",
              "--- a/src/literal.ts",
              "+++ b/src/literal.ts",
              "@@ -50,1 +51,1 @@",
              "---- literal source",
              "++++ literal source",
              "\\ No newline at end of file"
            ].join("\n"),
            explanation: "Authorize before the mutation."
          },
          prevention: {
            summary: "Block mutation-before-authorization",
            enforcement: "ast-grep",
            existingRuleOrConfig: "no-mutation-before-authorization",
            recurrenceEvidence: "The ordering defect has appeared in multiple handlers.",
            targetFile: "ast-grep/rules/security/no-mutation-before-authorization.yml",
            sourcePaths: ["packages/control-center/src/server"],
            matcherOrInvariant: "A mutation cannot precede the authorization effect.",
            invalidFixture: "yield* mutate()\nyield* authorize()",
            validFixture: "yield* authorize()\nyield* mutate()",
            boundary: "Exclude generated adapters; semantic aliases still require review."
          },
          confidence: {
            level: "high",
            reason: "The execution order is explicit."
          }
        },
        {
          suggestionId: FILE_SUGGESTION_ID,
          state: "resolved",
          title: "Centralize the authorization policy",
          severity: "P1",
          problem: "The file repeats the same policy branch.",
          impact: "Future changes can drift.",
          evidence: {
            path: ANCHOR_PATH,
            startLine: 50,
            endLine: 50,
            excerpt: "yield* authorizeAgain()"
          },
          recommendation: "Use the shared policy helper.",
          anchor: {
            _tag: "file",
            path: ANCHOR_PATH,
            line: 40
          },
          relatedLocations: [
            {
              path: "src/handler.ts",
              startLine: 18,
              endLine: 18,
              label: "Same policy branch"
            }
          ],
          replacement: {
            reviewedHead: SUBJECT.headRevision,
            unifiedDiff: [
              "--- a/src/authorization.ts",
              "+++ b/src/authorization.ts",
              "@@ -50,1 +50,1 @@",
              "-yield* authorizeAgain()",
              "+yield* authorizeShared()"
            ].join("\n"),
            explanation: "Use the shared authorization helper."
          },
          prevention: {
            summary: "No stable automated check",
            enforcement: "none",
            rationale: "The semantic equivalence still requires reviewer judgment."
          },
          confidence: {
            level: "medium",
            reason: "The duplicate branches are directly visible."
          }
        }
      ],
      notes: [
        {
          noteId: `sha256:${"5".repeat(64)}`,
          reason: "low-confidence",
          title: "Retry behavior needs a provider reproduction",
          observation: "The first error may be obscured, but the local fixture cannot prove it.",
          confidence: {
            level: "low",
            reason: "Provider behavior is unavailable in the sandbox."
          },
          location: {
            path: "src/retry.ts",
            startLine: 12,
            endLine: 12
          }
        }
      ]
    }
  })
} satisfies PullRequestReviewControllerState

const REVIEW_THREAD = Schema.decodeUnknownSync(PullRequestReviewThreadPage)({
  events: [
    {
      _tag: "operator-message",
      eventSequence: 1,
      jobId: JOB_ID,
      occurredAt: "2026-07-24T15:00:00.000Z",
      prompt: "Focus on transaction ownership."
    }
  ],
  hasMore: false,
  nextCursor: ReleaseAgentThreadCursor.make(1)
})
const REFRESHED_NOT_STARTED_STATE = {
  ...REVIEW_STATE,
  baseRevision: "3".repeat(40),
  headRevision: "4".repeat(40),
  review: Schema.decodeUnknownSync(PullRequestReviewState)({
    _tag: "not-started",
    subject: {
      ...SUBJECT,
      baseRevision: "3".repeat(40),
      headRevision: "4".repeat(40)
    }
  })
} satisfies PullRequestReviewControllerState

let root: Root | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

describe("PullRequestReviewPanel", () => {
  it("does not offer a targeted run when the current pull request is unavailable", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <PullRequestReviewPanel
          canEnqueue
          onCancelPublication={() => undefined}
          onPreviewPublication={() => undefined}
          onPublishSuggestion={() => undefined}
          onRetry={() => undefined}
          onStart={() => undefined}
          publication={{ _tag: "idle" }}
          state={{
            ...REVIEW_STATE,
            review: new PullRequestReviewUnavailable({ reason: "source-stale" })
          }}
        />
      )
    )

    expect(host.textContent).toContain("Review unavailable")
    expect(host.textContent).not.toContain("Start targeted review")
  })

  it("shows durable operator context and starts a targeted follow-up", async () => {
    const onStart = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <PullRequestReviewPanel
          canEnqueue
          onCancelPublication={() => undefined}
          onPreviewPublication={() => undefined}
          onPublishSuggestion={() => undefined}
          onRetry={() => undefined}
          onStart={onStart}
          publication={{ _tag: "idle" }}
          state={{ ...REVIEW_STATE, thread: REVIEW_THREAD }}
        />
      )
    )

    expect(host.textContent).toContain("Durable across pull-request heads")
    expect(host.textContent).toContain("Local Operator · Focus on transaction ownership.")
    const textarea = host.querySelector<HTMLTextAreaElement>("#review-thread-request")
    if (textarea === null) throw new Error("Expected targeted review request")
    expect(textarea.maxLength).toBe(MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH)
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      if (valueSetter === undefined) throw new Error("Expected textarea value setter")
      valueSetter.call(textarea, "Re-check the transaction boundary.")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const start = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Start targeted review"
    )
    if (start === undefined) throw new Error("Expected targeted review action")
    await act(async () => start.click())

    expect(onStart).toHaveBeenCalledWith("Re-check the transaction boundary.")
    expect(textarea.value).toBe("")
  })

  it("preserves a draft within one immutable head and clears it when the reviewed head changes", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    const render = (state: PullRequestReviewControllerState) =>
      root?.render(
        <PullRequestReviewPanel
          canEnqueue
          onCancelPublication={() => undefined}
          onPreviewPublication={() => undefined}
          onPublishSuggestion={() => undefined}
          onRetry={() => undefined}
          onStart={() => undefined}
          publication={{ _tag: "idle" }}
          state={state}
        />
      )

    await act(async () => render({ ...REVIEW_STATE, thread: REVIEW_THREAD }))
    const textarea = host.querySelector<HTMLTextAreaElement>("#review-thread-request")
    if (textarea === null) throw new Error("Expected targeted review request")
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      if (valueSetter === undefined) throw new Error("Expected textarea value setter")
      valueSetter.call(textarea, "Keep this draft on the same head.")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })

    await act(async () =>
      render({
        ...REVIEW_STATE,
        thread: {
          events: [...REVIEW_THREAD.events, ...REVIEW_THREAD.events],
          nextCursor: ReleaseAgentThreadCursor.make(2)
        }
      })
    )
    expect(host.querySelector<HTMLTextAreaElement>("#review-thread-request")?.value).toBe(
      "Keep this draft on the same head."
    )

    await act(async () => render(REFRESHED_NOT_STARTED_STATE))
    expect(host.querySelector<HTMLTextAreaElement>("#review-thread-request")?.value).toBe("")
  })

  it("clears the targeted draft and launch dialog when the authenticated session changes", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    const render = (state: PullRequestReviewControllerState) =>
      root?.render(
        <PullRequestReviewPanel
          canEnqueue
          onCancelPublication={() => undefined}
          onPreviewPublication={() => undefined}
          onPublishSuggestion={() => undefined}
          onRetry={() => undefined}
          onStart={() => undefined}
          publication={{ _tag: "idle" }}
          state={state}
        />
      )

    await act(async () => render(REFRESHED_NOT_STARTED_STATE))
    const textarea = host.querySelector<HTMLTextAreaElement>("#review-thread-request")
    if (textarea === null) throw new Error("Expected targeted review request")
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      if (valueSetter === undefined) throw new Error("Expected textarea value setter")
      valueSetter.call(textarea, "Private draft for session A.")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const launch = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Review exact head"
    )
    if (launch === undefined) throw new Error("Expected review launch action")
    await act(async () => launch.click())
    expect(host.querySelector("[role=dialog]")).not.toBeNull()

    await act(async () => render({ ...REFRESHED_NOT_STARTED_STATE, sessionKey: "session-b" }))

    expect(host.querySelector<HTMLTextAreaElement>("#review-thread-request")?.value).toBe("")
    expect(host.querySelector("[role=dialog]")).toBeNull()
  })

  it("separates non-publishable notes and presents grouped file advice with replacement context", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <PullRequestReviewPanel
          canEnqueue
          onCancelPublication={() => undefined}
          onPreviewPublication={() => undefined}
          onPublishSuggestion={() => undefined}
          onRetry={() => undefined}
          onStart={() => undefined}
          publication={{ _tag: "idle" }}
          state={REVIEW_STATE}
        />
      )
    )

    expect(host.textContent).toContain("File suggestion")
    expect(host.textContent).toContain("Related locations")
    expect(host.textContent).toContain("src/handler.ts:18")
    expect(host.textContent).toContain("Suggested replacement")
    expect(host.textContent).toContain("Authorize before the mutation.")
    expect(host.textContent).toContain("Draft · high confidence")
    expect(host.textContent).toContain("Block mutation-before-authorization")
    expect(host.textContent).toContain("no-mutation-before-authorization")
    expect(host.textContent).toContain("The ordering defect has appeared")
    expect(host.textContent).toContain("ast-grep/rules/security/no-mutation-before-authorization.yml")
    expect(host.textContent).toContain("packages/control-center/src/server")
    expect(host.textContent).toContain("A mutation cannot precede")
    expect(host.textContent).toContain("yield* mutate()")
    expect(host.textContent).toContain("yield* authorize()")
    expect(host.textContent).toContain("Exclude generated adapters")
    expect(host.textContent).toContain("Resolved · medium confidence")
    expect(host.textContent).toContain("No stable automated check")
    expect(host.textContent).toContain("semantic equivalence still requires reviewer judgment")
    const replacements = host.querySelectorAll<HTMLElement>("[aria-label='Suggested replacement']")
    expect(replacements).toHaveLength(2)
    expect(replacements[0]?.textContent).not.toContain("diff --git")
    expect(replacements[0]?.textContent).not.toContain("index 1111111")
    expect(replacements[0]?.querySelectorAll("pre")[0]?.textContent).toContain("yield* mutate()")
    expect(replacements[0]?.querySelectorAll("pre")[0]?.textContent).toContain("--- literal source")
    expect(replacements[0]?.querySelectorAll("pre")[1]?.textContent).toContain("yield* authorize()")
    expect(replacements[0]?.querySelectorAll("pre")[1]?.textContent).toContain("++ counter")
    expect(replacements[0]?.querySelectorAll("pre")[1]?.textContent).toContain("+++ literal source")
    expect(replacements[0]?.querySelectorAll("pre")[0]?.textContent).toContain(
      "src/authorization.ts · @@ -42,1 +42,2 @@"
    )
    expect(replacements[0]?.querySelectorAll("pre")[1]?.textContent).toContain(
      "src/authorization.ts · @@ -42,1 +42,2 @@"
    )
    expect(replacements[0]?.querySelectorAll("pre")[0]?.textContent).toContain("src/literal.ts · @@ -50,1 +51,1 @@")
    expect(replacements[0]?.querySelectorAll("pre")[1]?.textContent).toContain("src/literal.ts · @@ -50,1 +51,1 @@")
    expect(replacements[1]?.querySelectorAll("pre")[0]?.textContent).toContain(
      "src/authorization.ts · @@ -50,1 +50,1 @@"
    )
    expect(replacements[1]?.textContent).toContain("yield* authorizeShared()")
    expect(host.textContent).toContain("Review Notes")
    expect(host.textContent).toContain("Never publishable")
    expect(host.textContent).toContain("Retry behavior needs a provider reproduction")
    expect(
      [...host.querySelectorAll("li")]
        .find(({ textContent }) => textContent?.includes("Centralize the authorization policy"))
        ?.querySelector("button")
    ).toBeNull()
  })

  it("offers publication for a draft file suggestion", async () => {
    if (REVIEW_STATE.review._tag !== "completed") {
      throw new Error("Expected completed review fixture")
    }
    const onPreview = vi.fn()
    const fileDraftReview: PullRequestReviewState = {
      ...REVIEW_STATE.review,
      report: {
        ...REVIEW_STATE.review.report,
        suggestions: REVIEW_STATE.review.report.suggestions.map((suggestion) => {
          if (suggestion.suggestionId !== FILE_SUGGESTION_ID) return suggestion
          const draft: typeof suggestion = { ...suggestion, state: "draft" }
          return draft
        })
      }
    }
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <PullRequestReviewPanel
          canEnqueue
          onCancelPublication={() => undefined}
          onPreviewPublication={onPreview}
          onPublishSuggestion={() => undefined}
          onRetry={() => undefined}
          onStart={() => undefined}
          publication={{ _tag: "idle" }}
          state={{ ...REVIEW_STATE, review: fileDraftReview }}
        />
      )
    )
    const fileSuggestion = [...host.querySelectorAll<HTMLElement>("article")].find(({ textContent }) =>
      textContent?.includes("Centralize the authorization policy")
    )
    const publish = [...(fileSuggestion?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      ({ textContent }) => textContent === "Post comment"
    )
    if (publish === undefined) throw new Error("Expected file-suggestion publication action")
    await act(async () => publish.click())
    expect(onPreview).toHaveBeenCalledWith({
      jobId: JOB_ID,
      suggestionId: FILE_SUGGESTION_ID
    })
  })

  it("previews an exact suggestion and requires an editable human confirmation", async () => {
    const onPreview = vi.fn()
    const onPublish = vi.fn()
    const onCancel = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    const render = async (publication: Parameters<typeof PullRequestReviewPanel>[0]["publication"]) =>
      act(async () =>
        root?.render(
          <PullRequestReviewPanel
            canEnqueue
            onCancelPublication={onCancel}
            onPreviewPublication={onPreview}
            onPublishSuggestion={onPublish}
            onRetry={() => undefined}
            onStart={() => undefined}
            publication={publication}
            state={REVIEW_STATE}
          />
        )
      )

    await render({ _tag: "idle" })
    const postComment = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Post comment"
    )
    if (postComment === undefined) throw new Error("Expected a publication preview action")
    await act(async () => {
      postComment.focus()
      postComment.click()
    })
    expect(onPreview).toHaveBeenCalledWith({ jobId: JOB_ID, suggestionId: SUGGESTION_ID })
    expect(onPublish).not.toHaveBeenCalled()

    await render({ _tag: "preview", preview: PREVIEW })
    await act(async () => vi.dynamicImportSettled())
    expect(host.querySelector("[role=dialog]")).not.toBeNull()
    expect(host.querySelector("[role=dialog]")?.getAttribute("aria-modal")).toBe("true")
    expect(host.textContent).toContain(PREVIEW.connectedIdentity.arn)
    expect(host.textContent).toContain(`${ANCHOR_PATH}:${String(ANCHOR_LINE)} · AFTER`)
    expect(host.textContent).toContain(SUBJECT.headRevision)
    expect(host.textContent).toContain("Required publication footer")

    const textarea = host.querySelector<HTMLTextAreaElement>("[role=dialog] textarea")
    if (textarea === null) throw new Error("Expected editable publication content")
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      if (valueSetter === undefined) throw new Error("Expected textarea value setter")
      valueSetter.call(textarea, "Edited operator comment.")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const confirm = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Post to CodeCommit"
    )
    if (confirm === undefined) throw new Error("Expected explicit publication confirmation")
    await act(async () => confirm.click())
    expect(onPublish).toHaveBeenCalledWith(`Edited operator comment.\n\n${PUBLICATION_FOOTER}`)

    const dialog = host.querySelector<HTMLElement>("[role=dialog]")
    if (dialog === null) throw new Error("Expected publication dialog")
    await act(async () => {
      confirm.focus()
      confirm.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Tab"
        })
      )
    })
    expect(document.activeElement).toBe(textarea)
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape"
        })
      )
    })
    expect(onCancel).toHaveBeenCalledOnce()

    await render({
      _tag: "published",
      headSuperseded: false,
      preview: PREVIEW,
      publication: PUBLICATION
    })
    await act(async () => vi.dynamicImportSettled())
    expect(document.activeElement).toBe(postComment)
  })

  it("renders the durable provider receipt after publication", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <PullRequestReviewPanel
          canEnqueue
          onCancelPublication={() => undefined}
          onPreviewPublication={() => undefined}
          onPublishSuggestion={() => undefined}
          onRetry={() => undefined}
          onStart={() => undefined}
          publication={{
            _tag: "published",
            headSuperseded: false,
            preview: PREVIEW,
            publication: PUBLICATION
          }}
          state={REVIEW_STATE}
        />
      )
    )
    await act(async () => vi.dynamicImportSettled())

    expect(host.textContent).toContain("Published Review Comment")
    expect(host.textContent).toContain(RECEIPT.safeSummary)
    expect(host.textContent).toContain(RECEIPT.providerOperationId)
    expect(host.textContent).toContain(`${ANCHOR_PATH}:${String(ANCHOR_LINE)}`)
  })

  it("shows the persisted relative file version in deletion-only previews and receipts", async () => {
    const beforePreview = new ReviewSuggestionPublicationPreview({
      ...PREVIEW,
      anchor: {
        _tag: "file",
        path: ANCHOR_PATH,
        line: ANCHOR_LINE,
        relativeFileVersion: "BEFORE"
      }
    })
    const beforePublication = new PublishedReviewComment({
      ...PUBLICATION,
      anchor: beforePreview.anchor
    })
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <PullRequestReviewPanel
          canEnqueue
          onCancelPublication={() => undefined}
          onPreviewPublication={() => undefined}
          onPublishSuggestion={() => undefined}
          onRetry={() => undefined}
          onStart={() => undefined}
          publication={{ _tag: "preview", preview: beforePreview }}
          state={REVIEW_STATE}
        />
      )
    )
    expect(host.textContent).toContain(`${ANCHOR_PATH}:${String(ANCHOR_LINE)} · BEFORE`)

    await act(async () =>
      root?.render(
        <PullRequestReviewPanel
          canEnqueue
          onCancelPublication={() => undefined}
          onPreviewPublication={() => undefined}
          onPublishSuggestion={() => undefined}
          onRetry={() => undefined}
          onStart={() => undefined}
          publication={{
            _tag: "published",
            headSuperseded: false,
            preview: beforePreview,
            publication: beforePublication
          }}
          state={REVIEW_STATE}
        />
      )
    )
    expect(host.textContent).toContain(`${ANCHOR_PATH}:${String(ANCHOR_LINE)} · BEFORE`)
    expect(host.textContent).not.toContain(`${ANCHOR_PATH}:${String(ANCHOR_LINE)} · AFTER`)
  })

  it("keeps a superseded receipt visible after the refreshed head has no completed review", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <PullRequestReviewPanel
          canEnqueue
          onCancelPublication={() => undefined}
          onPreviewPublication={() => undefined}
          onPublishSuggestion={() => undefined}
          onRetry={() => undefined}
          onStart={() => undefined}
          publication={{
            _tag: "published",
            headSuperseded: true,
            preview: PREVIEW,
            publication: PUBLICATION
          }}
          state={REFRESHED_NOT_STARTED_STATE}
        />
      )
    )
    await act(async () => vi.dynamicImportSettled())

    expect(host.textContent).toContain("Agent review not run")
    expect(host.textContent).toContain("Published Review Comment")
    expect(host.textContent).toContain(RECEIPT.providerOperationId)
    expect(host.textContent).toContain("The comment was published against a head that is no longer current.")
    expect(host.querySelectorAll("[role=status]")).toHaveLength(1)
  })
})

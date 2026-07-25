// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AgentModelId,
  DurableAgentProviderId,
  PublishedReviewComment,
  PullRequestReviewState,
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
import { PrReviewSubject, PrReviewSuggestionId } from "../../src/domain/prReview.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000701")
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000702")
const SUGGESTION_ID = PrReviewSuggestionId.make(`sha256:${"7".repeat(64)}`)
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
    path: "src/authorization.ts",
    line: 42,
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
      schemaVersion: 2,
      subject: SUBJECT,
      completion: { status: "complete" },
      suggestions: [
        {
          suggestionId: SUGGESTION_ID,
          severity: "P1",
          problem: "Mutation happens before authorization",
          impact: "An unauthorized caller can mutate durable state.",
          evidence: {
            path: PREVIEW.anchor.path,
            startLine: PREVIEW.anchor.line,
            endLine: PREVIEW.anchor.line,
            excerpt: "yield* mutate()"
          },
          recommendation: "Authorize first.",
          replacement: {
            content: PREVIEW.replacement,
            startLine: PREVIEW.anchor.line,
            endLine: PREVIEW.anchor.line
          },
          confidence: {
            level: "high",
            reason: "The execution order is explicit."
          }
        }
      ]
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
    expect(host.textContent).toContain(`${PREVIEW.anchor.path}:${String(PREVIEW.anchor.line)} · AFTER`)
    expect(host.textContent).toContain(SUBJECT.headRevision)
    expect(host.textContent).toContain("Required publication footer")

    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")
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
    expect(host.textContent).toContain(`${PREVIEW.anchor.path}:${String(PREVIEW.anchor.line)}`)
  })
})

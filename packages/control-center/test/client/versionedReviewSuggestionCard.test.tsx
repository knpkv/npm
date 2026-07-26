// @vitest-environment happy-dom

import { PortalProvider } from "@knpkv/rly/foundations"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Schema from "effect/Schema"

import { VersionedReviewSuggestionCard } from "../../src/client/entities/VersionedReviewSuggestionCard.js"
import type { ReviewSuggestionRevisionTransport } from "../../src/client/entities/useReviewSuggestionRevisions.js"
import { EntityId, JobId, PersonId, PrReviewSuggestionRevisionId } from "../../src/domain/identifiers.js"
import { PrReviewPath, PrReviewSubject, PrReviewSuggestion, PrReviewSuggestionId } from "../../src/domain/prReview.js"
import {
  PrReviewSuggestionRevisionPage,
  PrReviewSuggestionRevisionSequence
} from "../../src/domain/prReviewRevision.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000921")
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000922")
const PERSON_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000923")
const SUGGESTION_ID = PrReviewSuggestionId.make(`sha256:${"5".repeat(64)}`)
const SUBJECT = PrReviewSubject.make({
  providerId: "codecommit",
  repository: "control-center",
  pullRequestId: "279",
  baseRevision: "1".repeat(40),
  headRevision: "2".repeat(40)
})
const SUGGESTION = PrReviewSuggestion.make({
  suggestionId: SUGGESTION_ID,
  state: "draft",
  title: "Authorize before mutating",
  severity: "P2",
  problem: "The mutation precedes authorization.",
  impact: "An unauthorized caller can change state.",
  evidence: {
    path: PrReviewPath.make("src/authorization.ts"),
    startLine: 42,
    endLine: 42,
    excerpt: "yield* mutate()"
  },
  recommendation: "Authorize first.",
  anchor: {
    _tag: "line",
    path: PrReviewPath.make("src/authorization.ts"),
    line: 42,
    relativeFileVersion: "AFTER"
  },
  relatedLocations: [],
  confidence: {
    level: "high",
    reason: "The execution order is explicit."
  }
})

const revisionPage = (
  sequence: 1 | 2,
  title: string,
  validation: "requires-revalidation" | "validated" = "validated",
  suggestion = SUGGESTION
) => {
  const revisionId = PrReviewSuggestionRevisionId.make(`sha256:${String(sequence).repeat(64)}`)
  const originalId = PrReviewSuggestionRevisionId.make(`sha256:${"1".repeat(64)}`)
  const revision = {
    revisionId,
    sequence,
    predecessorRevisionId: sequence === 1 ? null : originalId,
    sourceJobId: JOB_ID,
    subject: SUBJECT,
    suggestion: { ...suggestion, title },
    validation:
      validation === "validated"
        ? {
            _tag: "validated",
            reviewedHead: SUBJECT.headRevision,
            validatingJobId: JOB_ID,
            sourceRevisionId: revisionId
          }
        : {
            _tag: "requires-revalidation",
            reviewedHead: SUBJECT.headRevision,
            sourceRevisionId: originalId,
            reason: "technical-claim-edited"
          },
    author: {
      _tag: "operator",
      personId: PERSON_ID
    },
    createdAt: "2026-07-26T20:00:00.000Z"
  }
  return Schema.decodeUnknownSync(PrReviewSuggestionRevisionPage)({
    current: revision,
    revisions: [revision],
    hasMore: false,
    nextBeforeSequence: null
  })
}

let root: Root | null = null

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
})

const renderCard = async (
  transport: ReviewSuggestionRevisionTransport,
  onPreviewPublication = () => undefined
): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <PortalProvider>
        <VersionedReviewSuggestionCard
          canEdit
          entityId={ENTITY_ID}
          isPreviewing={false}
          jobId={JOB_ID}
          onPreviewPublication={onPreviewPublication}
          revisionTransport={transport}
          sessionKey="session-a"
          suggestion={SUGGESTION}
        />
      </PortalProvider>
    )
  )
  return host
}

const click = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    ({ textContent }) => textContent === label
  )
  if (button === undefined) throw new Error(`Button missing: ${label}`)
  await act(async () => button.click())
}

describe("VersionedReviewSuggestionCard", () => {
  it("shows durable metadata and saves a complete compare-and-append edit", async () => {
    const original = revisionPage(1, SUGGESTION.title)
    const updated = revisionPage(2, "Authorize before changing durable state")
    const edit = vi.fn(() => Promise.resolve(updated.current))
    const transport: ReviewSuggestionRevisionTransport = {
      load: vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(updated),
      edit
    }
    const host = await renderCard(transport)
    expect(host.textContent).toContain("Revision 1")
    expect(host.textContent).toContain("Validated")
    expect([...host.querySelectorAll("span")].some(({ textContent }) => textContent === "Operator")).toBe(true)
    expect([...host.querySelectorAll("span")].some(({ textContent }) => textContent === "You")).toBe(false)
    await click("Edit")
    const title = document.querySelector<HTMLInputElement>("input")
    if (title === null) throw new Error("Title editor missing")
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      setter?.call(title, "Authorize before changing durable state")
      title.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await click("Save revision")

    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: ENTITY_ID,
        jobId: JOB_ID,
        suggestionId: SUGGESTION_ID
      }),
      expect.objectContaining({
        expectedRevisionId: original.current.revisionId,
        expectedSequence: PrReviewSuggestionRevisionSequence.make(1),
        edit: expect.objectContaining({
          title: "Authorize before changing durable state",
          anchor: SUGGESTION.anchor,
          evidence: SUGGESTION.evidence
        })
      }),
      expect.any(AbortSignal)
    )
  })

  it("previews the exact revision displayed on the card", async () => {
    const original = revisionPage(1, SUGGESTION.title)
    const onPreviewPublication = vi.fn()
    await renderCard(
      {
        load: () => Promise.resolve(original),
        edit: () => Promise.reject(new Error("Unexpected edit"))
      },
      onPreviewPublication
    )
    await click("Post comment")

    expect(onPreviewPublication).toHaveBeenCalledWith({
      jobId: JOB_ID,
      revisionId: original.current.revisionId,
      suggestionId: SUGGESTION_ID
    })
  })

  it("removes mutation and publication controls when the parent lifecycle becomes published", async () => {
    const original = revisionPage(1, SUGGESTION.title)
    const transport: ReviewSuggestionRevisionTransport = {
      load: () => Promise.resolve(original),
      edit: () => Promise.reject(new Error("Unexpected edit"))
    }
    const host = await renderCard(transport)
    await act(async () => undefined)
    expect(host.textContent).toContain("Draft")
    expect(host.textContent).toContain("Post comment")
    await act(async () =>
      root?.render(
        <PortalProvider>
          <VersionedReviewSuggestionCard
            canEdit
            entityId={ENTITY_ID}
            isPreviewing={false}
            jobId={JOB_ID}
            onPreviewPublication={() => undefined}
            revisionTransport={transport}
            sessionKey="session-a"
            suggestion={PrReviewSuggestion.make({
              ...SUGGESTION,
              state: "published"
            })}
          />
        </PortalProvider>
      )
    )

    expect(host.textContent).toContain("Published")
    expect([...host.querySelectorAll("button")].some(({ textContent }) => textContent === "Post comment")).toBe(false)
    expect([...host.querySelectorAll("button")].some(({ textContent }) => textContent === "Edit")).toBe(false)
    expect(host.textContent).toContain("History")
  })

  it("shows immutable history and blocks an unvalidated technical revision", async () => {
    const completeSuggestion = PrReviewSuggestion.make({
      ...SUGGESTION,
      relatedLocations: [
        {
          path: PrReviewPath.make("src/policy.ts"),
          startLine: 7,
          endLine: 9,
          label: "Shared authorization policy"
        }
      ],
      replacement: {
        reviewedHead: SUBJECT.headRevision,
        unifiedDiff: "--- a/src/authorization.ts\n+++ b/src/authorization.ts\n@@ -42,1 +42,1 @@\n-old\n+new",
        explanation: "Move authorization first."
      },
      prevention: {
        summary: "Reject mutation before authorization",
        enforcement: "test",
        existingRuleOrConfig: "authorization-order.test.ts",
        recurrenceEvidence: "The ordering defect reached review.",
        targetFile: PrReviewPath.make("test/authorization-order.test.ts"),
        sourcePaths: [PrReviewPath.make("src")],
        matcherOrInvariant: "Authorization completes before mutation.",
        invalidFixture: "mutate(); authorize()",
        validFixture: "authorize(); mutate()",
        boundary: "Runtime ordering remains behavioral."
      }
    })
    const unvalidated = revisionPage(2, "Changed technical claim", "requires-revalidation", completeSuggestion)
    const host = await renderCard({
      load: () => Promise.resolve(unvalidated),
      edit: () => Promise.reject(new Error("Unexpected edit"))
    })
    expect(host.textContent).toContain("Needs revalidation")
    expect(host.textContent).toContain("needs agent revalidation before it can be posted")
    const publish = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Post comment"
    )
    expect(publish?.disabled).toBe(true)
    await click("History")
    expect(document.body.textContent).toContain("Revision history")
    expect(document.body.textContent).toContain("Changed technical claim")
    expect(document.body.textContent).toContain("The execution order is explicit.")
    expect(document.body.textContent).toContain("yield* mutate()")
    expect(document.body.textContent).toContain("Shared authorization policy")
    expect(document.body.textContent).toContain("Move authorization first.")
    expect(document.body.textContent).toContain("Reject mutation before authorization")
  })

  it("keeps a cross-field-invalid complete edit in the dialog", async () => {
    const protectedSuggestion = PrReviewSuggestion.make({
      ...SUGGESTION,
      prevention: {
        summary: "Reject mutation before authorization",
        enforcement: "test",
        existingRuleOrConfig: "authorization-order.test.ts",
        recurrenceEvidence: "The ordering defect reached review.",
        targetFile: PrReviewPath.make("test/authorization-order.test.ts"),
        sourcePaths: [PrReviewPath.make("src")],
        matcherOrInvariant: "Authorization completes before mutation.",
        invalidFixture: "mutate(); authorize()",
        validFixture: "authorize(); mutate()",
        boundary: "Runtime ordering remains behavioral."
      }
    })
    const original = revisionPage(1, protectedSuggestion.title, "validated", protectedSuggestion)
    const edit = vi.fn(() => Promise.resolve(original.current))
    await renderCard({
      load: () => Promise.resolve(original),
      edit
    })
    await click("Edit")
    const severity = document.querySelector<HTMLSelectElement>("select")
    if (severity === null) throw new Error("Severity editor missing")
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
      setter?.call(severity, "P3")
      severity.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await click("Save revision")

    expect(edit).not.toHaveBeenCalled()
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "Advanced fields are not a valid complete suggestion"
    )
  })

  it("preserves the operator draft when a concurrent revision wins", async () => {
    const original = revisionPage(1, SUGGESTION.title)
    const winner = revisionPage(2, "Another edit won")
    const transport: ReviewSuggestionRevisionTransport = {
      load: vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(winner),
      edit: () => Promise.reject({ _tag: "ConflictApiError" })
    }
    await renderCard(transport)
    await click("Edit")
    const title = document.querySelector<HTMLInputElement>("input")
    if (title === null) throw new Error("Title editor missing")
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      setter?.call(title, "Keep my local edit")
      title.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await click("Save revision")
    await act(async () => undefined)

    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("Keep my local edit")
    expect(document.body.textContent).toContain("A newer revision won")
  })
})

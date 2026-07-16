// @vitest-environment happy-dom

import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SessionSummary } from "../../src/api/session.js"
import type {
  ApplyRelationshipRepairProposalResponse,
  RelationshipRepairProposalList
} from "../../src/api/deliveryGraph.js"
import {
  type RelationshipRepairPanelState,
  type RelationshipRepairProposalController,
  useRelationshipRepairProposals
} from "../../src/client/releases/useRelationshipRepairProposals.js"
import { RelationshipRepairPanelView } from "../../src/client/releases/RelationshipRepairPanel.js"
import {
  makeRelationshipRepairReviewId,
  type RelationshipRepairTransport
} from "../../src/client/releases/relationshipRepairTransport.js"
import { presentPortfolio } from "../../src/client/portfolio/presentPortfolio.js"
import type { RelationshipRepairApplication } from "../../src/domain/relationshipRepair.js"
import { RelationshipRepairProposal } from "../../src/domain/relationshipRepair.js"
import { RelationshipRepairProposalId, RelationshipRepairReviewId, ReleaseId } from "../../src/domain/identifiers.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const snapshot = makePortfolioSnapshot()
const release = presentPortfolio(snapshot).releases[0]
if (release === undefined) throw new Error("Expected a release fixture")

const proposal = Schema.decodeUnknownSync(RelationshipRepairProposal)({
  schemaVersion: 2,
  proposalId: "01890f6f-6d6a-7cc0-98d2-000000000081",
  workspaceId: snapshot.workspaceId,
  releaseId: release.id,
  environmentId: null,
  relationshipId: "01890f6f-6d6a-7cc0-98d2-000000000082",
  expectedRevision: 4,
  disposition: "verify",
  rationale: "The pull request and production execution share immutable evidence.",
  origin: {
    actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000021" },
    sessionId: "01890f6f-6d6a-7cc0-98d2-000000000091"
  },
  status: "pending",
  proposedAt: "2026-07-14T10:00:00.000Z",
  review: null
})

const reviewIdA = Schema.decodeSync(RelationshipRepairReviewId)("01890f6f-6d6a-7cc0-98d2-000000000083")
const reviewIdB = Schema.decodeSync(RelationshipRepairReviewId)("01890f6f-6d6a-7cc0-98d2-000000000085")

const session = Schema.decodeUnknownSync(SessionSummary)({
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000092",
  workspaceId: snapshot.workspaceId,
  actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000022" },
  permission: "workspace-approver",
  createdAt: "2026-07-14T09:00:00.000Z",
  lastSeenAt: "2026-07-14T10:00:00.000Z",
  idleExpiresAt: "2026-07-14T11:00:00.000Z",
  absoluteExpiresAt: "2026-07-15T09:00:00.000Z",
  revokedAt: null
})

const readyState = (
  currentProposal: RelationshipRepairProposal = proposal,
  application?: RelationshipRepairApplication
): RelationshipRepairPanelState => ({
  _tag: "ready",
  actionFailure: null,
  applications: application === undefined ? new Map() : new Map([[currentProposal.proposalId, application]]),
  busyProposalId: null,
  page: {
    releaseId: release.id,
    environmentId: null,
    status: null,
    truncated: false,
    proposals: [currentProposal]
  },
  releaseId: release.id,
  sessionKey: session.sessionId
})

let mountedRoot: Root | undefined

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

const view = (
  state: RelationshipRepairPanelState,
  currentSession: SessionSummary = session,
  onApply = vi.fn(async () => true),
  onReview = vi.fn(async () => true)
) => (
  <RelationshipRepairPanelView
    onApply={onApply}
    onRetry={vi.fn()}
    onReview={onReview}
    release={release}
    session={currentSession}
    state={state}
  />
)

let currentController: RelationshipRepairProposalController | undefined

const deferred = <Value,>() => {
  let resolveValue: ((value: Value) => void) | undefined
  let rejectValue: ((reason: unknown) => void) | undefined
  const promise = new Promise<Value>((resolve, reject) => {
    resolveValue = resolve
    rejectValue = reject
  })
  return {
    promise,
    reject: (reason: unknown): void => {
      if (rejectValue === undefined) throw new Error("Deferred rejection unavailable")
      rejectValue(reason)
    },
    resolve: (value: Value): void => {
      if (resolveValue === undefined) throw new Error("Deferred resolution unavailable")
      resolveValue(value)
    }
  }
}

const ControllerHarness = ({
  releaseId,
  transport
}: {
  readonly releaseId: ReleaseId
  readonly transport: RelationshipRepairTransport
}): ReactElement => {
  currentController = useRelationshipRepairProposals(releaseId, session.sessionId, transport)
  return <span>{currentController.state._tag === "ready" ? currentController.state.page.releaseId : "loading"}</span>
}

describe("RelationshipRepairPanel", () => {
  it("shows one compact, human-attributed revision decision", () => {
    const markup = renderToStaticMarkup(view(readyState()))
    expect(markup).toContain("Verify")
    expect(markup).toContain("r4 → r5")
    expect(markup).toContain("Needs review")
    expect(markup).toContain("Avery Bell")
    expect(markup).toContain("Review proposal")
    expect(markup).not.toContain("Apply repair")
  })

  it("makes approved proposals actionable only for a workspace owner", () => {
    const approved = RelationshipRepairProposal.make({
      ...proposal,
      status: "approved",
      review: {
        reviewId: Schema.decodeSync(RelationshipRepairReviewId)("01890f6f-6d6a-7cc0-98d2-000000000083"),
        decision: "approved",
        rationale: "Evidence matches the exact release.",
        origin: { actor: session.actor, sessionId: session.sessionId },
        reviewedAt: session.lastSeenAt
      }
    })
    const approverMarkup = renderToStaticMarkup(view(readyState(approved)))
    expect(approverMarkup).toContain("Ready to apply")
    expect(approverMarkup).not.toContain("Apply repair")

    const owner = SessionSummary.make({ ...session, permission: "workspace-owner" })
    const ownerMarkup = renderToStaticMarkup(view(readyState(approved), owner))
    expect(ownerMarkup).toContain("Apply repair")
    expect(ownerMarkup).toContain("Mara Singh")
  })

  it("disables every other row while one global proposal action is running", () => {
    const secondProposal = RelationshipRepairProposal.make({
      ...proposal,
      proposalId: Schema.decodeSync(RelationshipRepairProposalId)("01890f6f-6d6a-7cc0-98d2-000000000084")
    })
    const current = readyState()
    if (current._tag !== "ready") throw new Error("Expected ready state")
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(
      view({
        ...current,
        busyProposalId: proposal.proposalId,
        page: { ...current.page, proposals: [proposal, secondProposal] }
      })
    )
    const reviewButtons = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) => button.textContent === "Review proposal"
    )
    expect(reviewButtons).toHaveLength(2)
    expect(reviewButtons.every((button) => button.disabled)).toBe(true)
  })

  it("records the selected review with a required human note", async () => {
    const onReview = vi.fn(async () => true)
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => mountedRoot?.render(view(readyState(), session, undefined, onReview)))

    const reviewButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Review proposal"
    )
    if (reviewButton === undefined) throw new Error("Expected review action")
    await act(async () => reviewButton.click())
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")
    if (textarea === null) throw new Error("Expected review note")
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      if (valueSetter === undefined) throw new Error("Expected textarea value setter")
      valueSetter.call(textarea, "Matches release evidence.")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const approveButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Approve"
    )
    if (approveButton === undefined) throw new Error("Expected approve action")
    await act(async () => approveButton.click())
    expect(onReview).toHaveBeenCalledWith(proposal.proposalId, "approved", "Matches release evidence.")
    expect(host.querySelector("textarea")).toBeNull()
    expect(document.activeElement?.textContent).toContain("Proposal approved.")
  })

  it("keeps the review note and offers reload when recording fails", async () => {
    const onReview = vi.fn(async () => false)
    const onRetry = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    const failedState = readyState()
    if (failedState._tag !== "ready") throw new Error("Expected ready failure state")
    await act(async () =>
      mountedRoot?.render(
        <RelationshipRepairPanelView
          onApply={vi.fn(async () => true)}
          onRetry={onRetry}
          onReview={onReview}
          release={release}
          session={session}
          state={{ ...failedState, actionFailure: proposal.proposalId }}
        />
      )
    )

    const reviewButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Review proposal"
    )
    if (reviewButton === undefined) throw new Error("Expected review action")
    await act(async () => reviewButton.click())
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")
    if (textarea === null) throw new Error("Expected review note")
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      if (valueSetter === undefined) throw new Error("Expected textarea value setter")
      valueSetter.call(textarea, "Keep this note.")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const approveButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Approve"
    )
    if (approveButton === undefined) throw new Error("Expected approve action")
    await act(async () => approveButton.click())
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Keep this note.")
    const reloadButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Reload decisions"
    )
    if (reloadButton === undefined) throw new Error("Expected reload action")
    await act(async () => reloadButton.click())
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("closes a stale review form when refreshed server state is immutable", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => mountedRoot?.render(view(readyState())))

    const reviewButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Review proposal"
    )
    if (reviewButton === undefined) throw new Error("Expected review action")
    await act(async () => reviewButton.click())
    expect(host.querySelector("textarea")).not.toBeNull()

    const reviewedProposal = RelationshipRepairProposal.make({
      ...proposal,
      status: "approved",
      review: {
        reviewId: reviewIdA,
        decision: "approved",
        rationale: "The server already recorded this decision.",
        origin: { actor: session.actor, sessionId: session.sessionId },
        reviewedAt: session.lastSeenAt
      }
    })
    await act(async () => mountedRoot?.render(view(readyState(reviewedProposal))))

    expect(host.querySelector("textarea")).toBeNull()
    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent === "Approve" || button.textContent === "Reject"
      )
    ).toBe(false)
    expect(host.textContent).toContain("Ready to apply")
  })

  it("suppresses stale releases and keeps a newer action lock when an aborted request settles late", async () => {
    const releaseB = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000012")
    const proposalB = RelationshipRepairProposal.make({
      ...proposal,
      proposalId: Schema.decodeSync(RelationshipRepairProposalId)("01890f6f-6d6a-7cc0-98d2-000000000084"),
      releaseId: releaseB
    })
    const pageA = deferred<RelationshipRepairProposalList>()
    const pageB = deferred<RelationshipRepairProposalList>()
    const applyA = deferred<ApplyRelationshipRepairProposalResponse>()
    const applyB = deferred<ApplyRelationshipRepairProposalResponse>()
    const pages = [pageA.promise, pageB.promise]
    const transport = {
      apply: vi.fn((proposalId: RelationshipRepairProposalId) =>
        proposalId === proposal.proposalId ? applyA.promise : applyB.promise
      ),
      list: vi.fn(() => {
        const next = pages.shift()
        return next ?? Promise.reject(new Error("Unexpected list request"))
      }),
      makeReviewId: vi.fn(() => Promise.resolve(reviewIdA)),
      review: vi.fn(() => Promise.resolve(proposal))
    } satisfies RelationshipRepairTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ControllerHarness releaseId={release.id} transport={transport} />))
    await act(async () =>
      pageA.resolve({
        releaseId: release.id,
        environmentId: null,
        status: null,
        truncated: false,
        proposals: [proposal]
      })
    )
    expect(host.textContent).toBe(release.id)
    if (currentController === undefined) throw new Error("Expected controller A")
    let firstAction: Promise<boolean> | undefined
    await act(async () => {
      firstAction = currentController?.apply(proposal.proposalId)
      await Promise.resolve()
    })
    if (firstAction === undefined) throw new Error("Expected first action")

    await act(async () => mountedRoot?.render(<ControllerHarness releaseId={releaseB} transport={transport} />))
    expect(host.textContent).toBe("loading")
    await act(async () =>
      pageB.resolve({
        releaseId: releaseB,
        environmentId: null,
        status: null,
        truncated: false,
        proposals: [proposalB]
      })
    )
    if (currentController === undefined) throw new Error("Expected controller B")
    let secondAction: Promise<boolean> | undefined
    await act(async () => {
      secondAction = currentController?.apply(proposalB.proposalId)
      await Promise.resolve()
    })
    if (secondAction === undefined) throw new Error("Expected second action")
    expect(currentController.state._tag === "ready" ? currentController.state.busyProposalId : null).toBe(
      proposalB.proposalId
    )

    let firstResult: boolean | undefined
    await act(async () => {
      applyA.reject(new Error("Late aborted request"))
      firstResult = await firstAction
    })
    expect(firstResult).toBe(false)
    expect(currentController.state._tag === "ready" ? currentController.state.busyProposalId : null).toBe(
      proposalB.proposalId
    )
    void secondAction
  })

  it("generates canonical browser review identifiers", () => {
    const reviewId = Effect.runSync(makeRelationshipRepairReviewId.pipe(Effect.provide(BrowserCrypto.layer)))
    expect(Schema.is(RelationshipRepairReviewId)(reviewId)).toBe(true)
  })

  it("reuses a review identifier after a lost response and rotates it for a fresh review", async () => {
    const reviewCalls: Array<RelationshipRepairReviewId> = []
    let reviewAttempt = 0
    const initialState = readyState()
    if (initialState._tag !== "ready") throw new Error("Expected ready state")
    const transport = {
      apply: vi.fn(() => Promise.reject(new Error("Unexpected apply"))),
      list: vi.fn(() => Promise.resolve(initialState.page)),
      makeReviewId: vi.fn(() => Promise.resolve(reviewAttempt < 2 ? reviewIdA : reviewIdB)),
      review: vi.fn((_proposalId: RelationshipRepairProposalId, reviewId: RelationshipRepairReviewId) => {
        reviewCalls.push(reviewId)
        reviewAttempt += 1
        return reviewAttempt === 1 ? Promise.reject(new Error("Response lost after commit")) : Promise.resolve(proposal)
      })
    } satisfies RelationshipRepairTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<ControllerHarness releaseId={release.id} transport={transport} />))
    await act(async () => Promise.resolve())
    if (currentController === undefined) throw new Error("Expected repair controller")

    let firstResult: boolean | undefined
    await act(async () => {
      firstResult = await currentController?.review(proposal.proposalId, "approved", "Same durable intent")
    })
    expect(firstResult).toBe(false)

    let retryResult: boolean | undefined
    await act(async () => {
      retryResult = await currentController?.review(proposal.proposalId, "approved", "Same durable intent")
    })
    expect(retryResult).toBe(true)

    await act(async () => {
      await currentController?.review(proposal.proposalId, "rejected", "A fresh decision")
    })
    expect(reviewCalls).toEqual([reviewIdA, reviewIdA, reviewIdB])
    expect(transport.makeReviewId).toHaveBeenCalledTimes(2)
  })
})

// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RelationshipRepairCandidates, RelationshipRepairProposalDraft } from "../../src/api/deliveryGraph.js"
import { SessionSummary } from "../../src/api/session.js"
import { RelationshipRepairCandidatePicker } from "../../src/client/releases/RelationshipRepairCandidatePicker.js"
import type { RelationshipRepairCandidateTransport } from "../../src/client/releases/relationshipRepairCandidateTransport.js"
import { LedgerRevision } from "../../src/domain/deliveryGraph.js"
import { RelationshipRepairProposalId, ReleaseId } from "../../src/domain/identifiers.js"
import { RelationshipRepairProposal } from "../../src/domain/relationshipRepair.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const releaseId = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-420000000002")
const proposalId = Schema.decodeSync(RelationshipRepairProposalId)("01890f6f-6d6a-7cc0-98d2-420000000030")

const owner = Schema.decodeUnknownSync(SessionSummary)({
  sessionId: "01890f6f-6d6a-7cc0-98d2-420000000040",
  workspaceId: "01890f6f-6d6a-7cc0-98d2-420000000001",
  actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-420000000041" },
  permission: "workspace-owner",
  createdAt: "2026-07-16T09:00:00.000Z",
  lastSeenAt: "2026-07-16T10:00:00.000Z",
  idleExpiresAt: "2026-07-16T11:00:00.000Z",
  absoluteExpiresAt: "2026-07-17T09:00:00.000Z",
  revokedAt: null
})

const candidates = Schema.decodeUnknownSync(RelationshipRepairCandidates)({
  releaseId,
  environmentId: null,
  truncated: false,
  candidates: [
    {
      relationship: {
        workspaceId: owner.workspaceId,
        relationshipId: "01890f6f-6d6a-7cc0-98d2-420000000010",
        relationshipSchemaVersion: 1,
        revision: 1,
        supersedesRevision: null,
        kind: "implements",
        sourceNodeId: "01890f6f-6d6a-7cc0-98d2-420000000011",
        sourceNodeKind: "pull-request",
        targetNodeId: "01890f6f-6d6a-7cc0-98d2-420000000012",
        targetNodeKind: "issue",
        scope: { _tag: "release", releaseId },
        lifecycle: {
          _tag: "inferred",
          effectiveAt: "2026-07-16T10:00:00.000Z"
        },
        confidence: {
          _tag: "inferred",
          score: 0.82,
          rationale: "The pull request references the issue key."
        },
        provenance: {
          _tag: "rule",
          ruleId: "issue-key-in-pr",
          ruleVersion: 1,
          rationale: "Issue key appears in pull request metadata."
        },
        recordedBy: { _tag: "system", component: "candidate-picker-test" },
        evidenceClaimIds: [],
        recordedAt: "2026-07-16T10:00:00.000Z"
      },
      suggestedDisposition: "verify",
      explanation: "The pull request references the issue key.",
      impact: { releaseId, environmentId: null },
      requiredPermission: "workspace-owner"
    }
  ]
})

const candidate = candidates.candidates[0]
if (candidate === undefined) throw new Error("Expected candidate fixture")

const draft = RelationshipRepairProposalDraft.make({
  candidate,
  precondition: {
    relationshipId: candidate.relationship.relationshipId,
    expectedRevision: candidate.relationship.revision
  },
  proposal: {
    disposition: candidate.suggestedDisposition,
    rationale: candidate.explanation
  }
})

const proposal = RelationshipRepairProposal.make({
  schemaVersion: 2,
  proposalId,
  workspaceId: owner.workspaceId,
  releaseId,
  environmentId: null,
  relationshipId: candidate.relationship.relationshipId,
  expectedRevision: candidate.relationship.revision,
  disposition: draft.proposal.disposition,
  rationale: draft.proposal.rationale,
  origin: { actor: owner.actor, sessionId: owner.sessionId },
  status: "pending",
  proposedAt: owner.lastSeenAt,
  review: null
})

let mountedRoot: Root | undefined

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

describe("RelationshipRepairCandidatePicker", () => {
  it("is owner-only and reuses one proposal identity when creation response is lost", async () => {
    const watcher = SessionSummary.make({ ...owner, permission: "watcher" })
    expect(
      renderToStaticMarkup(
        <RelationshipRepairCandidatePicker onCreated={vi.fn()} releaseId={releaseId} session={watcher} />
      )
    ).toBe("")

    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("Response lost after commit"))
      .mockResolvedValueOnce(proposal)
    const transport = {
      create,
      draft: vi.fn(() => Promise.resolve(draft)),
      list: vi.fn(() => Promise.resolve(candidates)),
      makeProposalId: vi.fn(() => Promise.resolve(proposalId))
    } satisfies RelationshipRepairCandidateTransport
    const onCreated = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () =>
      mountedRoot?.render(
        <RelationshipRepairCandidatePicker
          onCreated={onCreated}
          releaseId={releaseId}
          session={owner}
          transport={transport}
        />
      )
    )

    const click = async (label: string): Promise<void> => {
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.includes(label) === true
      )
      if (button === undefined) throw new Error(`Expected ${label} action`)
      await act(async () => {
        button.click()
        await Promise.resolve()
      })
    }

    await click("Find repair candidates")
    expect(host.textContent).toContain("pull request → issue")
    expect(document.activeElement).toBe(host.querySelector('[tabindex="-1"]'))
    await click("pull request → issue")
    expect(host.textContent).toContain("Proposal preview")
    expect(host.textContent).toContain("r1 → r2")

    await click("Create proposal")
    expect(host.textContent).toContain("not recorded")
    expect(document.activeElement).toBe(host.querySelector('[tabindex="-1"]'))
    await click("Create proposal")

    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls.map((call) => call[2])).toEqual([proposalId, proposalId])
    expect(transport.makeProposalId).toHaveBeenCalledOnce()
    expect(onCreated).toHaveBeenCalledOnce()
    expect(host.textContent).toContain("Proposal created")
    expect(host.querySelector('[role="status"]')).toBe(document.activeElement)
  })

  it("rediscovers a stale candidate before drafting its new revision", async () => {
    const revisionTwo = Schema.decodeSync(LedgerRevision)(2)
    const refreshedCandidate = {
      ...candidate,
      relationship: {
        ...candidate.relationship,
        revision: revisionTwo,
        supersedesRevision: candidate.relationship.revision
      }
    }
    const refreshedCandidates = RelationshipRepairCandidates.make({
      ...candidates,
      candidates: [refreshedCandidate]
    })
    const refreshedDraft = RelationshipRepairProposalDraft.make({
      candidate: refreshedCandidate,
      precondition: {
        relationshipId: refreshedCandidate.relationship.relationshipId,
        expectedRevision: revisionTwo
      },
      proposal: {
        disposition: refreshedCandidate.suggestedDisposition,
        rationale: refreshedCandidate.explanation
      }
    })
    const list = vi.fn().mockResolvedValueOnce(candidates).mockResolvedValueOnce(refreshedCandidates)
    const draftRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error("Revision advanced"))
      .mockResolvedValueOnce(refreshedDraft)
    const transport = {
      create: vi.fn(() => Promise.resolve(proposal)),
      draft: draftRequest,
      list,
      makeProposalId: vi.fn(() => Promise.resolve(proposalId))
    } satisfies RelationshipRepairCandidateTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () =>
      mountedRoot?.render(
        <RelationshipRepairCandidatePicker
          onCreated={vi.fn()}
          releaseId={releaseId}
          session={owner}
          transport={transport}
        />
      )
    )

    const click = async (label: string): Promise<void> => {
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.includes(label) === true
      )
      if (button === undefined) throw new Error(`Expected ${label} action`)
      await act(async () => {
        button.click()
        await Promise.resolve()
      })
    }

    await click("Find repair candidates")
    await click("pull request → issue")
    expect(host.textContent).toContain("Candidate is stale")
    await click("Refresh candidate")

    expect(list).toHaveBeenCalledTimes(2)
    expect(draftRequest.mock.calls.map((call) => call[2])).toEqual([candidate.relationship.revision, revisionTwo])
    expect(host.textContent).toContain("r2 → r3")
  })
})

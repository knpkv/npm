import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"

import { ReleaseDeliveryGraphInspection } from "../../src/api/deliveryGraph.js"
import type { DeliveryRelationship } from "../../src/domain/deliveryGraph.js"
import { deriveRelationshipRepairCandidates } from "../../src/server/application/deliveryGraphInspection.js"

const workspaceId = "01890f6f-6d6a-7cc0-98d2-410000000001"
const releaseId = "01890f6f-6d6a-7cc0-98d2-410000000002"

const relationship = (input: {
  readonly id: string
  readonly lifecycle:
    | { readonly _tag: "missing"; readonly effectiveAt: string; readonly reason: string }
    | { readonly _tag: "inferred"; readonly effectiveAt: string }
    | { readonly _tag: "governed"; readonly effectiveAt: string }
  readonly confidence:
    | { readonly _tag: "unknown"; readonly rationale: string }
    | { readonly _tag: "inferred"; readonly score: number; readonly rationale: string }
}) =>
  ({
    workspaceId,
    relationshipId: input.id,
    relationshipSchemaVersion: 1,
    revision: 1,
    supersedesRevision: null,
    kind: "implements",
    sourceNodeId: "01890f6f-6d6a-7cc0-98d2-410000000010",
    sourceNodeKind: "pull-request",
    targetNodeId: "01890f6f-6d6a-7cc0-98d2-410000000011",
    targetNodeKind: "issue",
    scope: { _tag: "release", releaseId },
    lifecycle: input.lifecycle,
    confidence: input.confidence,
    provenance: {
      _tag: "rule",
      ruleId: "issue-key-in-pr",
      ruleVersion: 1,
      rationale: "Issue key appears in pull request metadata."
    },
    recordedBy: { _tag: "system", component: "candidate-test" },
    evidenceClaimIds: [],
    recordedAt: "2026-07-16T10:00:00.000Z"
  }) satisfies typeof DeliveryRelationship.Encoded

describe("relationship repair candidates", () => {
  it("derives link and verify suggestions without proposing changes for governed relationships", () => {
    const slice = Schema.decodeSync(ReleaseDeliveryGraphInspection)({
      releaseId,
      environmentId: null,
      truncated: false,
      nodes: [],
      entityProjections: [],
      evidenceClaims: [],
      evidenceItems: [],
      relationships: [
        relationship({
          id: "01890f6f-6d6a-7cc0-98d2-410000000020",
          lifecycle: {
            _tag: "missing",
            effectiveAt: "2026-07-16T10:00:00.000Z",
            reason: "No pull request is linked."
          },
          confidence: { _tag: "unknown", rationale: "No source relationship was observed." }
        }),
        relationship({
          id: "01890f6f-6d6a-7cc0-98d2-410000000021",
          lifecycle: { _tag: "inferred", effectiveAt: "2026-07-16T10:00:00.000Z" },
          confidence: { _tag: "inferred", score: 0.8, rationale: "The issue key matches." }
        }),
        relationship({
          id: "01890f6f-6d6a-7cc0-98d2-410000000022",
          lifecycle: { _tag: "governed", effectiveAt: "2026-07-16T10:00:00.000Z" },
          confidence: { _tag: "unknown", rationale: "Already reviewed." }
        })
      ]
    })

    const result = deriveRelationshipRepairCandidates(slice)
    assert.deepStrictEqual(
      result.candidates.map((candidate) => ({
        disposition: candidate.suggestedDisposition,
        explanation: candidate.explanation,
        permission: candidate.requiredPermission
      })),
      [
        { disposition: "link", explanation: "No pull request is linked.", permission: "workspace-owner" },
        { disposition: "verify", explanation: "The issue key matches.", permission: "workspace-owner" }
      ]
    )
  })
})

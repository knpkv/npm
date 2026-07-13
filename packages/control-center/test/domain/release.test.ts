import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { ReleaseId } from "../../src/domain/identifiers.js"
import { Release } from "../../src/domain/release.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"

const ids = {
  assignment: "01890f00-0000-7000-8000-000000000006",
  environment: "01890f00-0000-7000-8000-000000000003",
  otherRelease: "01890f00-0000-7000-8000-000000000007",
  otherWorkspace: "01890f00-0000-7000-8000-000000000008",
  person: "01890f00-0000-7000-8000-000000000004",
  pluginConnection: "01890f00-0000-7000-8000-000000000005",
  release: "01890f00-0000-7000-8000-000000000002",
  workspace: "01890f00-0000-7000-8000-000000000001"
}

const sourceRevision = {
  firstObservedAt: "2026-07-13T08:00:00.000Z",
  lastObservedAt: "2026-07-13T08:05:00.000Z",
  normalizationSchemaVersion: 1,
  pluginConnectionId: ids.pluginConnection,
  providerId: "codecommit",
  revision: "a84f9d2",
  sourceUrl: "https://console.aws.amazon.com/codesuite/codecommit/repositories/payments-api",
  synchronizedAt: "2026-07-13T08:06:00.000Z",
  vendorImmutableId: "payments-api/release/v2.18.0"
}

const releaseRelay = deriveReleaseRelay(Schema.decodeUnknownSync(ReleaseId)(ids.release))

const releaseOwnerAssignment = {
  actor: { _tag: "human", personId: ids.person },
  assignmentId: ids.assignment,
  lifecycle: { _tag: "active", assignedAt: "2026-07-13T08:01:00.000Z" },
  role: "release-owner",
  scope: { _tag: "release", releaseId: ids.release, workspaceId: ids.workspace }
}

const validRelease = {
  createdAt: "2026-07-13T08:00:00.000Z",
  freshness: {
    _tag: "current",
    pluginHealth: { _tag: "healthy", checkedAt: "2026-07-13T08:06:00.000Z" },
    provenance: { _tag: "provider", sourceRevision },
    sourceObservedAt: sourceRevision.lastObservedAt,
    staleAfterSeconds: 300,
    synchronizedAt: sourceRevision.synchronizedAt
  },
  id: ids.release,
  lifecycle: "candidate",
  relay: releaseRelay,
  roleAssignments: [releaseOwnerAssignment],
  serviceName: "payments-api",
  sourceRevisions: [sourceRevision],
  targetEnvironmentIds: [ids.environment],
  updatedAt: "2026-07-13T08:06:00.000Z",
  version: "2.18.0-rc.1",
  workspaceId: ids.workspace
}

describe("Release", () => {
  it("decodes and round-trips the foundational release aggregate", () => {
    const decoded = Schema.decodeUnknownSync(Release)(validRelease)
    const encoded = Schema.encodeSync(Release)(decoded)

    expect(encoded).toEqual(validRelease)
    expect(decoded.relay).toEqual(releaseRelay)
  })

  it("rejects a relay projection derived from another release", () => {
    const otherRelay = deriveReleaseRelay(Schema.decodeUnknownSync(ReleaseId)(ids.otherRelease))

    expect(() => Schema.decodeUnknownSync(Release)({ ...validRelease, relay: otherRelay })).toThrow(
      /persisted relay projection/
    )
  })

  it("rejects role assignments from another workspace", () => {
    expect(() =>
      Schema.decodeUnknownSync(Release)({
        ...validRelease,
        roleAssignments: [
          {
            ...releaseOwnerAssignment,
            scope: { ...releaseOwnerAssignment.scope, workspaceId: ids.otherWorkspace }
          }
        ]
      })
    ).toThrow(/release workspace/)
  })

  it("rejects a release-scoped role assignment for another release", () => {
    expect(() =>
      Schema.decodeUnknownSync(Release)({
        ...validRelease,
        roleAssignments: [
          {
            ...releaseOwnerAssignment,
            scope: { ...releaseOwnerAssignment.scope, releaseId: ids.otherRelease }
          }
        ]
      })
    ).toThrow(/name this release/)
  })

  it("rejects an update time before release creation", () => {
    expect(() => Schema.decodeUnknownSync(Release)({ ...validRelease, updatedAt: "2026-07-13T07:59:59.999Z" })).toThrow(
      /update time/
    )
  })

  it("rejects duplicate environment and assignment identifiers", () => {
    expect(() =>
      Schema.decodeUnknownSync(Release)({
        ...validRelease,
        targetEnvironmentIds: [ids.environment, ids.environment]
      })
    ).toThrow(/unique target environment/)

    expect(() =>
      Schema.decodeUnknownSync(Release)({
        ...validRelease,
        roleAssignments: [releaseOwnerAssignment, releaseOwnerAssignment]
      })
    ).toThrow(/unique role assignment/)
  })

  it("rejects duplicate current revisions for one provider object", () => {
    expect(() =>
      Schema.decodeUnknownSync(Release)({
        ...validRelease,
        sourceRevisions: [sourceRevision, { ...sourceRevision, revision: "next-revision" }]
      })
    ).toThrow(/one current source revision/)
  })
})

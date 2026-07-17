// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { PortalProvider } from "@knpkv/rly/foundations"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { EvidenceClaim, EvidenceItem, LedgerRevision } from "../../src/domain/deliveryGraph.js"
import type { RelationshipId } from "../../src/domain/identifiers.js"
import {
  EvidenceClaimId,
  EvidenceId,
  PluginConnectionId,
  RelationshipId as RelationshipIdSchema
} from "../../src/domain/identifiers.js"
import {
  type RelationshipDetails,
  type RelationshipDetailsState,
  type RelationshipDetailsTransport,
  useRelationshipDetails
} from "../../src/client/releases/useRelationshipDetails.js"
import {
  RelationshipDetailSheet,
  relationshipHistoryCountLabel
} from "../../src/client/releases/RelationshipDetailSheet.js"
import { releaseWorksetFixture } from "../fixtures/releaseWorkset.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

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

const sourceRelationship = releaseWorksetFixture.relationships[0]
if (sourceRelationship === undefined) throw new Error("Expected a relationship fixture")

const relationshipB = Schema.decodeUnknownSync(RelationshipIdSchema)("01890f6f-6d6a-7cc0-98d5-000000000099")

const detailsFor = (relationshipId: RelationshipId): RelationshipDetails => ({
  evidence: [],
  history: {
    relationshipId,
    revisions: [{ ...sourceRelationship, relationshipId }]
  }
})

let mountedRoot: Root | undefined
const observations: Array<RelationshipDetailsState> = []

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  observations.length = 0
  document.body.replaceChildren()
})

const Harness = ({
  onSessionExpired,
  relationshipId,
  sessionKey,
  transport
}: {
  readonly onSessionExpired: (sessionKey: string) => void
  readonly relationshipId: RelationshipId | null
  readonly sessionKey: string
  readonly transport: RelationshipDetailsTransport
}): ReactElement => {
  const controller = useRelationshipDetails(relationshipId, [], sessionKey, onSessionExpired, transport)
  observations.push(controller.state)
  return (
    <span>
      {controller.state._tag === "ready" ? controller.state.details.history.relationshipId : controller.state._tag}
    </span>
  )
}

describe("useRelationshipDetails", () => {
  it("never exposes details from the previous relationship selection", async () => {
    const requestA = deferred<RelationshipDetails>()
    const requestB = deferred<RelationshipDetails>()
    const requests = [requestA.promise, requestB.promise]
    const transport = {
      load: vi.fn((_relationshipId: RelationshipId, _evidenceIds, _signal: AbortSignal) => {
        const request = requests.shift()
        return request ?? Promise.reject(new Error("Unexpected relationship request"))
      })
    } satisfies RelationshipDetailsTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(
        <Harness
          onSessionExpired={vi.fn()}
          relationshipId={sourceRelationship.relationshipId}
          sessionKey="session-a"
          transport={transport}
        />
      )
    )
    await act(async () => requestA.resolve(detailsFor(sourceRelationship.relationshipId)))
    expect(host.textContent).toBe(sourceRelationship.relationshipId)

    observations.length = 0
    await act(async () =>
      mountedRoot?.render(
        <Harness
          onSessionExpired={vi.fn()}
          relationshipId={relationshipB}
          sessionKey="session-a"
          transport={transport}
        />
      )
    )
    expect(
      observations.some((state) => state._tag === "ready" && state.relationshipId === sourceRelationship.relationshipId)
    ).toBe(false)
    expect(host.textContent).toBe("loading")

    await act(async () => requestB.resolve(detailsFor(relationshipB)))
    expect(host.textContent).toBe(relationshipB)
  })

  it("invalidates the exact session after an unauthorized read", async () => {
    const onSessionExpired = vi.fn()
    const transport = {
      load: vi.fn((_relationshipId: RelationshipId, _evidenceIds, _signal: AbortSignal) =>
        Promise.reject({ _tag: "UnauthorizedApiError" })
      )
    } satisfies RelationshipDetailsTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(
        <Harness
          onSessionExpired={onSessionExpired}
          relationshipId={sourceRelationship.relationshipId}
          sessionKey="session-a"
          transport={transport}
        />
      )
    )
    await act(async () => Promise.resolve())

    expect(onSessionExpired).toHaveBeenCalledWith("session-a")
    expect(host.textContent).toBe("failed")
  })

  it("renders a focused history and evidence panel for the selected relationship", async () => {
    const onClose = vi.fn()
    const transport = {
      load: vi.fn((_relationshipId: RelationshipId, _evidenceIds, _signal: AbortSignal) =>
        Promise.resolve(detailsFor(sourceRelationship.relationshipId))
      )
    } satisfies RelationshipDetailsTransport
    const host = document.createElement("div")
    const portal = document.createElement("div")
    document.body.append(host, portal)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(
        <PortalProvider container={portal}>
          <RelationshipDetailSheet
            claims={[]}
            evidenceIds={[]}
            onClose={onClose}
            onSessionExpired={vi.fn()}
            relationship={sourceRelationship}
            sessionKey="session-a"
            transport={transport}
          />
        </PortalProvider>
      )
    )
    await act(async () => Promise.resolve())

    expect(portal.querySelector('[role="dialog"]')?.textContent).toContain("Implements relationship")
    expect(portal.textContent).toContain("pull-request → issue")
    expect(portal.textContent).toContain("History")
    expect(portal.textContent).toContain("Revision 1")
    expect(portal.textContent).toContain("No immutable evidence is attached")

    await act(async () => portal.querySelector<HTMLButtonElement>('button[aria-label^="Close"]')?.click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("uses the closed release slice for exact claims when the evidence prefix omits them", async () => {
    const claimId = Schema.decodeUnknownSync(EvidenceClaimId)("01890f6f-6d6a-7cc0-98d6-000000000001")
    const evidenceId = Schema.decodeUnknownSync(EvidenceId)("01890f6f-6d6a-7cc0-98d7-000000000001")
    const pluginConnectionId = Schema.decodeUnknownSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d8-000000000001")
    const selectedClaim = Schema.decodeUnknownSync(EvidenceClaim)({
      workspaceId: sourceRelationship.workspaceId,
      evidenceClaimId: claimId,
      evidenceId,
      subjectNodeId: sourceRelationship.targetNodeId,
      predicate: "relationship-observed",
      value: { _tag: "flag", value: true },
      recordedAt: "2026-07-14T10:02:00.000Z",
      supersedesEvidenceClaimId: null
    })
    const evidence = Schema.decodeUnknownSync(EvidenceItem)({
      workspaceId: sourceRelationship.workspaceId,
      evidenceId,
      schemaVersion: 1,
      attribution: { _tag: "system", component: "release-sync" },
      verifier: { _tag: "system", component: "delivery-graph" },
      observedAt: "2026-07-14T10:01:00.000Z",
      recordedAt: "2026-07-14T10:02:00.000Z",
      validUntil: null,
      freshness: {
        _tag: "unavailable",
        pluginHealth: { _tag: "disabled", checkedAt: "2026-07-14T10:02:00.000Z" },
        provenance: { _tag: "none", pluginConnectionId },
        sourceObservedAt: null,
        staleAfterSeconds: 300,
        synchronizedAt: null
      },
      retention: { classification: "evidence", retainUntil: null, legalHold: false }
    })
    const unrelatedClaims = Array.from({ length: 200 }, (_, index) =>
      Schema.decodeUnknownSync(EvidenceClaim)({
        ...Schema.encodeSync(EvidenceClaim)(selectedClaim),
        evidenceClaimId: `01890f6f-6d6a-7cc0-98d6-${String(index + 2).padStart(12, "0")}`,
        predicate: "status-observed",
        value: { _tag: "state", value: "unrelated" }
      })
    )
    const relationship = { ...sourceRelationship, evidenceClaimIds: [claimId] }
    const transport = {
      load: vi.fn((_relationshipId: RelationshipId, _evidenceIds, _signal: AbortSignal) =>
        Promise.resolve({
          evidence: [{ claims: unrelatedClaims, evidence }],
          history: { relationshipId: relationship.relationshipId, revisions: [relationship] }
        })
      )
    } satisfies RelationshipDetailsTransport
    const host = document.createElement("div")
    const portal = document.createElement("div")
    document.body.append(host, portal)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(
        <PortalProvider container={portal}>
          <RelationshipDetailSheet
            claims={[selectedClaim]}
            evidenceIds={[evidenceId]}
            onClose={vi.fn()}
            onSessionExpired={vi.fn()}
            relationship={relationship}
            sessionKey="session-a"
            transport={transport}
          />
        </PortalProvider>
      )
    )
    await act(async () => Promise.resolve())

    expect(portal.textContent).toContain("Relationship Observed")
    expect(portal.textContent).toContain("Yes")
    expect(portal.textContent).not.toContain("unrelated")
  })

  it("labels bounded history without presenting the prefix as complete", () => {
    expect(relationshipHistoryCountLabel([sourceRelationship])).toBe("1 revision")
    const latest = {
      ...sourceRelationship,
      revision: Schema.decodeUnknownSync(LedgerRevision)(247),
      supersedesRevision: Schema.decodeUnknownSync(LedgerRevision)(246)
    }
    expect(relationshipHistoryCountLabel([latest, ...Array.from({ length: 199 }, () => sourceRelationship)])).toBe(
      "200 of 247 revisions"
    )
  })
})

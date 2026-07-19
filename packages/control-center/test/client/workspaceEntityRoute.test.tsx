// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ReleaseDeliveryGraphInspection,
  WorkspaceEntityInspection,
  type WorkspaceEntityInspection as Inspection
} from "../../src/api/deliveryGraph.js"
import { presentWorkspaceEntity } from "../../src/client/entities/presentWorkspaceEntity.js"
import { WorkspaceEntityView } from "../../src/client/entities/WorkspaceEntityRoute.js"
import type { WorkspaceEntityState } from "../../src/client/entities/useWorkspaceEntity.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const encodedWorkset = Schema.encodeSync(ReleaseDeliveryGraphInspection)(releaseWorksetFixture)
const projectionEntry = encodedWorkset.entityProjections[0]
if (projectionEntry === undefined) throw new Error("Expected an entity projection fixture")

const sourceRevision = {
  providerId: "jira",
  pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000081",
  vendorImmutableId: "jira-issue-ops-428",
  revision: "rev-8",
  sourceUrl: "https://jira.example.test/browse/OPS-428",
  firstObservedAt: "2026-07-14T10:00:00.000Z",
  lastObservedAt: "2026-07-14T10:00:00.000Z",
  synchronizedAt: "2026-07-14T10:01:00.000Z",
  normalizationSchemaVersion: 1
}

const inspection: Inspection = Schema.decodeUnknownSync(WorkspaceEntityInspection)({
  entity: {
    ...projectionEntry,
    canonicalReleaseId: encodedWorkset.releaseId,
    owners: [
      {
        avatarFallback: "AK",
        displayName: "Ada Kline",
        personId: "01890f6f-6d6a-7cc0-98d2-000000000071",
        roles: ["issue-owner", "reviewer"]
      }
    ],
    ownersTruncated: false,
    releaseIds: [encodedWorkset.releaseId],
    releaseMembershipsTruncated: false
  },
  source: sourceRevision,
  isSourceCurrent: false,
  freshness: {
    _tag: "stale",
    evaluatedAt: "2026-07-14T10:20:00.000Z",
    pluginHealth: { _tag: "healthy", checkedAt: "2026-07-14T10:20:00.000Z" },
    provenance: {
      _tag: "cache",
      cachedAt: "2026-07-14T10:01:00.000Z",
      sourceRevision
    },
    sourceObservedAt: "2026-07-14T10:00:00.000Z",
    staleAfterSeconds: 300,
    synchronizedAt: "2026-07-14T10:01:00.000Z"
  },
  graph: {
    truncated: true,
    nodes: encodedWorkset.nodes,
    relatedEntityProjections: encodedWorkset.entityProjections.slice(1),
    relationships: encodedWorkset.relationships,
    evidenceClaims: encodedWorkset.evidenceClaims,
    evidenceItems: encodedWorkset.evidenceItems
  },
  activity: {
    truncated: true,
    events: [
      {
        eventKey: "plugin-sync:OPS-428:rev-8",
        occurredAt: "2026-07-14T10:01:00.000Z",
        actor: { kind: "plugin", label: "Jira synchronization" },
        sourceKind: "plugin-sync",
        service: "jira",
        eventType: "entity-synchronized",
        title: "Issue synchronized",
        href: "https://jira.example.test/browse/OPS-428"
      }
    ]
  }
})

const state = {
  _tag: "stale",
  entityId: inspection.entity.projection.entityId,
  inspection,
  reason: "source-stale",
  refreshKey: "snapshot-a",
  sessionKey: "session-a",
  workspaceId: WORKSET_WORKSPACE_ID
} satisfies WorkspaceEntityState

let mountedRoot: Root | undefined

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

const renderView = async (onAskAgent: () => void): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  mountedRoot = createRoot(host)
  const view: ReactElement = (
    <MemoryRouter>
      <WorkspaceEntityView
        onAskAgent={onAskAgent}
        isStoredOrigin={false}
        originHref={`/w/${WORKSET_WORKSPACE_ID}/items?q=payments#results`}
        originLabel="Back to items"
        originState={null}
        retry={() => undefined}
        state={state}
        workspaceId={WORKSET_WORKSPACE_ID}
      />
    </MemoryRouter>
  )
  await act(async () => mountedRoot?.render(view))
  return host
}

describe("canonical workspace entity", () => {
  it("presents human-first next work, ownership, graph, provenance, and activity", () => {
    const presentation = presentWorkspaceEntity(WORKSET_WORKSPACE_ID, inspection)

    expect(presentation).toMatchObject({
      displayKey: "OPS-428",
      freshness: "stale",
      kindLabel: "Issue",
      primaryAction: {
        external: true,
        href: "https://jira.example.test/browse/OPS-428",
        label: "Open in Jira"
      },
      service: "jira",
      title: "Review payment capture safeguards",
      verdict: "In review"
    })
    expect(presentation.collaborators.reviewers).toEqual([
      expect.objectContaining({ name: "Ada Kline", role: "Issue Owner · Reviewer" })
    ])
    expect(presentation.relationships.length).toBeGreaterThan(0)
    expect(presentation.activity).toEqual([
      expect.objectContaining({ actorKind: "plugin", detail: "Plugin Sync", title: "Issue synchronized" })
    ])
    expect(presentation.partialMessages).toEqual([
      "The relationship graph is partial; additional delivery links exist.",
      "The activity list is partial; older events are not shown."
    ])
  })

  it("renders the complete stale partial state and launches the contextual agent", async () => {
    const onAskAgent = vi.fn()
    const host = await renderView(onAskAgent)

    expect(host.textContent).toContain("Review payment capture safeguards")
    expect(host.textContent).toContain("In review")
    expect(host.textContent).toContain("Open in Jira")
    expect(host.textContent).toContain("Working circle")
    expect(host.textContent).toContain("Ada Kline")
    expect(host.textContent).toContain("Issue Owner · Reviewer")
    expect(host.textContent).toContain("Delivery relationships")
    expect(host.textContent).toContain("Partial canonical view")
    expect(host.textContent).toContain("Issue synchronized")
    expect(host.textContent).toContain("Provenance")
    expect(host.textContent).toContain("Showing retained source data")
    expect(host.querySelector("article[data-workspace-entity-id]")).toBe(document.activeElement)

    const agentButton = host.querySelector<HTMLButtonElement>("[data-rly-agent-context-button]")
    if (agentButton === null) throw new Error("Expected the contextual agent button")
    await act(async () => agentButton.click())
    expect(onAskAgent).toHaveBeenCalledOnce()
  })
})

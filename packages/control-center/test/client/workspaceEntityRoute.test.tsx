// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation } from "react-router"
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
    projection: {
      ...projectionEntry.projection,
      details: {
        _tag: "issue",
        key: "OPS-428",
        status: "In review",
        priority: "High",
        estimatePoints: 3,
        summary: "Review payment capture safeguards",
        description: "Customer impact\n\nCapture retries must never create a second charge.",
        acceptanceCriteria:
          "A repeated capture returns the original payment result.\nNo duplicate ledger entry is created.",
        environment: "Payments production in eu-west-1.",
        issueType: { sourceId: "10001", name: "Story" },
        project: { sourceId: "10000", key: "OPS", name: "Operations" },
        resolution: null,
        labels: ["payments", "release-blocker"],
        components: [{ sourceId: "20001", name: "Capture API" }],
        fixVersions: [{ sourceId: "30001", name: "Payments 2026.07", released: false, releaseDate: null }],
        createdAt: "2026-07-10T08:00:00.000Z",
        updatedAt: "2026-07-14T10:00:00.000Z",
        dueDate: "2026-07-18",
        resolvedAt: null,
        parent: {
          sourceId: "jira-epic-payments",
          key: "OPS-400",
          summary: "Harden payment delivery",
          status: { sourceId: "3", name: "In progress" }
        },
        subtasks: [
          {
            sourceId: "jira-subtask-429",
            key: "OPS-429",
            summary: "Add duplicate capture contract test",
            status: { sourceId: "2", name: "Ready" }
          }
        ],
        assigneeSourcePersonId: "account-mina",
        reporterSourcePersonId: "account-ada",
        creatorSourcePersonId: "account-ada",
        collaborators: [
          {
            sourcePersonId: "account-mina",
            displayName: "Mina Ortiz",
            avatarUrl: "https://images.example.test/mina.png",
            active: true,
            roles: ["assignee", "commenter"]
          },
          {
            sourcePersonId: "account-ada",
            displayName: "Ada Kline",
            avatarUrl: null,
            active: true,
            roles: ["creator", "reporter"]
          }
        ],
        comments: [
          {
            sourceId: "comment-41",
            authorSourcePersonId: "account-mina",
            updateAuthorSourcePersonId: null,
            body: "Sandbox replay is green. I am waiting for the final reviewer.",
            createdAt: "2026-07-14T09:30:00.000Z",
            updatedAt: null
          }
        ],
        commentTotal: 4,
        commentsTruncated: true,
        history: [
          {
            sourceId: "history-9",
            authorSourcePersonId: "account-ada",
            createdAt: "2026-07-14T09:00:00.000Z",
            changes: [{ field: "Status", from: "In progress", to: "In review" }]
          }
        ],
        historyTotal: 1,
        historyTruncated: false,
        truncatedFields: ["comments"]
      }
    },
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

const LocationProbe = (): ReactElement => {
  const location = useLocation()
  return <output data-location>{`${location.pathname}${location.search}${location.hash}`}</output>
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
    expect(presentation.collaborators.owners).toEqual([
      expect.objectContaining({
        avatarSrc: "https://images.example.test/mina.png",
        name: "Mina Ortiz",
        role: "Assignee · Commenter"
      })
    ])
    expect(presentation.agentContext).toContain("1 release · 4 synchronized comments")
    expect(presentation.relationships.length).toBeGreaterThan(0)
    expect(presentation.activity).toEqual([
      expect.objectContaining({ actorKind: "plugin", detail: "Plugin Sync", title: "Issue synchronized" })
    ])
    expect(presentation.partialMessages).toEqual([
      "The relationship graph is partial; additional delivery links exist.",
      "The activity list is partial; older events are not shown."
    ])
  })

  it("presents deleted related entities as unavailable", () => {
    const related = inspection.graph.relatedEntityProjections[0]
    if (related === undefined) throw new Error("Expected a related entity projection fixture")
    const deletedRelated = {
      ...related,
      projection: { ...related.projection, entityState: "deleted" }
    } satisfies typeof related
    const withDeletedRelated = {
      ...inspection,
      graph: {
        ...inspection.graph,
        relatedEntityProjections: inspection.graph.relatedEntityProjections.map((entry) =>
          entry.projection.entityId === related.projection.entityId ? deletedRelated : entry
        )
      }
    }
    const presentation = presentWorkspaceEntity(WORKSET_WORKSPACE_ID, withDeletedRelated)
    const endpoints = presentation.relationships.flatMap(({ source, target }) => [source, target])

    expect(endpoints).toContainEqual({
      state: "missing",
      label: `${related.projection.title} · Deleted`,
      reason: "The related object was deleted.",
      service: "jira"
    })
  })

  it("returns a chained entity directly to its stored origin", async () => {
    const originHref = `/w/${WORKSET_WORKSPACE_ID}/releases/${encodedWorkset.releaseId}/preview?filter=attention`
    const firstEntityHref = `/w/${WORKSET_WORKSPACE_ID}/items/01890f6f-6d6a-7cc0-98d3-000000000002`
    const currentEntityHref = `/w/${WORKSET_WORKSPACE_ID}/items/${inspection.entity.projection.entityId}`
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () =>
      mountedRoot?.render(
        <MemoryRouter initialEntries={[originHref, firstEntityHref, currentEntityHref]} initialIndex={2}>
          <LocationProbe />
          <WorkspaceEntityView
            onAskAgent={() => undefined}
            originHref={originHref}
            originLabel="Back to release"
            originState={null}
            retry={() => undefined}
            state={state}
            workspaceId={WORKSET_WORKSPACE_ID}
          />
        </MemoryRouter>
      )
    )
    const backLink = [...host.querySelectorAll<HTMLAnchorElement>("a")].find(
      (link) => link.textContent === "Back to release"
    )
    if (backLink === undefined) throw new Error("Expected the stored-origin Back link")

    await act(async () => backLink.click())

    expect(host.querySelector("[data-location]")?.textContent).toBe(originHref)
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

  it("renders a synchronized Jira issue as a complete read-only working document", async () => {
    const host = await renderView(() => undefined)

    expect(host.textContent).toContain("Customer impact")
    expect(host.textContent).toContain("Capture retries must never create a second charge.")
    expect(host.textContent).toContain("Acceptance criteria")
    expect(host.textContent).toContain("A repeated capture returns the original payment result.")
    expect(host.textContent).toContain("Mina Ortiz")
    expect(host.textContent).toContain("Assignee · Commenter")
    expect(host.textContent).toContain("Sandbox replay is green. I am waiting for the final reviewer.")
    expect(host.textContent).toContain("4 comments")
    expect(host.textContent).toContain("Only the newest synchronized comments are shown.")
    expect(host.textContent).toContain("Status")
    expect(host.textContent).toContain("In progress → In review")
    expect(host.textContent).toContain("Payments 2026.07")
    expect(host.textContent).toContain("OPS-400")
    expect(host.textContent).toContain("OPS-429")
    expect(host.querySelector("textarea")).toBeNull()
    expect(host.textContent).not.toContain("Edit issue")
  })
})

// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { RelationshipChain } from "../../src/patterns/RelationshipChain.js"
import type { RlyRelationship, RlyRelationshipLifecycle } from "../../src/patterns/Relationship.js"
import { RelationshipTable } from "../../src/patterns/RelationshipTable.js"
import { render } from "../primitives/render.js"

const lifecycles = [
  "missing",
  "inferred",
  "proposed",
  "verified",
  "governed",
  "rejected",
  "superseded"
] satisfies ReadonlyArray<RlyRelationshipLifecycle>

const relationshipAt = (index: number): RlyRelationship => ({
  id: `relationship-${String(index + 1).padStart(2, "0")}`,
  kind: index % 2 === 0 ? "Implemented by" : "Validated against",
  direction: index % 3 === 0 ? "bidirectional" : index % 2 === 0 ? "forward" : "reverse",
  lifecycle: lifecycles[index % lifecycles.length] ?? "missing",
  source: {
    state: "present",
    id: `jira-${String((index % 20) + 1).padStart(2, "0")}`,
    title: `Release requirement with complete visible title ${index + 1}`,
    reference: `JIRA-${index + 1}`,
    service: "jira",
    href: `/jira/${index + 1}`
  },
  target:
    index === 5
      ? {
          state: "missing",
          label: "Missing CodeCommit pull request",
          reason: "No implementation relationship has been recorded.",
          service: "codecommit"
        }
      : {
          state: "present",
          id: `pr-${String((index % 4) + 1).padStart(2, "0")}`,
          title: `Shared pull request group ${(index % 4) + 1}`,
          reference: `PR-${(index % 4) + 1}`,
          service: "codecommit",
          href: `/pull-requests/${(index % 4) + 1}`
        },
  evidence: `Evidence packet ${index + 1}`
})

const twenty = Array.from({ length: 20 }, (_, index) => relationshipAt(index))

const visibleText = (element: Element | null): string => element?.textContent?.replaceAll(/\s+/gu, " ").trim() ?? ""

const relationshipProjection = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>("[data-rly-relationship-id]")).map((item) => ({
    actor: visibleText(item.querySelector("[data-rly-relationship-actor]")),
    detail: visibleText(item.querySelector("[data-rly-relationship-detail]")),
    direction: item.dataset.rlyRelationshipDirection ?? "",
    endpoints: Array.from(item.querySelectorAll<HTMLElement>("[data-rly-endpoint-state]")).map((endpoint) => ({
      href: endpoint.querySelector("a")?.getAttribute("href") ?? "",
      id: endpoint.dataset.rlyEndpointId ?? "",
      state: endpoint.dataset.rlyEndpointState ?? "",
      text: visibleText(endpoint)
    })),
    evidence: visibleText(item.querySelector("[data-rly-relationship-evidence]")),
    id: item.dataset.rlyRelationshipId ?? "",
    kind: item.dataset.rlyRelationshipKind ?? "",
    lifecycle: item.dataset.rlyRelationshipLifecycle ?? ""
  }))

describe("RelationshipTable", () => {
  it("uses native table semantics with stable visible column headers", () => {
    const table = render(<RelationshipTable heading="Relationship register" relationships={twenty.slice(0, 1)} />)
    expect(table?.querySelector("table")).not.toBeNull()
    expect(Array.from(table?.querySelectorAll("th") ?? []).map((header) => header.textContent)).toEqual([
      "Source",
      "Relationship",
      "Target",
      "Evidence"
    ])
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(1)
  })

  it("is semantically equivalent to the chain for ordered ids, lifecycle, and kind", () => {
    const fixture = twenty.slice(0, 7)
    const chain = render(<RelationshipChain heading="Chain" relationships={fixture} />)
    if (chain === null) throw new Error("RelationshipChain did not render")
    const chainProjection = relationshipProjection(chain)

    const table = render(<RelationshipTable heading="Table" relationships={fixture} />)
    if (table === null) throw new Error("RelationshipTable did not render")
    expect(relationshipProjection(table)).toEqual(chainProjection)
    expect(
      relationshipProjection(table).map(({ direction, id, kind, lifecycle }) => ({ direction, id, kind, lifecycle }))
    ).toEqual(fixture.map(({ direction, id, kind, lifecycle }) => ({ direction, id, kind, lifecycle })))
  })

  it("renders zero, one, six, and every one of twenty records including repeated endpoints", () => {
    for (const count of [0, 1, 6, 20]) {
      const table = render(
        <RelationshipTable heading={`${count} relationships`} relationships={twenty.slice(0, count)} />
      )
      expect(table?.querySelectorAll("[data-rly-relationship-id]")).toHaveLength(count)
    }

    const complete = render(<RelationshipTable heading="Twenty relationships" relationships={twenty} />)
    expect(complete?.querySelectorAll("[data-rly-endpoint-id='pr-01']").length).toBeGreaterThan(1)
    expect(complete?.textContent).toContain("relationship")
    expect(complete?.textContent).toContain("Evidence packet 20")
  })

  it("renders explicit missing endpoints as text rather than links", () => {
    const table = render(<RelationshipTable heading="Explicit gap" relationships={[relationshipAt(5)]} />)
    const missing = table?.querySelector("[data-rly-endpoint-state='missing']")
    expect(missing).not.toBeNull()
    expect(missing?.querySelector("a")).toBeNull()
    expect(missing?.textContent).toContain("Missing CodeCommit pull request")
    expect(table?.querySelectorAll("a")).toHaveLength(1)
  })

  it("validates its own heading, empty label, and shared relationship contract", () => {
    expect(() => renderToStaticMarkup(<RelationshipTable heading=" " relationships={[]} />)).toThrow(
      "RelationshipTable heading"
    )
    expect(() => renderToStaticMarkup(<RelationshipTable emptyLabel=" " heading="Links" relationships={[]} />)).toThrow(
      "RelationshipTable emptyLabel"
    )
    expect(() =>
      renderToStaticMarkup(
        <RelationshipTable
          heading="Links"
          relationships={[twenty[0], twenty[0]].filter((value) => value !== undefined)}
        />
      )
    ).toThrow("Relationship ids must be unique")
  })
})

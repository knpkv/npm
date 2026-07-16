// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { RelationshipChain } from "../../src/patterns/RelationshipChain.js"
import type {
  RlyRelationship,
  RlyRelationshipEndpoint,
  RlyRelationshipLifecycle
} from "../../src/patterns/Relationship.js"
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

const presentEndpoint = (id: string, service: "jira" | "codecommit", href = `/${id}`): RlyRelationshipEndpoint => ({
  state: "present",
  id,
  title: service === "jira" ? `Release requirement ${id}` : `Pull request group ${id}`,
  reference: id.toUpperCase(),
  service,
  href
})

const relationshipAt = (index: number): RlyRelationship => {
  const target: RlyRelationshipEndpoint =
    index === 5
      ? {
          state: "missing",
          label: "Missing CodeCommit pull request",
          reason: "No implementation relationship has been recorded.",
          service: "codecommit"
        }
      : presentEndpoint(`pr-${String((index % 4) + 1).padStart(2, "0")}`, "codecommit")
  const relationship = {
    id: `relationship-${String(index + 1).padStart(2, "0")}`,
    kind: index % 2 === 0 ? "Implemented by" : "Validated against",
    direction: index % 3 === 0 ? "bidirectional" : index % 2 === 0 ? "forward" : "reverse",
    lifecycle: lifecycles[index % lifecycles.length] ?? "missing",
    source: presentEndpoint(`jira-${String((index % 20) + 1).padStart(2, "0")}`, "jira"),
    target
  } satisfies Omit<RlyRelationship, "actor" | "evidence">
  return index % 4 === 0 ? relationship : { ...relationship, evidence: `Evidence packet ${index + 1}` }
}

const twenty = Array.from({ length: 20 }, (_, index) => relationshipAt(index))

describe("RelationshipChain", () => {
  it("covers zero, one, six, and twenty records without hiding or grouping", () => {
    const zero = render(<RelationshipChain heading="No links" relationships={[]} />)
    expect(zero?.textContent).toContain("No relationships recorded.")
    expect(zero?.querySelectorAll("[data-rly-relationship-id]")).toHaveLength(0)

    for (const count of [1, 6, 20]) {
      const chain = render(
        <RelationshipChain heading={`${count} relationships`} relationships={twenty.slice(0, count)} />
      )
      expect(chain?.querySelectorAll("[data-rly-relationship-id]")).toHaveLength(count)
      for (const relationship of twenty.slice(0, count)) {
        expect(chain?.querySelector(`[data-rly-relationship-id="${relationship.id}"]`)).not.toBeNull()
      }
    }
  })

  it("renders all lifecycle words and supplied direction words independently of color", () => {
    const chain = render(<RelationshipChain heading="Lifecycle matrix" relationships={twenty.slice(0, 7)} />)
    if (chain === null) throw new Error("RelationshipChain did not render")

    for (const lifecycle of lifecycles) {
      const item = chain.querySelector(`[data-rly-relationship-lifecycle="${lifecycle}"]`)
      expect(item?.textContent).toContain(`${lifecycle.slice(0, 1).toUpperCase()}${lifecycle.slice(1)}`)
    }
    expect(chain.textContent).toContain("Forward")
    expect(chain.textContent).toContain("Reverse")
    expect(chain.textContent).toContain("Bidirectional")
  })

  it("keeps present endpoints keyboard-linkable and missing endpoints explicit but unfocusable", () => {
    const chain = render(<RelationshipChain heading="Explicit gap" relationships={[relationshipAt(5)]} />)
    const item = chain?.querySelector("[data-rly-relationship-id='relationship-06']")
    const missing = item?.querySelector("[data-rly-endpoint-state='missing']")
    expect(item?.querySelectorAll("a")).toHaveLength(1)
    expect(missing?.querySelector("a")).toBeNull()
    expect(missing?.textContent).toContain("Missing CodeCommit pull request")
    expect(missing?.textContent).toContain("No implementation relationship has been recorded.")
  })

  it("validates headings, visible record fields, endpoint fields, and unique record ids", () => {
    const valid = relationshipAt(0)
    expect(() => renderToStaticMarkup(<RelationshipChain heading=" " relationships={[valid]} />)).toThrow(
      "RelationshipChain heading"
    )
    expect(() => renderToStaticMarkup(<RelationshipChain emptyLabel=" " heading="Links" relationships={[]} />)).toThrow(
      "RelationshipChain emptyLabel"
    )

    const blankKind = { ...valid, kind: " " }
    expect(() => renderToStaticMarkup(<RelationshipChain heading="Links" relationships={[blankKind]} />)).toThrow(
      "Relationship kind"
    )
    expect(() =>
      renderToStaticMarkup(<RelationshipChain heading="Links" relationships={[valid, { ...valid }]} />)
    ).toThrow("Relationship ids must be unique")

    const blankEndpoint = {
      ...valid,
      source: {
        state: "present",
        id: "jira-blank",
        title: " ",
        reference: "JIRA-BLANK",
        service: "jira"
      }
    } satisfies RlyRelationship
    expect(() => renderToStaticMarkup(<RelationshipChain heading="Links" relationships={[blankEndpoint]} />)).toThrow(
      "source title"
    )

    const invalidLifecycle = { ...valid }
    Reflect.set(invalidLifecycle, "lifecycle", "unknown")
    expect(() =>
      renderToStaticMarkup(<RelationshipChain heading="Links" relationships={[invalidLifecycle]} />)
    ).toThrow("lifecycle")
  })
})

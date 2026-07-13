// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  CollaboratorGroup,
  RLY_COLLABORATOR_GROUP_DEFAULT_VARIANTS,
  RLY_COLLABORATOR_GROUP_VARIANTS,
  type RlyCollaboratorCategory
} from "../../src/patterns/CollaboratorGroup.js"
import type { RlyPerson } from "../../src/patterns/Person.js"

const author = { id: "author", name: "Avery Diaz", role: "PR author" } satisfies RlyPerson
const owner = { id: "owner", name: "Blake Kim", role: "Release owner" } satisfies RlyPerson
const reviewers = [
  { id: "reviewer-1", name: "Casey Singh", role: "Code reviewer" },
  { id: "reviewer-2", name: "Devon O'Rourke", role: "Security reviewer" }
] satisfies ReadonlyArray<RlyPerson>
const operator = { id: "operator", name: "Emery Chen", role: "Deployment operator" } satisfies RlyPerson
const approver = { id: "approver", name: "Frankie Mensah", role: "Merge approver" } satisfies RlyPerson

const ControlledGroup = (): ReactElement => {
  const [expandedCategories, setExpandedCategories] = useState<ReadonlyArray<RlyCollaboratorCategory>>([])
  return (
    <CollaboratorGroup
      expandedCategories={expandedCategories}
      heading="Pull request collaborators"
      limit={1}
      onCategoryExpandedChange={(category, expanded) =>
        setExpandedCategories((current) =>
          expanded ? [...current, category] : current.filter((currentCategory) => currentCategory !== category)
        )
      }
      reviewers={reviewers}
    />
  )
}

describe("CollaboratorGroup", () => {
  it("exposes every collaborator category while each person retains an explicit role", () => {
    const markup = renderToStaticMarkup(
      <CollaboratorGroup
        approvers={[approver]}
        authors={[author]}
        expandedCategories={[]}
        heading="Release collaborators"
        onCategoryExpandedChange={() => undefined}
        operators={[operator]}
        owners={[owner]}
        reviewers={reviewers}
      />
    )
    for (const label of ["Authors", "Owners", "Reviewers", "Operators", "Approvers"]) {
      expect(markup).toContain(`>${label}<`)
    }
    for (const role of ["PR author", "Release owner", "Code reviewer", "Deployment operator", "Merge approver"]) {
      expect(markup).toContain(role)
    }
    expect(markup).toContain("Release collaborators")
  })

  it("renders an explicit named empty state", () => {
    const markup = renderToStaticMarkup(
      <CollaboratorGroup
        emptyLabel="No release collaborators assigned."
        expandedCategories={[]}
        heading="Release collaborators"
        onCategoryExpandedChange={() => undefined}
      />
    )
    expect(markup).toContain("Release collaborators")
    expect(markup).toContain("No release collaborators assigned.")
  })

  it("routes controlled expansion through the explicit category", async () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    await act(async () => root.render(<ControlledGroup />))
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Show 1 more people"]')
    expect(host.textContent).not.toContain("Devon O'Rourke")
    await act(async () => button?.click())
    expect(host.textContent).toContain("Devon O'Rourke")
    expect(host.querySelector<HTMLButtonElement>("button")?.getAttribute("aria-expanded")).toBe("true")
    await act(async () => root.unmount())
  })

  it("publishes meaningful compact and default metadata", () => {
    expect(Object.keys(RLY_COLLABORATOR_GROUP_VARIANTS.size)).toEqual(["compact", "default"])
    expect(RLY_COLLABORATOR_GROUP_DEFAULT_VARIANTS).toEqual({ size: "default" })
  })
})

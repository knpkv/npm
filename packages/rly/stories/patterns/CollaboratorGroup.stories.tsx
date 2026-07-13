import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { CollaboratorGroup, type RlyCollaboratorCategory } from "../../src/patterns/CollaboratorGroup.js"
import type { RlyPerson } from "../../src/patterns/Person.js"
import { pageStyle } from "../primitives/storyStyles.js"

const authors = [{ id: "author", name: "Avery Diaz", role: "PR author" }] satisfies ReadonlyArray<RlyPerson>
const owners = [{ id: "owner", name: "Blake Kim", role: "Release owner" }] satisfies ReadonlyArray<RlyPerson>
const reviewers = [
  { id: "reviewer-1", name: "Casey Singh", role: "Code reviewer" },
  { id: "reviewer-2", name: "Devon O'Rourke", role: "Security reviewer" },
  { id: "reviewer-3", name: "Emery Chen", role: "Documentation reviewer" },
  { id: "reviewer-4", name: "Frankie Mensah", role: "Reliability reviewer" }
] satisfies ReadonlyArray<RlyPerson>
const operators = [
  { id: "operator", name: "Gray Okafor", role: "Deployment operator" }
] satisfies ReadonlyArray<RlyPerson>
const approvers = [{ id: "approver", name: "Harper Sato", role: "Merge approver" }] satisfies ReadonlyArray<RlyPerson>

const EntityCollaborators = (): ReactElement => {
  const [expandedCategories, setExpandedCategories] = useState<ReadonlyArray<RlyCollaboratorCategory>>([])
  return (
    <main style={pageStyle}>
      <CollaboratorGroup
        approvers={approvers}
        authors={authors}
        expandedCategories={expandedCategories}
        heading="Pull request collaborators"
        limit={3}
        onCategoryExpandedChange={(category, expanded) =>
          setExpandedCategories((current) =>
            expanded ? [...current, category] : current.filter((currentCategory) => currentCategory !== category)
          )
        }
        operators={operators}
        owners={owners}
        reviewers={reviewers}
      />
      <CollaboratorGroup
        emptyLabel="No release collaborators assigned."
        expandedCategories={[]}
        heading="Unassigned release"
        onCategoryExpandedChange={() => undefined}
        size="compact"
      />
    </main>
  )
}

const meta = {
  component: CollaboratorGroup,
  tags: ["autodocs"],
  title: "Patterns/CollaboratorGroup"
} satisfies Meta<typeof CollaboratorGroup>

export default meta
type Story = StoryObj<typeof meta>

const args = {
  expandedCategories: [],
  heading: "Pull request collaborators",
  onCategoryExpandedChange: () => undefined
} satisfies Story["args"]

export const EntityRoles: Story = {
  args,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: "Pull request collaborators" })).toBeVisible()
    for (const heading of ["Authors", "Owners", "Reviewers", "Operators", "Approvers"]) {
      await expect(canvas.getByRole("heading", { name: heading })).toBeVisible()
    }
    await expect(canvas.getByText("PR author")).toBeVisible()
    await expect(canvas.getByText("Release owner")).toBeVisible()
    await expect(canvas.getByText("Deployment operator")).toBeVisible()
    await expect(canvas.getByText("Merge approver")).toBeVisible()
    await expect(canvas.getByText("No release collaborators assigned.")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Show 1 more people" }))
    await expect(canvas.getByText("Frankie Mensah")).toBeVisible()
  },
  render: () => <EntityCollaborators />
}

export const Dark: Story = {
  args,
  globals: { theme: "dark" },
  render: () => <EntityCollaborators />
}

export const ForcedColors: Story = {
  args,
  globals: { forcedColors: "active" },
  render: () => <EntityCollaborators />
}

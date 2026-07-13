import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, ReactElement } from "react"
import { expect, userEvent } from "storybook/test"
import { RelationshipChain } from "../../src/patterns/RelationshipChain.js"
import type { RlyRelationship, RlyRelationshipLifecycle } from "../../src/patterns/Relationship.js"
import { RelationshipTable } from "../../src/patterns/RelationshipTable.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

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
    id: `jira-${String(index + 1).padStart(2, "0")}`,
    title:
      index === 0
        ? "Preserve the complete release relationship explanation at every supported viewport width"
        : `Release requirement ${index + 1}`,
    reference: `JIRA-${100 + index}`,
    service: "jira",
    href: `/jira/${100 + index}`
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
          reference: `PR-${200 + (index % 4)}`,
          service: "codecommit",
          href: `/pull-requests/${200 + (index % 4)}`
        },
  evidence: `Evidence packet ${index + 1}`
})

const twenty = Array.from({ length: 20 }, (_, index) => relationshipAt(index))

const narrowStyle: CSSProperties = {
  inlineSize: "100%",
  maxInlineSize: "320px"
}

const projection = (root: Element): ReadonlyArray<ReadonlyArray<string>> =>
  Array.from(root.querySelectorAll<HTMLElement>("[data-rly-relationship-id]")).map((item) => [
    item.dataset.rlyRelationshipId ?? "",
    item.dataset.rlyRelationshipLifecycle ?? "",
    item.dataset.rlyRelationshipKind ?? ""
  ])

const EquivalenceCatalog = (): ReactElement => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Relationship table equivalence
    </Text>
    <div style={stackStyle}>
      <RelationshipChain heading="Chain projection" relationships={twenty} />
      <RelationshipTable heading="Table zero" relationships={[]} />
      <RelationshipTable heading="Table one" relationships={twenty.slice(0, 1)} />
      <RelationshipTable heading="Table six" relationships={twenty.slice(0, 6)} />
      <RelationshipTable heading="Table twenty" relationships={twenty} />
    </div>
  </main>
)

const CompactForcedColorsCatalog = (): ReactElement => (
  <main data-relationship-table-compact="" style={pageStyle}>
    <div style={narrowStyle}>
      <RelationshipTable heading="Compact lifecycle matrix" relationships={twenty.slice(0, 7)} />
    </div>
  </main>
)

const meta = {
  component: RelationshipTable,
  tags: ["autodocs"],
  title: "Patterns/RelationshipTable"
} satisfies Meta<typeof RelationshipTable>

export default meta
type Story = StoryObj<typeof meta>

export const Equivalence: Story = {
  args: { heading: "Relationship table", relationships: twenty },
  play: async ({ canvas, canvasElement }) => {
    const chain = canvas.getByRole("region", { name: "Chain projection" })
    const zero = canvas.getByRole("region", { name: "Table zero" })
    const one = canvas.getByRole("region", { name: "Table one" })
    const six = canvas.getByRole("region", { name: "Table six" })
    const complete = canvas.getByRole("region", { name: "Table twenty" })
    await expect(zero).toHaveTextContent("No relationships recorded.")
    await expect(one.querySelectorAll("[data-rly-relationship-id]")).toHaveLength(1)
    await expect(six.querySelectorAll("[data-rly-relationship-id]")).toHaveLength(6)
    await expect(complete.querySelectorAll("[data-rly-relationship-id]")).toHaveLength(20)
    await expect(projection(complete)).toEqual(projection(chain))
    await expect(complete.querySelectorAll("[data-rly-endpoint-id='pr-01']").length).toBeGreaterThan(1)
    for (const lifecycle of lifecycles) {
      await expect(complete.querySelector(`[data-rly-relationship-lifecycle="${lifecycle}"]`)).not.toBeNull()
    }
    await userEvent.tab()
    await expect(canvasElement.ownerDocument.activeElement?.tagName).toBe("A")
    canvasElement.dataset.relationshipTableEquivalencePlayComplete = "true"
  },
  render: () => <EquivalenceCatalog />
}

export const CompactForcedColors: Story = {
  args: { heading: "Compact lifecycle matrix", relationships: twenty.slice(0, 7) },
  globals: { forcedColors: "active", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const compact = canvasElement.querySelector<HTMLElement>("[data-relationship-table-compact]")
    if (compact === null) throw new Error("RelationshipTable compact boundary did not mount")
    await expect(compact.scrollWidth).toBeLessThanOrEqual(compact.clientWidth)
    await expect(canvas.getByText("Missing CodeCommit pull request")).toBeVisible()
    await expect(
      canvas.getByText("Preserve the complete release relationship explanation at every supported viewport width")
    ).toBeVisible()
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(4)
    for (const lifecycle of lifecycles) {
      const label = `${lifecycle.slice(0, 1).toUpperCase()}${lifecycle.slice(1)}`
      await expect(canvas.getByText(label)).toBeVisible()
    }
    await userEvent.tab()
    await expect(canvasElement.ownerDocument.activeElement?.tagName).toBe("A")
    canvasElement.dataset.relationshipTableCompactPlayComplete = "true"
  },
  render: () => <CompactForcedColorsCatalog />
}

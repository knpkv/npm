import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, ReactElement } from "react"
import { expect, userEvent, within } from "storybook/test"
import { RelationshipChain } from "../../src/patterns/RelationshipChain.js"
import type {
  RlyRelationship,
  RlyRelationshipEndpoint,
  RlyRelationshipLifecycle
} from "../../src/patterns/Relationship.js"
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

const relationshipAt = (index: number): RlyRelationship => {
  const source: RlyRelationshipEndpoint = {
    state: "present",
    id: `jira-${String(index + 1).padStart(2, "0")}`,
    title:
      index === 0
        ? "Preserve the complete release relationship explanation at every supported viewport width"
        : `Release requirement ${index + 1}`,
    reference: `JIRA-${100 + index}`,
    service: "jira",
    href: `/jira/${100 + index}`,
    ...(index === 0
      ? {
          person: {
            id: "avery",
            name: "Avery Diaz",
            role: "Requirement owner"
          }
        }
      : {})
  }
  const target: RlyRelationshipEndpoint =
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
        }
  const base = {
    id: `relationship-${String(index + 1).padStart(2, "0")}`,
    kind: index % 2 === 0 ? "Implemented by" : "Validated against",
    direction: index % 3 === 0 ? "bidirectional" : index % 2 === 0 ? "forward" : "reverse",
    lifecycle: lifecycles[index % lifecycles.length] ?? "missing",
    source,
    target
  } satisfies Omit<RlyRelationship, "actor" | "evidence">

  return index % 4 === 0 ? base : { ...base, evidence: `Evidence packet ${index + 1}` }
}

const twenty = Array.from({ length: 20 }, (_, index) => relationshipAt(index))

const narrowStyle: CSSProperties = {
  inlineSize: "100%",
  maxInlineSize: "320px"
}

const CardinalityCatalog = (): ReactElement => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Relationship chain cardinalities
    </Text>
    <div style={stackStyle}>
      <RelationshipChain heading="Zero relationships" relationships={[]} />
      <RelationshipChain heading="One relationship" relationships={twenty.slice(0, 1)} />
      <RelationshipChain heading="Six relationships" relationships={twenty.slice(0, 6)} />
      <RelationshipChain heading="Twenty relationships" relationships={twenty} />
    </div>
  </main>
)

const CompactForcedColorsCatalog = (): ReactElement => (
  <main data-relationship-chain-compact="" style={pageStyle}>
    <div style={narrowStyle}>
      <RelationshipChain heading="Compact lifecycle matrix" relationships={twenty.slice(0, 7)} />
    </div>
  </main>
)

const meta = {
  component: RelationshipChain,
  tags: ["autodocs"],
  title: "Patterns/RelationshipChain"
} satisfies Meta<typeof RelationshipChain>

export default meta
type Story = StoryObj<typeof meta>

export const Cardinalities: Story = {
  args: { heading: "Relationships", relationships: twenty },
  play: async ({ canvas, canvasElement }) => {
    const zero = canvas.getByRole("region", { name: "Zero relationships" })
    const one = canvas.getByRole("region", { name: "One relationship" })
    const six = canvas.getByRole("region", { name: "Six relationships" })
    const complete = canvas.getByRole("region", { name: "Twenty relationships" })
    await expect(zero).toHaveTextContent("No relationships recorded.")
    await expect(one.querySelectorAll("[data-rly-relationship-id]")).toHaveLength(1)
    await expect(six.querySelectorAll("[data-rly-relationship-id]")).toHaveLength(6)
    await expect(complete.querySelectorAll("[data-rly-relationship-id]")).toHaveLength(20)
    await expect(complete.querySelectorAll("[data-rly-endpoint-id='pr-01']").length).toBeGreaterThan(1)
    await expect(within(six).getByText("Missing CodeCommit pull request")).toBeVisible()
    for (const lifecycle of lifecycles) {
      await expect(complete.querySelector(`[data-rly-relationship-lifecycle="${lifecycle}"]`)).not.toBeNull()
    }
    await userEvent.tab()
    await expect(canvasElement.ownerDocument.activeElement?.tagName).toBe("A")
    canvasElement.dataset.relationshipChainCardinalitiesPlayComplete = "true"
  },
  render: () => <CardinalityCatalog />
}

export const CompactForcedColors: Story = {
  args: { heading: "Compact lifecycle matrix", relationships: twenty.slice(0, 7) },
  globals: { forcedColors: "active", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const compact = canvasElement.querySelector<HTMLElement>("[data-relationship-chain-compact]")
    if (compact === null) throw new Error("RelationshipChain compact boundary did not mount")
    await expect(compact.scrollWidth).toBeLessThanOrEqual(compact.clientWidth)
    await expect(canvas.getByText("Missing CodeCommit pull request")).toBeVisible()
    await expect(
      canvas.getByText("Preserve the complete release relationship explanation at every supported viewport width")
    ).toBeVisible()
    for (const lifecycle of lifecycles) {
      const label = `${lifecycle.slice(0, 1).toUpperCase()}${lifecycle.slice(1)}`
      await expect(canvas.getByText(label)).toBeVisible()
    }
    await userEvent.tab()
    await expect(canvasElement.ownerDocument.activeElement?.tagName).toBe("A")
    canvasElement.dataset.relationshipChainCompactPlayComplete = "true"
  },
  render: () => <CompactForcedColorsCatalog />
}

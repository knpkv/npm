import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { RlyLink } from "../../src/foundations/LinkProvider.js"
import {
  EntityTable,
  type RlyEntityTableColumn,
  type RlyEntityTableData,
  type RlyEntityTableRow,
  type RlyEntityTableSortDirection
} from "../../src/patterns/EntityTable.js"
import { Person } from "../../src/patterns/Person.js"
import { ServiceMark, type RlyService } from "../../src/patterns/ServiceMark.js"
import { StateLabel } from "../../src/primitives/StateLabel.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const services = ["jira", "codecommit", "codepipeline", "confluence", "clockify"] satisfies ReadonlyArray<RlyService>

const columnsFor = (
  sortDirection: RlyEntityTableSortDirection
): readonly [RlyEntityTableColumn, ...ReadonlyArray<RlyEntityTableColumn>] => [
  { id: "item", label: "Item", sortable: true, sortDirection },
  { id: "service", label: "Service" },
  { id: "status", label: "Status" },
  { id: "owner", label: "Owner" }
]

const rowAt = (index: number): RlyEntityTableRow => {
  const service = services[index % services.length] ?? "jira"
  return {
    cells: [
      {
        columnId: "item",
        content: <RlyLink href={`/items/${index + 1}`}>{`Delivery item with complete title ${index + 1}`}</RlyLink>
      },
      { columnId: "service", content: <ServiceMark service={service} size="compact" /> },
      {
        columnId: "status",
        content: (
          <StateLabel
            label={index % 3 === 0 ? "Needs review" : "Ready"}
            size="compact"
            tone={index % 3 === 0 ? "caution" : "positive"}
          />
        )
      },
      {
        columnId: "owner",
        content: (
          <Person
            person={{ id: `owner-${index + 1}`, name: `Owner ${index + 1}`, role: "Delivery owner" }}
            size="compact"
          />
        )
      }
    ],
    id: `entity-${index + 1}`
  }
}

const twenty = Array.from({ length: 20 }, (_, index) => rowAt(index))

const cached = (state: "stale" | "partial" | "error" | "unavailable"): RlyEntityTableData => ({
  description: `Six cached rows remain visible while the ${state} source is explained.`,
  rows: twenty.slice(0, 6),
  state,
  title: `Results are ${state}`,
  tone: state === "error" ? "critical" : "caution"
})

const StateCatalog = () => {
  const [sortDirection, setSortDirection] = useState<RlyEntityTableSortDirection>("ascending")
  const columns = columnsFor(sortDirection)
  const onSortChange = (): void => {
    setSortDirection((current) => (current === "ascending" ? "descending" : "ascending"))
  }

  return (
    <main style={pageStyle}>
      <Text as="h1" variant="section-title">
        Complete entity table states
      </Text>
      <div style={stackStyle}>
        <EntityTable
          columns={columns}
          data={{ rows: twenty, state: "ready" }}
          heading="Ready entities"
          onSortChange={onSortChange}
        />
        <EntityTable
          columns={columns}
          data={{ label: "Loading entities", skeletonRows: 3, state: "loading" }}
          heading="Loading entities"
          onSortChange={onSortChange}
        />
        <EntityTable
          columns={columns}
          data={{ description: "Clear filters to see delivery items.", state: "empty", title: "No entities" }}
          heading="Empty entities"
          onSortChange={onSortChange}
        />
        <EntityTable
          columns={columns}
          data={{ description: "The requested entity no longer exists.", state: "not-found", title: "Not found" }}
          heading="Missing entity"
          onSortChange={onSortChange}
        />
        {(
          ["stale", "partial", "error", "unavailable"] satisfies ReadonlyArray<
            "stale" | "partial" | "error" | "unavailable"
          >
        ).map((state) => (
          <EntityTable
            columns={columns}
            data={cached(state)}
            heading={`${state} entities`}
            key={state}
            onSortChange={onSortChange}
          />
        ))}
      </div>
    </main>
  )
}

const CompactCanary = () => (
  <main data-entity-table-compact="" style={pageStyle}>
    <EntityTable
      columns={columnsFor("ascending")}
      data={cached("partial")}
      heading="Compact delivery items"
      onSortChange={() => undefined}
    />
  </main>
)

const meta = {
  args: {
    columns: columnsFor("ascending"),
    data: { rows: twenty.slice(0, 1), state: "ready" },
    heading: "Delivery items",
    onSortChange: () => undefined
  },
  component: EntityTable,
  tags: ["autodocs"],
  title: "Patterns/EntityTable"
} satisfies Meta<typeof EntityTable>

export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {
  play: async ({ canvas, canvasElement }) => {
    const ready = canvas.getByRole("region", { name: "Ready entities" })
    await expect(ready.querySelectorAll("[data-rly-entity-row-id]")).toHaveLength(20)
    const itemHeader = within(ready).getByRole("columnheader", { name: "Item" })
    await expect(itemHeader).toHaveAttribute("aria-sort", "ascending")
    await userEvent.click(within(ready).getByRole("button", { name: "Item" }))
    await expect(itemHeader).toHaveAttribute("aria-sort", "descending")
    await expect(canvas.getAllByText("Loading entities", { exact: true })).toHaveLength(2)
    for (const state of ["stale", "partial", "error", "unavailable"]) {
      const region = canvas.getByRole("region", { name: `${state} entities` })
      await expect(region.querySelectorAll("[data-rly-entity-row-id]")).toHaveLength(6)
    }
    canvasElement.dataset.entityTableStatesPlayComplete = "true"
  },
  render: () => <StateCatalog />
}

export const CompactForcedColors: Story = {
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const compact = canvasElement.querySelector<HTMLElement>("[data-entity-table-compact]")
    if (compact === null) throw new Error("EntityTable compact canary did not render")
    await expect(compact.scrollWidth).toBeLessThanOrEqual(compact.clientWidth)
    await expect(compact.querySelectorAll("[data-rly-entity-row-id]")).toHaveLength(6)
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(4)
    for (const provider of ["CodeCommit", "CodePipeline", "Jira", "Confluence", "Clockify"]) {
      await expect(canvas.getAllByRole("img", { name: provider }).length).toBeGreaterThan(0)
    }
    canvasElement.dataset.entityTableCompactPlayComplete = "true"
  },
  render: () => <CompactCanary />
}

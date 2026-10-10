// Mirrors stories/patterns/EntityTable.stories.tsx. The story links items through the internal
// RlyLink; with no LinkProvider installed that renders a native anchor, which is used here.
import * as React from "react"
import { useState } from "react"
import {
  EntityTable,
  Person,
  PortalProvider,
  ServiceMark,
  StateLabel,
  Text,
  type RlyEntityTableColumn,
  type RlyEntityTableData,
  type RlyEntityTableRow,
  type RlyEntityTableSortDirection,
  type RlyService
} from "@knpkv/rly"
import { pageStyle, stackStyle } from "@ds-stories/packages/rly/stories/primitives/storyStyles"
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
        content: <a href={`/items/${index + 1}`}>{`Delivery item with complete title ${index + 1}`}</a>
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
  <PortalProvider>
    <main data-entity-table-compact="" style={pageStyle}>
      <EntityTable
        columns={columnsFor("ascending")}
        data={cached("partial")}
        heading="Compact delivery items"
        onSortChange={() => undefined}
      />
      <EntityTable
        columns={columnsFor("ascending")}
        data={cached("partial")}
        density="compact"
        heading="Dense delivery items"
        headingSize="card"
        onSortChange={() => undefined}
      />
    </main>
  </PortalProvider>
)

export const States = () => <StateCatalog />

// The story sets globals { forcedColors: "active", theme: "dark" }; Storybook's catalog decorator
// turns those into these attributes.
export const CompactForcedColors = () => (
  <div
    data-forced-colors="active"
    data-reduced-motion="system"
    data-rly-catalog=""
    data-rly-density="comfortable"
    data-rly-forced-colors="active"
    data-rly-reduced-motion="system"
    data-rly-theme="dark"
    data-theme="dark"
    lang="en"
    style={{ minHeight: "100vh" }}
  >
    <CompactCanary />
  </div>
)

// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import {
  EntityTable,
  type RlyEntityTableColumn,
  type RlyEntityTableData,
  type RlyEntityTableRow
} from "../../src/patterns/EntityTable.js"
import { render } from "../primitives/render.js"

const columns = [
  { id: "item", label: "Item", sortable: true, sortDirection: "ascending" },
  { id: "service", label: "Service" },
  { id: "status", label: "Status" }
] satisfies readonly [RlyEntityTableColumn, ...ReadonlyArray<RlyEntityTableColumn>]

const rowAt = (index: number): RlyEntityTableRow => ({
  cells: [
    { columnId: "item", content: `Delivery item ${index + 1}` },
    { columnId: "service", content: index % 2 === 0 ? "Jira" : "CodeCommit" },
    { columnId: "status", content: index % 3 === 0 ? "Needs review" : "Ready" }
  ],
  id: `entity-${index + 1}`
})

const twenty = Array.from({ length: 20 }, (_, index) => rowAt(index))

describe("EntityTable", () => {
  it("renders a labelled native table with controlled sort semantics", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onSortChange = vi.fn()
    await act(async () =>
      root.render(
        <EntityTable
          columns={columns}
          data={{ rows: twenty.slice(0, 1), state: "ready" }}
          heading="Delivery items"
          onSortChange={onSortChange}
        />
      )
    )

    const section = host.querySelector("section")
    const table = host.querySelector("table")
    const sort = host.querySelector<HTMLButtonElement>("th button")
    expect(section?.getAttribute("aria-labelledby")).toBe(host.querySelector("h2")?.id)
    expect(table?.getAttribute("aria-labelledby")).toBe(host.querySelector("h2")?.id)
    expect(host.querySelector("th")?.getAttribute("aria-sort")).toBe("ascending")
    expect(sort?.getAttribute("type")).toBe("button")
    await act(async () => sort?.click())
    expect(onSortChange).toHaveBeenCalledWith("item")
    await act(async () => root.unmount())
  })

  it("keeps one, six, and twenty arbitrary rows complete", () => {
    for (const count of [1, 6, 20]) {
      const table = render(
        <EntityTable
          columns={columns}
          data={{ rows: twenty.slice(0, count), state: "ready" }}
          heading={`${count} entities`}
          onSortChange={() => undefined}
        />
      )
      expect(table?.querySelectorAll("[data-rly-entity-row-id]")).toHaveLength(count)
      expect(table?.textContent).toContain(`Delivery item ${count}`)
    }
  })

  it("represents loading, empty, and not-found without an ambiguous empty table", () => {
    const loading = render(
      <EntityTable
        columns={columns}
        data={{ label: "Loading delivery items", skeletonRows: 4, state: "loading" }}
        heading="Loading"
        onSortChange={() => undefined}
      />
    )
    expect(loading?.getAttribute("aria-busy")).toBe("true")
    expect(loading?.textContent).toContain("Loading delivery items")
    expect(loading?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4)
    expect(loading?.querySelector("table")).toBeNull()

    for (const state of ["empty", "not-found"] satisfies ReadonlyArray<"empty" | "not-found">) {
      const table = render(
        <EntityTable
          columns={columns}
          data={{ description: "Change the current filters and try again.", state, title: `State: ${state}` }}
          heading={state}
          onSortChange={() => undefined}
        />
      )
      expect(table?.textContent).toContain(`State: ${state}`)
      expect(table?.querySelector("table")).toBeNull()
    }
  })

  it("retains cached rows beside every degraded explanation", () => {
    const states = ["stale", "partial", "error", "unavailable"] satisfies ReadonlyArray<
      "stale" | "partial" | "error" | "unavailable"
    >
    for (const state of states) {
      const data = {
        description: `Cached ${state} entity results remain visible.`,
        rows: twenty.slice(0, 6),
        state,
        title: `Results are ${state}`,
        tone: state === "error" ? "critical" : "caution"
      } satisfies RlyEntityTableData
      const table = render(<EntityTable columns={columns} data={data} heading={state} onSortChange={() => undefined} />)
      expect(table?.textContent).toContain(`Results are ${state}`)
      expect(table?.querySelectorAll("[data-rly-entity-row-id]")).toHaveLength(6)
    }
  })

  it("rejects incomplete, duplicate, and ambiguous presentation data", () => {
    expect(() =>
      renderToStaticMarkup(
        <EntityTable
          columns={columns}
          data={{ rows: [], state: "ready" }}
          heading="Ready"
          onSortChange={() => undefined}
        />
      )
    ).toThrow("use the empty state")

    const duplicateColumns = [columns[0], { ...columns[0] }] satisfies readonly [
      RlyEntityTableColumn,
      RlyEntityTableColumn
    ]
    expect(() =>
      renderToStaticMarkup(
        <EntityTable
          columns={duplicateColumns}
          data={{ rows: [rowAt(0)], state: "ready" }}
          heading="Duplicates"
          onSortChange={() => undefined}
        />
      )
    ).toThrow("column ids must be unique")

    const missingCell = { ...rowAt(0), cells: rowAt(0).cells.slice(0, 2) }
    expect(() =>
      renderToStaticMarkup(
        <EntityTable
          columns={columns}
          data={{ rows: [missingCell], state: "ready" }}
          heading="Missing cell"
          onSortChange={() => undefined}
        />
      )
    ).toThrow("is missing column")

    expect(() =>
      renderToStaticMarkup(
        <EntityTable
          columns={columns}
          data={{ description: "No cache", rows: [], state: "error", title: "Error", tone: "critical" }}
          heading="Error"
          onSortChange={() => undefined}
        />
      )
    ).toThrow("must retain at least one cached row")
  })
})

import { type ComponentPropsWithRef, type ReactElement, type ReactNode, useId } from "react"
import { Icon } from "../foundations/Icon.js"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import { IconButton } from "../primitives/IconButton.js"
import { Select } from "../primitives/Select.js"
import { Skeleton } from "../primitives/Skeleton.js"
import { StatePanel, type RlyStatePanelTone } from "../primitives/StatePanel.js"
import styles from "./EntityTable.module.css"

const style = (name: string): string => cssClass(styles, name)

export const RLY_ENTITY_TABLE_VARIANTS = defineVariants({
  density: {
    default: {
      className: style("defaultDensity"),
      purpose: "One labelled line per field when the table narrows to cards",
      tokens: ["space-12"]
    },
    compact: {
      className: style("compact"),
      purpose: "Narrow cards led by the first column, the rest as a two-column label and value grid",
      tokens: ["space-8", "space-2"]
    }
  },
  headingSize: {
    section: {
      className: style("sectionHeading"),
      purpose: "The table is a page section of its own",
      tokens: ["type-section-title"]
    },
    card: {
      className: style("cardHeading"),
      purpose: "The table sits in a panel beside other card-titled panels",
      tokens: ["type-card-title"]
    }
  }
})

export const RLY_ENTITY_TABLE_DEFAULT_VARIANTS = defineVariants({ density: "default", headingSize: "section" })
export type RlyEntityTableDensity = keyof typeof RLY_ENTITY_TABLE_VARIANTS.density
export type RlyEntityTableHeadingSize = keyof typeof RLY_ENTITY_TABLE_VARIANTS.headingSize

/** Caller-owned table sort state. */
export type RlyEntityTableSortDirection = "none" | "ascending" | "descending"

type RlyEntityTableColumnBase = {
  readonly id: string
  readonly label: string
}

/** A column is either static or explicitly controlled by the application. */
export type RlyEntityTableColumn = RlyEntityTableColumnBase &
  (
    | { readonly sortable?: false; readonly sortDirection?: never }
    | { readonly sortable: true; readonly sortDirection: RlyEntityTableSortDirection }
  )

/** One caller-rendered cell associated with an explicit column. */
export interface RlyEntityTableCell {
  readonly columnId: string
  readonly content: ReactNode
}

/** One complete presentation row. */
export interface RlyEntityTableRow {
  readonly cells: ReadonlyArray<RlyEntityTableCell>
  readonly id: string
}

type RlyEntityTableRows = { readonly rows: ReadonlyArray<RlyEntityTableRow> }

/** Complete table data states. Cached failure states retain their supplied rows. */
export type RlyEntityTableData =
  | { readonly state: "ready"; readonly rows: ReadonlyArray<RlyEntityTableRow> }
  | { readonly label: string; readonly skeletonRows?: number; readonly state: "loading" }
  | { readonly description?: string; readonly state: "empty" | "not-found"; readonly title: string }
  | (RlyEntityTableRows & {
      readonly description: string
      readonly state: "stale" | "partial" | "error" | "unavailable"
      readonly title: string
      readonly tone: RlyStatePanelTone
    })

/** Props for an application-controlled, native semantic entity table. */
export type EntityTableProps = Omit<ComponentPropsWithRef<"section">, "aria-label" | "children"> & {
  readonly columns: readonly [RlyEntityTableColumn, ...ReadonlyArray<RlyEntityTableColumn>]
  readonly data: RlyEntityTableData
  /**
   * How rows read once the table narrows to cards; wide tables look the same at both. Compact
   * cards sort through a `Select`, so they need an available `PortalProvider`.
   */
  readonly density?: RlyEntityTableDensity
  readonly heading: string
  readonly headingSize?: RlyEntityTableHeadingSize
  readonly onSortChange: (columnId: string) => void
}

const validateColumns = (
  columns: readonly [RlyEntityTableColumn, ...ReadonlyArray<RlyEntityTableColumn>]
): ReadonlySet<string> => {
  const ids = new Set<string>()
  for (const column of columns) {
    const id = requireText(column.id, "EntityTable column id")
    if (ids.has(id)) throw new Error(`EntityTable column ids must be unique: ${id}`)
    ids.add(id)
    requireText(column.label, `EntityTable column label for ${id}`)
  }
  return ids
}

const validateRows = (rows: ReadonlyArray<RlyEntityTableRow>, columnIds: ReadonlySet<string>): void => {
  const rowIds = new Set<string>()
  for (const row of rows) {
    const rowId = requireText(row.id, "EntityTable row id")
    if (rowIds.has(rowId)) throw new Error(`EntityTable row ids must be unique: ${rowId}`)
    rowIds.add(rowId)

    const cellIds = new Set<string>()
    for (const cell of row.cells) {
      const columnId = requireText(cell.columnId, `EntityTable cell column id for ${rowId}`)
      if (!columnIds.has(columnId)) throw new Error(`EntityTable row ${rowId} has an unknown column: ${columnId}`)
      if (cellIds.has(columnId)) throw new Error(`EntityTable row ${rowId} repeats column: ${columnId}`)
      cellIds.add(columnId)
    }
    for (const columnId of columnIds) {
      if (!cellIds.has(columnId)) throw new Error(`EntityTable row ${rowId} is missing column: ${columnId}`)
    }
  }
}

const rowsFor = (data: RlyEntityTableData): ReadonlyArray<RlyEntityTableRow> =>
  data.state === "ready" ||
  data.state === "stale" ||
  data.state === "partial" ||
  data.state === "error" ||
  data.state === "unavailable"
    ? data.rows
    : []

/** The active column's direction; an unsorted column shows no glyph, which would read as a value. */
const SortGlyph = ({ direction }: { readonly direction: RlyEntityTableSortDirection }): ReactElement | null =>
  direction === "none" ? null : (
    <Icon decorative name={direction === "ascending" ? "arrow-up" : "arrow-down"} size="small" />
  )

/** Render complete entity rows while leaving selection, sorting, and pagination to the application. */
export const EntityTable = ({
  className,
  columns,
  data,
  density = "default",
  heading,
  headingSize = "section",
  onSortChange,
  ...props
}: EntityTableProps): ReactElement => {
  const visibleHeading = requireText(heading, "EntityTable heading")
  const columnIds = validateColumns(columns)
  const rows = rowsFor(data)
  validateRows(rows, columnIds)
  if (data.state === "ready" && rows.length === 0) {
    throw new Error("EntityTable ready state must contain at least one row; use the empty state instead")
  }
  if (data.state === "loading") {
    requireText(data.label, "EntityTable loading label")
    const skeletonRows = data.skeletonRows ?? 3
    if (!Number.isInteger(skeletonRows) || skeletonRows < 1 || skeletonRows > 20) {
      throw new Error("EntityTable skeletonRows must be an integer from 1 to 20")
    }
  }
  if (data.state === "empty" || data.state === "not-found") {
    requireText(data.title, "EntityTable state title")
    if (data.description !== undefined) requireText(data.description, "EntityTable state description")
  }
  if (data.state === "stale" || data.state === "partial" || data.state === "error" || data.state === "unavailable") {
    requireText(data.title, "EntityTable cached state title")
    requireText(data.description, "EntityTable cached state description")
    if (rows.length === 0) throw new Error(`EntityTable ${data.state} state must retain at least one cached row`)
  }

  const headingId = `rly-entity-table-${useId()}`
  const sortable = columns.filter(
    (
      column
    ): column is RlyEntityTableColumnBase & {
      readonly sortable: true
      readonly sortDirection: RlyEntityTableSortDirection
    } => column.sortable === true
  )
  const current = sortable.find((column) => column.sortDirection !== "none")
  const columnById = new Map(columns.map((column) => [column.id, column]))
  const cachedNotice =
    data.state === "stale" || data.state === "partial" || data.state === "error" || data.state === "unavailable" ? (
      <StatePanel description={data.description} title={data.title} tone={data.tone} />
    ) : null

  return (
    <section
      {...props}
      aria-busy={data.state === "loading" ? "true" : undefined}
      aria-labelledby={headingId}
      className={classNames(
        style("root"),
        RLY_ENTITY_TABLE_VARIANTS.density[density].className,
        RLY_ENTITY_TABLE_VARIANTS.headingSize[headingSize].className,
        className
      )}
      data-rly-entity-table-density={density}
      data-rly-entity-table-state={data.state}
    >
      <h2 className={style("heading")} id={headingId}>
        {visibleHeading}
      </h2>
      {data.state === "loading" ? (
        <div aria-label={data.label} className={style("loading")} role="status">
          <span className={style("stateLabel")}>{data.label}</span>
          {Array.from({ length: data.skeletonRows ?? 3 }, (_, index) => (
            <Skeleton height="48px" key={index} variant="block" />
          ))}
        </div>
      ) : data.state === "empty" || data.state === "not-found" ? (
        <StatePanel description={data.description} title={data.title} />
      ) : (
        <>
          {cachedNotice}
          {density === "compact" ? (
            sortable.length === 0 ? null : (
              <div className={style("sortSelect")}>
                <Select
                  aria-label="Sort by"
                  onValueChange={(value) => {
                    if (value !== current?.id) onSortChange(value)
                  }}
                  options={sortable.map((column) => ({
                    label:
                      column.sortDirection === "ascending"
                        ? `${column.label} ↑`
                        : column.sortDirection === "descending"
                          ? `${column.label} ↓`
                          : column.label,
                    value: column.id
                  }))}
                  placeholder="Sort by"
                  value={current?.id}
                />
                {current === undefined ? null : (
                  <IconButton
                    icon={current.sortDirection === "ascending" ? "arrow-up" : "arrow-down"}
                    label={`Reverse order, currently ${current.sortDirection}`}
                    onClick={() => onSortChange(current.id)}
                    variant="secondary"
                  />
                )}
              </div>
            )
          ) : (
            <div aria-label={`${visibleHeading} sorting`} className={style("sortControls")} role="group">
              <span className={style("sortLabel")}>Sort</span>
              {sortable.map((column) => (
                <button
                  aria-label={`Sort by ${column.label}, currently ${column.sortDirection}`}
                  className={style("sortButton")}
                  key={column.id}
                  onClick={() => onSortChange(column.id)}
                  type="button"
                >
                  <span>{column.label}</span>
                  <SortGlyph direction={column.sortDirection} />
                </button>
              ))}
            </div>
          )}
          <table aria-labelledby={headingId} className={style("table")}>
            <thead className={style("head")}>
              <tr>
                {columns.map((column) => (
                  <th
                    aria-label={column.label}
                    aria-sort={column.sortable === true ? column.sortDirection : undefined}
                    key={column.id}
                    scope="col"
                  >
                    {column.sortable === true ? (
                      <>
                        <span className={style("headerLabel")}>{column.label}</span>
                        <button
                          aria-label={`Sort by ${column.label}, currently ${column.sortDirection}`}
                          className={style("headerSort")}
                          data-rly-hit-area=""
                          onClick={() => onSortChange(column.id)}
                          type="button"
                        >
                          <span>{column.label}</span>
                          <SortGlyph direction={column.sortDirection} />
                        </button>
                      </>
                    ) : (
                      column.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={style("body")}>
              {rows.map((row) => {
                const cells = new Map(row.cells.map((cell) => [cell.columnId, cell.content]))
                return (
                  <tr className={style("row")} data-rly-entity-row-id={row.id} key={row.id}>
                    {columns.map((column) => (
                      <td className={style("cell")} data-label={columnById.get(column.id)?.label} key={column.id}>
                        {cells.get(column.id)}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, useCallback, useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { ChartLegend, type RlySeries } from "../../src/primitives/ChartLegend.js"
import {
  type RlyChartColumn,
  type RlyChartSelection,
  StackedBars,
  type RlyStepBand
} from "../../src/primitives/StackedBars.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "./storyStyles.js"

const hour = 3_600_000
const start = Date.UTC(2026, 8, 28, 0)
const bookings: ReadonlyArray<{ readonly id: string; readonly label: string; readonly series: RlySeries }> = [
  { id: "ledger", label: "RLY-142 ledger export", series: 1 },
  { id: "sync", label: "RLY-150 sync retry", series: 2 },
  { id: "review", label: "Review queue", series: 3 },
  { id: "rest", label: "Other (4)", series: "other" }
]
// Synthetic, deterministic week: a working-hours rhythm with one busy afternoon.
const wave = (index: number, phase: number): number => {
  const hourOfDay = index % 24
  const working = hourOfDay >= 8 && hourOfDay <= 19 ? 1 : 0.1
  return Math.max(0, Math.round((Math.sin(index / 3 + phase) + 1.2) * working * 100) / 100)
}
const week: ReadonlyArray<RlyChartColumn> = Array.from({ length: 168 }, (_, index) => ({
  end: start + (index + 1) * hour,
  segments: bookings.map((booking, order) => ({
    id: booking.id,
    series: booking.series,
    value: wave(index, order) * (index >= 62 && index <= 66 && booking.id === "ledger" ? 4 : 1)
  })),
  start: start + index * hour
}))
const bands: ReadonlyArray<RlyStepBand> = [
  {
    id: "5h",
    label: "5-hour window",
    near: { label: "Dashed line: near the limit, 80%", level: 80 },
    segments: [
      { from: start, level: 35, to: start + 60 * hour },
      { from: start + 60 * hour, level: 96, to: start + 65 * hour },
      { from: start + 65 * hour, level: null, to: start + 70 * hour },
      { from: start + 70 * hour, level: 22, to: start + 168 * hour }
    ]
  },
  {
    id: "week",
    label: "Weekly",
    near: { label: "Dashed line: near the limit, 80%", level: 80 },
    segments: [
      { from: start, level: 30, to: start + 90 * hour },
      { from: start + 90 * hour, level: 84, to: start + 168 * hour }
    ]
  }
]

// The chart's SVG is hidden from assistive technology, so the same data ships as a table: one row
// per day, each booking's spend, and the highest reading of each band that day.
const dayName = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
const dollars = (value: number): string => `$${value.toFixed(2)}`
const peakOf = (band: RlyStepBand, from: number, to: number): string => {
  const levels = band.segments
    .filter((segment) => segment.from < to && segment.to > from)
    .map((segment) => segment.level)
  const known = levels.filter((level): level is number => level !== null)
  if (known.length === 0) return "No reading"
  const peak = `${Math.max(...known)}%`
  return known.length < levels.length ? `${peak}, partly no reading` : peak
}
const cellStyle: CSSProperties = {
  padding: "var(--rly-space-4) var(--rly-space-8)",
  textAlign: "end",
  whiteSpace: "nowrap"
}
const headStyle: CSSProperties = { ...cellStyle, textAlign: "start" }

const DataTable = ({ columns }: { readonly columns: ReadonlyArray<RlyChartColumn> }) => {
  const days = Array.from({ length: Math.ceil(columns.length / 24) }, (_, index) =>
    columns.slice(index * 24, index * 24 + 24)
  )
  return (
    // The table scrolls inside its own box at phone widths instead of widening the page.
    <div
      aria-label="Daily spend table"
      role="region"
      style={{ overflowX: "auto" }}
      // Keyboard users can scroll the table when it is wider than the page.
      tabIndex={0}
    >
      <table style={{ borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
        <caption style={{ textAlign: "start" }}>Spend by booking and limit peaks per day</caption>
        <thead>
          <tr>
            <th scope="col" style={headStyle}>
              Day
            </th>
            {bookings.map((booking) => (
              <th key={booking.id} scope="col" style={cellStyle}>
                {booking.label}
              </th>
            ))}
            {bands.map((band) => (
              <th key={band.id} scope="col" style={cellStyle}>
                {`${band.label} peak`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((hours) => {
            const from = hours[0]?.start ?? 0
            const to = hours[hours.length - 1]?.end ?? from
            return (
              <tr key={from}>
                <th scope="row" style={headStyle}>
                  {dayName.format(from)}
                </th>
                {bookings.map((booking) => (
                  <td key={booking.id} style={cellStyle}>
                    {dollars(
                      hours
                        .flatMap((column) => column.segments)
                        .filter((segment) => segment.id === booking.id)
                        .reduce((sum, segment) => sum + segment.value, 0)
                    )}
                  </td>
                ))}
                {bands.map((band) => (
                  <td key={band.id} style={cellStyle}>
                    {peakOf(band, from, to)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit" })

// Each band's intervals as rows: the levels the bands draw, with when each starts and ends.
const BandTable = () => (
  // Scrolls inside its own box at phone widths instead of widening the page, like the daily table.
  <div aria-label="Limit levels table" role="region" style={{ overflowX: "auto" }} tabIndex={0}>
    <table style={{ borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
      <caption style={{ textAlign: "start" }}>Limit levels over time</caption>
      <thead>
        <tr>
          <th scope="col" style={headStyle}>
            Limit
          </th>
          <th scope="col" style={headStyle}>
            From
          </th>
          <th scope="col" style={headStyle}>
            To
          </th>
          <th scope="col" style={cellStyle}>
            Level
          </th>
        </tr>
      </thead>
      <tbody>
        {bands.flatMap((band) =>
          band.segments.map((segment) => (
            <tr key={`${band.id}:${segment.from}`}>
              <th scope="row" style={headStyle}>
                {band.label}
              </th>
              <td style={headStyle}>{day.format(segment.from)}</td>
              <td style={headStyle}>{day.format(segment.to)}</td>
              <td style={cellStyle}>{segment.level === null ? "No reading" : `${segment.level}%`}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
)

// The selected span's spend per booking, so arrowing through the plot reaches each period's numbers.
const spendIn = (columns: ReadonlyArray<RlyChartColumn>, span: RlyChartSelection): string =>
  bookings
    .map((booking) => {
      const total = columns
        .slice(span.from, span.to + 1)
        .flatMap((column) => column.segments)
        .filter((segment) => segment.id === booking.id)
        .reduce((sum, segment) => sum + segment.value, 0)
      return `${booking.label} ${dollars(total)}`
    })
    .join(", ")

const Chart = ({ columns }: { readonly columns: ReadonlyArray<RlyChartColumn> }) => {
  const [selection, setSelection] = useState<RlyChartSelection | null>(null)
  const describe = useCallback(
    (span: RlyChartSelection | null) =>
      // Names the period, so moving between equal-sized spans is announced too.
      span === null
        ? "No span selected"
        : `${day.format(columns[span.from]?.start ?? 0)} to ${day.format(columns[span.to]?.end ?? 0)}, ${span.to - span.from + 1} hours selected: ${spendIn(columns, span)}`,
    [columns]
  )
  return (
    <main style={pageStyle}>
      <Text as="h1" variant="section-title">
        Spend by booking
      </Text>
      <div style={stackStyle}>
        <StackedBars
          bands={bands}
          columns={columns}
          {...(columns.length === 0
            ? {}
            : {
                window: {
                  from: (columns[columns.length - 1]?.end ?? 0) - 5 * 3_600_000,
                  label: "Current 5-hour window",
                  to: columns[columns.length - 1]?.end ?? 0
                }
              })}
          data-selection={selection === null ? "none" : `${selection.from}-${selection.to}`}
          describeSelection={describe}
          formatScale={(max, size) => `$${max.toFixed(2)} per ${size === 1 ? "hour" : `${size} hours`}`}
          formatTick={(at) => day.format(at)}
          instructions="Arrow keys move between bars and select them. Shift with an arrow extends the span. Escape clears it."
          label="Spend by booking, API-equivalent dollars"
          noReadingLabel="Shaded: no reading"
          onSelectionChange={setSelection}
          selection={selection}
        />
        <ChartLegend items={bookings} label="Bookings by colour" />
        {columns.length === 0 ? null : <DataTable columns={columns} />}
        {columns.length === 0 ? null : <BandTable />}
      </div>
    </main>
  )
}

const meta = { component: StackedBars, tags: ["autodocs"], title: "Primitives/StackedBars" } satisfies Meta<
  typeof StackedBars
>
export default meta
type Story = StoryObj<typeof meta>

const fixedArgs = {
  columns: week,
  describeSelection: () => "",
  formatScale: () => "",
  formatTick: () => "",
  instructions: "Arrow keys move between bars.",
  label: "Spend",
  onSelectionChange: () => undefined,
  selection: null
} satisfies Meta<typeof StackedBars>["args"]

/** A week of hourly spend with two limit bands; keyboard selects, extends and clears a span. */
export const Week: Story = {
  args: fixedArgs,
  play: async ({ canvas, canvasElement }) => {
    const plot = canvas.getByRole("group", { name: "Spend by booking, API-equivalent dollars" })
    const root = canvasElement.querySelector("[data-selection]")
    await userEvent.click(plot)
    plot.focus()
    await userEvent.keyboard("{Escape}")
    await expect(root).toHaveAttribute("data-selection", "none")
    await userEvent.keyboard("{End}")
    const single = root?.getAttribute("data-selection") ?? ""
    await expect(single).not.toBe("none")
    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}")
    const [from, to] = (root?.getAttribute("data-selection") ?? "").split("-").map(Number)
    await expect((to ?? 0) - (from ?? 0)).toBeGreaterThan(0)
    await userEvent.keyboard("{Escape}")
    await expect(root).toHaveAttribute("data-selection", "none")
    await expect(canvasElement.querySelectorAll("[data-band]")).toHaveLength(2)
    await expect(canvas.getByText("Current 5-hour window")).toBeVisible()
    // Every mark the bands draw is named in the visible key.
    await expect(canvas.getByText("Dashed line: near the limit, 80%")).toBeVisible()
    await expect(canvas.getByText("Shaded: no reading")).toBeVisible()
    await expect(canvasElement.querySelectorAll('[data-part="window"]')).toHaveLength(3)
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1)
    // The table carries what the hidden SVG draws: every day, each booking's spend, each band's peak.
    const table = canvas.getByRole("table", { name: "Spend by booking and limit peaks per day" })
    await expect(within(table).getAllByRole("row")).toHaveLength(8)
    await expect(within(table).getByRole("columnheader", { name: "RLY-142 ledger export" })).toBeVisible()
    await expect(within(table).getByRole("columnheader", { name: "5-hour window peak" })).toBeVisible()
    await expect(within(table).getByRole("rowheader", { name: "Tue 29 Sept" })).toBeVisible()
    await expect(within(table).getAllByText("96%, partly no reading")).toHaveLength(1)
    // Band intervals are a table too: every stretch the bands draw, the gap included.
    const levels = canvas.getByRole("table", { name: "Limit levels over time" })
    await expect(within(levels).getAllByRole("row")).toHaveLength(
      1 + bands.reduce((sum, band) => sum + band.segments.length, 0)
    )
    await expect(within(levels).getByText("No reading")).toBeVisible()
    // The scale caption sits above the plot, so no bar can draw over it.
    const caption = canvasElement.querySelector<HTMLElement>("[class*='scale']")
    if (caption !== null) {
      await expect(caption.getBoundingClientRect().bottom).toBeLessThanOrEqual(plot.getBoundingClientRect().top + 1)
    }
    // Both tables scroll inside their own boxes, so the page never scrolls sideways.
    await expect(canvasElement.ownerDocument.documentElement.scrollWidth).toBeLessThanOrEqual(
      canvasElement.ownerDocument.documentElement.clientWidth
    )
  },
  render: () => <Chart columns={week} />
}

/** No columns yet: the plot stays one labelled stop and draws nothing. */
export const Empty: Story = {
  args: { ...fixedArgs, columns: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("group", { name: "Spend by booking, API-equivalent dollars" })).toBeVisible()
    // The legend keeps its swatches; the plot itself draws no series.
    const plot = canvas.getByRole("group", { name: "Spend by booking, API-equivalent dollars" })
    await expect(plot.querySelectorAll("[data-series]")).toHaveLength(0)
    await expect(canvas.queryByRole("table")).toBeNull()
  },
  render: () => <Chart columns={[]} />
}

import type { Meta, StoryObj } from "@storybook/react-vite"
import { useCallback, useState } from "react"
import { expect, userEvent } from "storybook/test"
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
    near: 80,
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
    near: 80,
    segments: [
      { from: start, level: 30, to: start + 90 * hour },
      { from: start + 90 * hour, level: 84, to: start + 168 * hour }
    ]
  }
]

const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit" })

const Chart = ({ columns }: { readonly columns: ReadonlyArray<RlyChartColumn> }) => {
  const [selection, setSelection] = useState<RlyChartSelection | null>(null)
  const describe = useCallback(
    (span: RlyChartSelection | null) =>
      span === null ? "No span selected" : `${span.to - span.from + 1} hours selected`,
    []
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
          data-selection={selection === null ? "none" : `${selection.from}-${selection.to}`}
          describeSelection={describe}
          formatScale={(max, size) => `$${max.toFixed(2)} per ${size === 1 ? "hour" : `${size} hours`}`}
          formatTick={(bin) => day.format(bin.start)}
          instructions="Arrow keys move between bars and select them. Shift with an arrow extends the span. Escape clears it."
          label="Spend by booking, API-equivalent dollars"
          onSelectionChange={setSelection}
          selection={selection}
        />
        <ChartLegend items={bookings} label="Bookings by colour" />
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
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1)
  },
  render: () => <Chart columns={week} />
}

/** No columns yet: the plot stays one labelled stop and draws nothing. */
export const Empty: Story = {
  args: { ...fixedArgs, columns: [] },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("group", { name: "Spend by booking, API-equivalent dollars" })).toBeVisible()
    await expect(canvasElement.querySelectorAll("[data-series]")).toHaveLength(0)
  },
  render: () => <Chart columns={[]} />
}

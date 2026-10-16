import { PortalProvider } from "@knpkv/rly/foundations"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ReactNode } from "react"
import { expect, waitFor } from "storybook/test"
import { BookingTable } from "../src/ui/BookingTable.js"
import { assignSlots, bookingLabel, OTHER, stackUsage } from "../src/usage/chartModel.js"
import { LimitChart } from "../src/usage/LimitChart.js"
import { LimitsSummary } from "../src/limits/LimitsSummary.js"
import { StatusStrip } from "../src/ui/StatusStrip.js"
import { UsageChart } from "../src/usage/UsageChart.js"
import type { LimitReading, LimitSnapshot } from "../src/core/Model.js"
import type { LimitSeries, ServerStatus } from "../src/shared/contracts.js"
import { buildWeek, type Scenario, TIME_ZONE } from "./fixtures/week.js"

/**
 * The agent-usage page as it ships today, piece by piece, over the fixture week. These stories are
 * the visual baseline the redesign replaces.
 */
const meta = {
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"],
  title: "Agent usage/Current screen"
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const Page = ({ children }: { readonly children: ReactNode }) => (
  <div className="usage-shell">
    <PortalProvider>
      <main className="usage-app">{children}</main>
    </PortalProvider>
  </div>
)

const viewOf = (scenario: Scenario) => {
  const week = buildWeek(scenario)
  const stacked = stackUsage(week.usage, "cost", null)
  const named = stacked.series.map((series) => series.id).filter((id) => id !== OTHER)
  const slots = assignSlots(new Map(), named)
  const labels = new Map(week.usage.bookings.map((summary) => [summary.id, bookingLabel(summary.booking)]))
  return {
    week,
    stacked,
    named: new Set(named),
    slots,
    labelOf: (id: string) => (id === OTHER ? "Other" : (labels.get(id) ?? id)),
    range: week.range
  }
}

const status: ServerStatus = {
  machine: "workstation",
  ingest: null,
  ingestFailure: null,
  limitsFailure: null,
  ticketLookupFailures: []
}

export const LimitsNow: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getAllByText(/5-hour/).length).toBeGreaterThan(0)
  },
  render: () => {
    const { week } = viewOf("binding")
    return (
      <Page>
        <LimitsSummary
          balances={week.limits.balances}
          latest={week.limits.latest}
          now={week.now}
          series={week.limits.series}
        />
      </Page>
    )
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const projectionNow = Date.UTC(2026, 9, 16, 10, 0)
const known = (usedPercent: number, resetsAt: number): LimitReading => ({ _tag: "Known", usedPercent, resetsAt })
const fiveHourReset = projectionNow + 4 * HOUR + 12 * MINUTE
const weeklyReset = projectionNow + 3 * 24 * HOUR + 4 * HOUR
const projectionLatest: ReadonlyArray<LimitSnapshot> = [
  {
    agent: "claude",
    machine: "workstation",
    source: "claude-oauth-usage",
    label: "five_hour",
    windowMinutes: 300,
    observedAt: projectionNow - 2 * MINUTE,
    reading: known(62, fiveHourReset)
  },
  {
    agent: "claude",
    machine: "workstation",
    source: "claude-oauth-usage",
    label: "seven_day",
    windowMinutes: 10_080,
    observedAt: projectionNow - 2 * MINUTE,
    reading: known(41, weeklyReset)
  },
  {
    agent: "codex",
    machine: "workstation",
    source: "codex-rollout",
    label: "primary",
    windowMinutes: 300,
    observedAt: projectionNow - 5 * MINUTE,
    reading: known(12, projectionNow + 3 * HOUR + 40 * MINUTE)
  }
]
const projectionSeries: ReadonlyArray<LimitSeries> = [
  {
    agent: "claude",
    label: "five_hour",
    windowMinutes: 300,
    points: [{ at: projectionNow - 90 * MINUTE, reading: known(46, fiveHourReset) }]
  },
  {
    agent: "claude",
    label: "seven_day",
    windowMinutes: 10_080,
    points: [{ at: projectionNow - 90 * MINUTE, reading: known(41, weeklyReset) }]
  }
]

/**
 * Each window's pace: Claude 5-hour runs out before its reset (Near limit under 80%), Weekly
 * lasts until its reset, Codex has too few readings to say.
 */
export const LimitProjection: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/at this pace: out/)).toBeVisible()
    await expect(canvas.getByText("lasts until reset")).toBeVisible()
    await expect(canvas.getByText("pace unknown · too few readings")).toBeVisible()
  },
  render: () => (
    <Page>
      <LimitsSummary balances={[]} latest={projectionLatest} now={projectionNow} series={projectionSeries} />
    </Page>
  )
}

export const UsageByBooking: Story = {
  play: async ({ canvasElement, globals }) => {
    await expect(TIME_ZONE).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    const dark =
      globals.theme === "dark" || (globals.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
    await waitFor(() => {
      expect(canvasElement.querySelectorAll(".usage-column-target")).toHaveLength(7)
      const segment = canvasElement.querySelector('.usage-segment[fill="var(--usage-series-1)"]')
      expect(segment).not.toBeNull()
      expect(segment === null ? null : getComputedStyle(segment).fill).toBe(
        dark ? "rgb(57, 135, 229)" : "rgb(42, 120, 214)"
      )
    })
  },
  render: () => {
    const view = viewOf("binding")
    return (
      <Page>
        <UsageChart
          labelOf={view.labelOf}
          measure="cost"
          range={view.range}
          label={`Usage per ${view.range.bucket}, stacked by booking`}
          periods={view.week.usage.periods}
          slots={view.slots}
          stacked={view.stacked}
        />
      </Page>
    )
  }
}

export const UsageByBookingLight: Story = { ...UsageByBooking, globals: { theme: "light" } }
export const UsageByBookingDark: Story = { ...UsageByBooking, globals: { theme: "dark" } }
export const UsageByBookingSystem: Story = { ...UsageByBooking, globals: { theme: "system" } }

export const LimitsOverTime: Story = {
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("svg")).not.toBeNull()
  },
  render: () => {
    const view = viewOf("binding")
    return (
      <Page>
        <LimitChart now={view.week.now} range={view.range} series={view.week.limits.series} />
      </Page>
    )
  }
}

export const Bookings: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText("RLY-142")).toBeVisible()
  },
  render: () => {
    const view = viewOf("binding")
    return (
      <Page>
        <BookingTable
          bookings={view.week.usage.bookings}
          named={view.named}
          onSelect={() => undefined}
          selected={null}
          slots={view.slots}
        />
      </Page>
    )
  }
}

export const Status: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/workstation/)).toBeVisible()
  },
  render: () => {
    const { week } = viewOf("binding")
    return <StatusStrip ignoredKeys={week.usage.ignoredKeys} now={week.now} status={status} />
  }
}

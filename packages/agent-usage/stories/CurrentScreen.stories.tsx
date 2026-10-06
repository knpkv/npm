import { PortalProvider } from "@knpkv/rly/foundations"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ReactNode } from "react"
import { expect, waitFor } from "storybook/test"
import { BookingTable } from "../src/client/BookingTable.js"
import { assignSlots, bookingLabel, OTHER, stackUsage } from "../src/client/chartModel.js"
import { LimitChart } from "../src/client/LimitChart.js"
import { LimitsSummary } from "../src/client/LimitsSummary.js"
import { StatusStrip } from "../src/client/StatusStrip.js"
import { UsageChart } from "../src/client/UsageChart.js"
import type { ServerStatus } from "../src/shared/contracts.js"
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
        <LimitsSummary balances={week.limits.balances} latest={week.limits.latest} now={week.now} />
      </Page>
    )
  }
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
          report={view.week.usage}
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

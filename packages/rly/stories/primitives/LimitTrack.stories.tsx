import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties } from "react"
import { expect } from "storybook/test"
import { ChartLegend } from "../../src/primitives/ChartLegend.js"
import { LimitTrack } from "../../src/primitives/LimitTrack.js"
import { Text } from "../../src/primitives/Text.js"
import { TrackKey } from "../../src/primitives/TrackKey.js"
import { forcedColoursActive, pageStyle, stackStyle } from "./storyStyles.js"

// One grid for every row, so all tracks share one width and one 0–100% scale; the value column
// wraps rather than pushing the page wider than a phone.
const gridStyle: CSSProperties = {
  alignItems: "center",
  display: "grid",
  gap: "var(--rly-space-8) var(--rly-space-12)",
  gridTemplateColumns: "minmax(0, 10rem) minmax(4rem, 1fr) auto"
}
const rowStyle: CSSProperties = { display: "contents" }

const limits = [
  { name: "5-hour window", state: "ok", value: 42, text: "42%" },
  { name: "Weekly", state: "near", value: 84, projected: 103, text: "84%, about 103% at reset" },
  { name: "Weekly, large model", state: "full", value: 100, text: "100%, at the limit" },
  { name: "Codex weekly", state: "stale", value: 61, stale: true, text: "61%, old reading" },
  { name: "Codex 5-hour", state: "unknown", value: null, text: "No reading" }
] satisfies ReadonlyArray<{
  readonly name: string
  readonly state: string
  readonly value: number | null
  readonly projected?: number
  readonly stale?: boolean
  readonly text: string
}>

const Limits = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Limits
    </Text>
    <div style={stackStyle}>
      <div style={gridStyle}>
        {limits.map((limit) => (
          <div data-limit={limit.name} data-state={limit.state} key={limit.name} style={rowStyle}>
            <Text variant="label">{limit.name}</Text>
            <LimitTrack
              {...("projected" in limit ? { projected: limit.projected } : {})}
              stale={"stale" in limit}
              value={limit.value}
            />
            <Text variant="label">{limit.text}</Text>
          </div>
        ))}
        <div data-limit="Dense row" style={rowStyle}>
          <Text variant="label">Dense row</Text>
          <LimitTrack size="slim" value={57} />
          <Text variant="label">57%</Text>
        </div>
      </div>
      <TrackKey
        items={[
          { label: "80%, near the limit", mark: "near" },
          { label: "Estimated level at reset", mark: "projected" },
          { label: "Old reading", mark: "stale" },
          { label: "No reading", mark: "unknown" }
        ]}
        label="What the track marks mean"
      />
    </div>
    <ChartLegend
      items={[
        { id: "a", label: "RLY-142 ledger export", series: 1 },
        { id: "b", label: "RLY-150 sync retry", series: 2 },
        { id: "c", label: "Review queue", series: 3 },
        { id: "d", label: "Other (4)", series: "other" }
      ]}
      label="Bookings by colour"
    />
  </main>
)

const meta = { component: LimitTrack, tags: ["autodocs"], title: "Primitives/LimitTrack" } satisfies Meta<
  typeof LimitTrack
>
export default meta
type Story = StoryObj<typeof meta>

const fillOf = (canvasElement: HTMLElement, name: string): Element | null =>
  canvasElement.querySelector(`[data-limit="${name}"] [data-part="fill"]`)

/** Every tone beside its number, with the key and a legend underneath. */
export const Gallery: Story = {
  args: { value: 42 },
  play: async ({ canvas, canvasElement }) => {
    const ink = (name: string): string => {
      const fill = fillOf(canvasElement, name)
      return fill === null ? "" : getComputedStyle(fill).backgroundColor
    }
    if (!forcedColoursActive(canvasElement)) {
      await expect(ink("Weekly")).not.toBe(ink("5-hour window"))
      await expect(ink("Weekly, large model")).not.toBe(ink("Weekly"))
    }
    // A decorative track hides its marks, so the text beside it carries the age and the projection.
    await expect(canvas.getByText("61%, old reading")).toBeVisible()
    await expect(canvas.getByText("84%, about 103% at reset")).toBeVisible()
    await expect(fillOf(canvasElement, "Codex 5-hour")).toBeNull()
    await expect(canvasElement.querySelectorAll('[data-part="projection"]')).toHaveLength(1)
    await expect(canvas.getByRole("list", { name: "What the track marks mean" })).toBeVisible()
    await expect(canvas.getByRole("list", { name: "Bookings by colour" })).toBeVisible()
    await expect(canvas.queryByRole("meter")).toBeNull()
  },
  render: () => <Limits />
}

/** A track with no number beside it is exposed as a meter with the caller's words. */
export const Meter: Story = {
  args: { decorative: false, label: "Weekly", value: 84, valueText: "84% used, about 103% at reset" },
  play: async ({ canvas }) => {
    const meter = canvas.getByRole("meter", { name: "Weekly" })
    await expect(meter).toHaveAttribute("aria-valuenow", "84")
    await expect(meter).toHaveAttribute("aria-valuetext", "84% used, about 103% at reset")
  },
  render: (args) => (
    <main style={pageStyle}>
      <LimitTrack {...args} projected={103} />
    </main>
  )
}

/** Without a reading, expose the caller's explanation rather than an indeterminate meter. */
export const Unknown: Story = {
  args: { decorative: false, label: "Weekly", value: null, valueText: "No reading yet" },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("img", { name: "Weekly: No reading yet" })).toBeVisible()
    await expect(canvas.queryByRole("meter")).toBeNull()
  },
  render: (args) => (
    <main style={pageStyle}>
      <LimitTrack {...args} />
    </main>
  )
}

import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { FreshnessStamp, type RlyFreshnessState } from "../../src/patterns/FreshnessStamp.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, rowStyle, stackStyle } from "../primitives/storyStyles.js"

const freshness = ["current", "cached", "stale", "missing", "unavailable"] satisfies ReadonlyArray<RlyFreshnessState>

const FreshnessMatrix = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Explicit source freshness
    </Text>
    <Text tone="secondary">
      Freshness is supplied by the application and remains a word, even when a time is available.
    </Text>
    <div style={stackStyle}>
      {freshness.map((state) => (
        <div key={state} style={rowStyle}>
          <FreshnessStamp dateTime="2026-07-13T14:00:00Z" state={state} time="Observed 2 minutes ago" />
          <FreshnessStamp size="compact" state={state} />
        </div>
      ))}
    </div>
  </main>
)

const meta = {
  component: FreshnessStamp,
  tags: ["autodocs"],
  title: "Patterns/FreshnessStamp"
} satisfies Meta<typeof FreshnessStamp>

export default meta
type Story = StoryObj<typeof meta>

export const Matrix: Story = {
  args: { state: "current" },
  play: async ({ canvas, canvasElement }) => {
    for (const word of ["Current", "Cached", "Stale", "Missing", "Unavailable"]) {
      await expect(canvas.getAllByText(word)).toHaveLength(2)
    }
    await expect(canvasElement.querySelectorAll("[data-rly-freshness-state]")).toHaveLength(10)
    await expect(canvasElement.querySelectorAll("time[datetime='2026-07-13T14:00:00Z']")).toHaveLength(5)
    canvasElement.dataset.freshnessStampPlayComplete = "true"
  },
  render: () => <FreshnessMatrix />
}

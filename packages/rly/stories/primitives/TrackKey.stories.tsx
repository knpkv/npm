import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { TrackKey } from "../../src/primitives/TrackKey.js"
import { pageStyle } from "./storyStyles.js"

const meta = { component: TrackKey, tags: ["autodocs"], title: "Primitives/TrackKey" } satisfies Meta<typeof TrackKey>
export default meta
type Story = StoryObj<typeof meta>

/** Every mark, for tracks that also draw a projection. */
export const AllMarks: Story = {
  args: {
    items: [
      { label: "80%, near the limit", mark: "near" },
      { label: "Estimated level at reset", mark: "projected" },
      { label: "Old reading", mark: "stale" }
    ],
    label: "What the track marks mean"
  },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole("listitem")).toHaveLength(3)
  },
  render: (args) => (
    <main style={pageStyle}>
      <TrackKey {...args} />
    </main>
  )
}

/** Only the marks the tracks draw: here no projection, so no projected mark. */
export const WithoutProjection: Story = {
  args: {
    items: [
      { label: "80%, near the limit", mark: "near" },
      { label: "Old reading", mark: "stale" }
    ],
    label: "What the track marks mean"
  },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole("listitem")).toHaveLength(2)
  },
  render: (args) => (
    <main style={pageStyle}>
      <TrackKey {...args} />
    </main>
  )
}

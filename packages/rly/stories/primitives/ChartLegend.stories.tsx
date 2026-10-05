import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { ChartLegend, RLY_SERIES } from "../../src/primitives/ChartLegend.js"
import { pageStyle } from "./storyStyles.js"

const meta = { component: ChartLegend, tags: ["autodocs"], title: "Primitives/ChartLegend" } satisfies Meta<
  typeof ChartLegend
>
export default meta
type Story = StoryObj<typeof meta>

/** All eight slots and the remainder, so neighbouring colours can be compared in both schemes. */
export const AllSeries: Story = {
  args: {
    items: RLY_SERIES.map((series) => ({
      id: String(series),
      label: series === "other" ? "Other (5)" : `Series ${series}`,
      series
    })),
    label: "Series by colour"
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getAllByRole("listitem")).toHaveLength(RLY_SERIES.length)
    const colours = [...canvasElement.querySelectorAll("[data-series]")].map(
      (swatch) => getComputedStyle(swatch).backgroundColor
    )
    await expect(new Set(colours).size).toBe(RLY_SERIES.length)
  },
  render: (args) => (
    <main style={pageStyle}>
      <ChartLegend {...args} />
    </main>
  )
}

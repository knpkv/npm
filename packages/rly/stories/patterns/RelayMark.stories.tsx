import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, ReactElement } from "react"
import { expect } from "storybook/test"
import { RelayMark, RLY_RELAY_MARK_SIZES, RLY_RELAY_MARK_TILE_SIZES } from "../../src/patterns/RelayMark.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, rowStyle, stackStyle } from "../primitives/storyStyles.js"

const meta = { component: RelayMark, tags: ["autodocs"], title: "Patterns/RelayMark" } satisfies Meta<typeof RelayMark>
export default meta
type Story = StoryObj<typeof meta>

const textMark: CSSProperties = { color: "var(--rly-color-text-1)" }
const secondaryMark: CSSProperties = { color: "var(--rly-color-text-2)" }

/** Every size bare in two text colours, and the tile at each size plus one labelled tile. */
const MarkCatalog = (): ReactElement => (
  <main style={pageStyle}>
    <div style={stackStyle}>
      <Text as="h1" variant="section-title">
        Relay mark
      </Text>
      <div data-row="bare" style={rowStyle}>
        {RLY_RELAY_MARK_SIZES.map((size) => (
          <RelayMark key={`text-${size}`} size={size} style={textMark} />
        ))}
        {RLY_RELAY_MARK_SIZES.map((size) => (
          <RelayMark key={`muted-${size}`} size={size} style={secondaryMark} />
        ))}
      </div>
      <div data-row="tile" style={rowStyle}>
        {RLY_RELAY_MARK_TILE_SIZES.map((size) => (
          <RelayMark.Tile key={size} size={size} />
        ))}
        <RelayMark.Tile label="Relay" size={32} />
      </div>
    </div>
  </main>
)

/** The bare mark at every size in two text colours, and on its tile; 16px must stay legible bare. */
export const Sizes: Story = {
  play: async ({ canvasElement }) => {
    const bare = canvasElement.querySelectorAll("[data-row='bare'] svg")
    await expect(bare).toHaveLength(RLY_RELAY_MARK_SIZES.length * 2)
    for (const svg of bare) await expect(svg.getAttribute("aria-hidden")).toBe("true")
    const tiles = canvasElement.querySelectorAll("[data-row='tile'] [data-size]")
    await expect(tiles).toHaveLength(RLY_RELAY_MARK_TILE_SIZES.length + 1)
    // The named mark is the one an assistive technology hears.
    await expect(canvasElement.querySelector("[role='img'][aria-label='Relay']")).not.toBeNull()
  },
  render: () => <MarkCatalog />
}

/** Forced colours: the bare mark follows CanvasText and the tile keeps its shape as an outline in its context's colour. */
export const ForcedColors: Story = {
  globals: { forcedColors: "active" },
  play: async ({ canvasElement }) => {
    const tile = canvasElement.querySelector("[data-row='tile'] [data-size]")
    await expect(tile).not.toBeNull()
    if (tile !== null) await expect(getComputedStyle(tile).borderTopStyle).toBe("solid")
  },
  render: () => <MarkCatalog />
}

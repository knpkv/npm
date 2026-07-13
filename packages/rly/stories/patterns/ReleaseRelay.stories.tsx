import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { ReleaseRelay, type RlyReleaseRelaySymbolIndices } from "../../src/patterns/ReleaseRelay.js"
import { Text } from "../../src/primitives/Text.js"
import { gridStyle, pageStyle, stackStyle, swatchStyle } from "../primitives/storyStyles.js"

const catalogGroups = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [9, 10, 11],
  [12, 13, 14],
  [15, 0, 1]
] satisfies ReadonlyArray<RlyReleaseRelaySymbolIndices>

const ReleaseRelayCatalog = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Release relay catalog
    </Text>
    <Text tone="secondary">
      Persisted symbol indices resolve to code-owned shapes; the application supplies the codename and algorithm
      version.
    </Text>
    <div style={gridStyle}>
      {catalogGroups.map((symbolIndices, index) => (
        <div key={symbolIndices.join("-")} style={swatchStyle}>
          <ReleaseRelay algorithm="relay/v1" codename={`Catalog Relay ${index + 1}`} symbolIndices={symbolIndices} />
        </div>
      ))}
      <div style={swatchStyle}>
        <ReleaseRelay algorithm="relay/v1" codename="Copper Orbit" size="hero" symbolIndices={[6, 3, 7]} />
      </div>
    </div>
  </main>
)

const GeometryCanary = () => (
  <main data-release-relay-canary="" style={pageStyle}>
    <Text as="h1" variant="section-title">
      Shape-stable release identity
    </Text>
    <div style={stackStyle}>
      <ReleaseRelay algorithm="relay/v1" codename="Copper Orbit" symbolIndices={[6, 3, 7]} />
      <ReleaseRelay algorithm="relay/v1" codename="Layered Anchor" size="hero" symbolIndices={[14, 2, 10]} />
    </div>
  </main>
)

const meta = {
  component: ReleaseRelay,
  tags: ["autodocs"],
  title: "Patterns/ReleaseRelay"
} satisfies Meta<typeof ReleaseRelay>

export default meta
type Story = StoryObj<typeof meta>

export const Catalog: Story = {
  args: { algorithm: "relay/v1", codename: "Copper Orbit", symbolIndices: [6, 3, 7] },
  play: async ({ canvas, canvasElement }) => {
    const indices = new Set(
      Array.from(canvasElement.querySelectorAll("[data-rly-release-symbol-index]"))
        .map((tile) => tile.getAttribute("data-rly-release-symbol-index"))
        .filter((index) => index !== null)
    )
    await expect(indices.size).toBe(16)
    await expect(canvasElement.querySelectorAll("[data-rly-release-relay-handoff]")).toHaveLength(7)
    await expect(
      canvas.getByRole("img", { name: "Release relay, Copper Orbit, symbols bridge, wave, beacon." })
    ).toBeVisible()
    canvasElement.dataset.releaseRelayCatalogPlayComplete = "true"
  },
  render: () => <ReleaseRelayCatalog />
}

export const GeometryForcedColors: Story = {
  args: { algorithm: "relay/v1", codename: "Copper Orbit", symbolIndices: [6, 3, 7] },
  globals: { forcedColors: "active", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const compactGraphic = canvas.getByRole("img", {
      name: "Release relay, Copper Orbit, symbols bridge, wave, beacon."
    })
    const heroGraphic = canvas.getByRole("img", {
      name: "Release relay, Layered Anchor, symbols stack, brace, anchor."
    })
    const compactTiles = compactGraphic.querySelectorAll("[data-rly-release-symbol-index]")
    const heroTiles = heroGraphic.querySelectorAll("[data-rly-release-symbol-index]")
    const compactFirst = compactTiles[0]
    const compactSecond = compactTiles[1]
    const heroFirst = heroTiles[0]
    const heroSecond = heroTiles[1]
    const compactRail = compactGraphic.querySelector("[data-rly-release-relay-handoff]")
    const heroRail = heroGraphic.querySelector("[data-rly-release-relay-handoff]")
    if (
      compactFirst === undefined ||
      compactSecond === undefined ||
      heroFirst === undefined ||
      heroSecond === undefined ||
      compactRail === null ||
      heroRail === null
    ) {
      throw new Error("ReleaseRelay geometry did not render")
    }

    await expect(compactGraphic.getBoundingClientRect().width).toBe(80)
    await expect(heroGraphic.getBoundingClientRect().width).toBe(140)
    await expect(compactTiles).toHaveLength(3)
    await expect(heroTiles).toHaveLength(3)
    for (const tile of compactTiles) await expect(tile.getBoundingClientRect().width).toBe(32)
    for (const tile of heroTiles) await expect(tile.getBoundingClientRect().width).toBe(52)
    await expect(compactSecond.getBoundingClientRect().left - compactFirst.getBoundingClientRect().right).toBe(-8)
    await expect(heroSecond.getBoundingClientRect().left - heroFirst.getBoundingClientRect().right).toBe(-8)
    await expect(compactRail.getBoundingClientRect().height).toBe(1)
    await expect(heroRail.getBoundingClientRect().height).toBe(1)

    const canary = canvasElement.querySelector<HTMLElement>("[data-release-relay-canary]")
    if (canary === null) throw new Error("ReleaseRelay geometry canary did not render")
    await expect(canary.scrollWidth).toBeLessThanOrEqual(canary.clientWidth)
    await expect(canvas.getAllByText("Identity algorithm: relay/v1")).toHaveLength(2)
    canvasElement.dataset.releaseRelayGeometryPlayComplete = "true"
  },
  render: () => <GeometryCanary />
}

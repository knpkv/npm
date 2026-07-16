import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties } from "react"
import { expect } from "storybook/test"
import { Surface } from "../../src/primitives/Surface.js"
import { Text } from "../../src/primitives/Text.js"
import { gridStyle, pageStyle } from "./storyStyles.js"

const contentStyle = { display: "grid", gap: "var(--rly-space-4)" } satisfies CSSProperties
const callerSpacingStyle = { ...contentStyle, padding: "var(--rly-space-16)" } satisfies CSSProperties

const SurfaceGallery = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Structural surfaces
    </Text>
    <div style={gridStyle}>
      <Surface data-surface-padding="none" data-surface-shape="card" data-surface-tone="primary" padding="none">
        <div style={callerSpacingStyle}>
          <Text as="h2" variant="card-title">
            Primary card
          </Text>
          <Text tone="secondary">Caller-owned spacing.</Text>
        </div>
      </Surface>
      <Surface
        data-surface-padding="compact"
        data-surface-shape="grouped"
        data-surface-tone="secondary"
        padding="compact"
        shape="grouped"
        tone="secondary"
      >
        <div style={contentStyle}>
          <Text as="h2" variant="card-title">
            Secondary group
          </Text>
          <Text tone="secondary">Compact grouped information.</Text>
        </div>
      </Surface>
      <Surface data-surface-padding="default" data-surface-tone="tertiary" padding="default" tone="tertiary">
        <div style={contentStyle}>
          <Text as="h2" variant="card-title">
            Tertiary inset
          </Text>
          <Text tone="secondary">Default internal spacing.</Text>
        </div>
      </Surface>
      <Surface data-surface-padding="spacious" padding="spacious">
        <div style={contentStyle}>
          <Text as="h2" variant="card-title">
            Spacious card
          </Text>
          <Text tone="secondary">Prominent grouped content.</Text>
        </div>
      </Surface>
    </div>
  </main>
)

const meta = { component: Surface, tags: ["autodocs"], title: "Primitives/Surface" } satisfies Meta<typeof Surface>
export default meta
type Story = StoryObj<typeof meta>
export const Gallery: Story = {
  args: { children: "Surface" },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getAllByRole("heading")).toHaveLength(5)
    await expect(canvasElement.querySelectorAll("[data-surface-padding]")).toHaveLength(4)
    await expect(canvasElement.querySelectorAll("[data-surface-tone]")).toHaveLength(3)
    await expect(canvasElement.querySelectorAll("[data-surface-shape]")).toHaveLength(2)
  },
  render: () => <SurfaceGallery />
}

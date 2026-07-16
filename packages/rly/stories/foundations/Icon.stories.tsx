import type { CSSProperties } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { Icon, RLY_ICON_DEFAULT_VARIANTS, RLY_ICON_NAMES, RLY_ICON_VARIANTS } from "../../src/foundations/Icon.js"

const pageStyle: CSSProperties = {
  background: "var(--rly-color-canvas)",
  color: "var(--rly-color-text-1)",
  display: "grid",
  gap: "var(--rly-space-32)",
  minHeight: "100vh",
  padding: "clamp(var(--rly-space-20), 5vw, var(--rly-space-64))"
}

const headerStyle: CSSProperties = {
  display: "grid",
  gap: "var(--rly-space-8)",
  maxWidth: "42rem"
}

const eyebrowStyle: CSSProperties = {
  color: "var(--rly-color-text-2)",
  fontSize: "var(--rly-type-label-size)",
  fontWeight: "var(--rly-type-label-weight)",
  letterSpacing: ".08em",
  margin: 0,
  textTransform: "uppercase"
}

const headingStyle: CSSProperties = {
  fontSize: "var(--rly-type-section-title-size)",
  fontWeight: "var(--rly-type-section-title-weight)",
  letterSpacing: "var(--rly-type-section-title-tracking)",
  lineHeight: "var(--rly-type-section-title-line-height)",
  margin: 0
}

const summaryStyle: CSSProperties = {
  color: "var(--rly-color-text-2)",
  fontSize: "var(--rly-type-body-large-size)",
  lineHeight: "var(--rly-type-body-large-line-height)",
  margin: 0
}

const catalogStyle: CSSProperties = {
  display: "grid",
  gap: "var(--rly-space-8)",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 9rem), 1fr))",
  listStyle: "none",
  margin: 0,
  padding: 0
}

const itemStyle: CSSProperties = {
  alignItems: "center",
  border: "1px solid var(--rly-color-border-1)",
  borderRadius: "var(--rly-radius-control)",
  display: "grid",
  gap: "var(--rly-space-12)",
  gridTemplateColumns: "1.5rem minmax(0, 1fr)",
  minHeight: "4rem",
  padding: "var(--rly-space-12) var(--rly-space-16)"
}

const nameStyle: CSSProperties = {
  color: "var(--rly-color-text-2)",
  fontFamily: "var(--rly-font-mono)",
  fontSize: "var(--rly-type-meta-size)",
  lineHeight: "var(--rly-type-meta-line-height)",
  overflowWrap: "anywhere"
}

const scaleStyle: CSSProperties = {
  alignItems: "center",
  borderBlockStart: "1px solid var(--rly-color-border-1)",
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--rly-space-24)",
  paddingBlockStart: "var(--rly-space-24)"
}

const scaleItemStyle: CSSProperties = {
  alignItems: "center",
  display: "inline-flex",
  gap: "var(--rly-space-8)"
}

const IconCatalog = () => (
  <main style={pageStyle}>
    <header style={headerStyle}>
      <p style={eyebrowStyle}>rly foundation</p>
      <h1 style={headingStyle}>Interface glyphs</h1>
      <p style={summaryStyle}>
        A small, current-color vocabulary for navigation and controls. Meaning stays in the surrounding label.
      </p>
    </header>

    <ul aria-label="Available icon names" style={catalogStyle}>
      {RLY_ICON_NAMES.map((name) => (
        <li key={name} style={itemStyle}>
          <Icon decorative name={name} />
          <code style={nameStyle}>{name}</code>
        </li>
      ))}
    </ul>

    <section aria-label="Icon sizes" style={scaleStyle}>
      {Object.entries(RLY_ICON_VARIANTS.size).map(([size, definition]) => (
        <span key={size} style={scaleItemStyle}>
          <Icon decorative name="search" size={size === "small" ? "small" : size === "large" ? "large" : "default"} />
          <span>
            {size} · {definition.pixels}px
          </span>
        </span>
      ))}
      <span style={scaleItemStyle}>
        <Icon label="Search interface" name="search" size={RLY_ICON_DEFAULT_VARIANTS.size} />
        <span>informative · labelled</span>
      </span>
    </section>
  </main>
)

const meta = {
  component: Icon,
  tags: ["autodocs"],
  title: "Foundations/Icon"
} satisfies Meta<typeof Icon>

export default meta
type Story = StoryObj<typeof meta>

export const Catalog: Story = {
  args: {
    decorative: true,
    name: "search"
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: "Interface glyphs" })).toBeVisible()
    await expect(canvas.getAllByRole("listitem")).toHaveLength(RLY_ICON_NAMES.length)
    await expect(canvas.getByText("Search interface")).toBeInTheDocument()
  },
  render: () => <IconCatalog />
}

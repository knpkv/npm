import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent } from "storybook/test"
import { Button } from "../../src/primitives/Button.js"
import { Region } from "../../src/patterns/Region.js"

const meta = {
  component: Region,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
  title: "Patterns/Region"
} satisfies Meta<typeof Region>
export default meta
type Story = StoryObj<typeof meta>

const rows = ["Rotate signing keys", "Bound patch reads", "Split the usage chunk"]

/** A list region and a tray of actionable cards side by side, as on a list + detail page. */
export const States: Story = {
  args: { children: null, title: "Queue" },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("region", { name: "Queue 3" })).toBeVisible()
    await expect(canvas.getByRole("region", { name: "Findings 2" })).toBeVisible()
    await expect(canvas.getByRole("heading", { level: 3, name: "Checks" })).toBeVisible()
    await expect(
      canvas.getByRole("region", { name: "Checks" }).closest("[data-rly-region] [data-rly-region]")
    ).toBeNull()
    const heading = canvas.getByRole("heading", { level: 2, name: "Findings 2" })
    heading.focus()
    await expect(heading).toHaveFocus()
    await userEvent.tab()
    await expect(canvas.getByRole("button", { name: "Acknowledge all" })).toHaveFocus()
  },
  render: () => (
    <div
      style={{
        display: "grid",
        gap: "var(--rly-space-24)",
        gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))"
      }}
    >
      <Region count={rows.length} title="Queue" tone="default">
        <ul style={{ display: "grid", gap: 0, listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((row, index) => (
            <li
              key={row}
              style={{
                // Rules sit between rows only; the region's own edge closes the list.
                borderBlockEnd: index < rows.length - 1 ? "1px solid var(--rly-color-border-1)" : "none",
                padding: "var(--rly-space-12) 0"
              }}
            >
              {row}
            </li>
          ))}
        </ul>
      </Region>
      <Region
        actions={<Button variant="secondary">Acknowledge all</Button>}
        count={2}
        headingId="findings-heading"
        title="Findings"
        tone="tray"
      >
        {["High: revocation can race publication", "Low: log line repeats the key id"].map((finding) => (
          <article
            key={finding}
            style={{
              background: "var(--rly-color-surface-1)",
              border: "1px solid var(--rly-color-border-1)",
              borderRadius: "var(--rly-radius-control)",
              padding: "var(--rly-space-12) var(--rly-space-16)"
            }}
          >
            {finding}
          </article>
        ))}
      </Region>
      <Region headingLevel={3} title="Checks">
        A level-3 region, for a block that sits under a page section heading.
      </Region>
    </div>
  )
}

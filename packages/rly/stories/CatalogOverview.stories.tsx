import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { Text } from "../src/primitives/Text.js"
import { pageStyle, stackStyle } from "./primitives/storyStyles.js"

const sections: ReadonlyArray<{ readonly id: string; readonly title: string; readonly summary: string }> = [
  { id: "foundations", summary: "Tokens, themes, icons, links, and portals.", title: "Foundations" },
  { id: "primitives", summary: "Reusable framework-neutral interface elements.", title: "Primitives" },
  { id: "patterns", summary: "Release, entity, provenance, and governed-action patterns.", title: "Patterns" },
  { id: "diff", summary: "Complete CodeCommit pull-request diff presentation.", title: "Diff workbench" }
]

// The catalog's front page in rly's own type and tokens: a page title, one line of purpose, and the sections.
const CatalogOverview = () => (
  <main aria-labelledby="catalog-title" style={pageStyle}>
    <div style={stackStyle}>
      <Text as="h1" id="catalog-title" variant="page-title">
        Component catalog
      </Text>
      <Text tone="secondary" variant="body-large">
        Release Relay: a quiet system for seeing people, evidence, delivery, and agents together.
      </Text>
      <nav aria-label="Catalog sections">
        <ul style={{ display: "grid", gap: "var(--rly-space-16)", listStyle: "none", margin: 0, padding: 0 }}>
          {sections.map((section) => (
            <li id={section.id} key={section.id}>
              <Text as="h2" variant="card-title">
                {section.title}
              </Text>
              <Text tone="secondary">{section.summary}</Text>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  </main>
)

const meta = {
  component: CatalogOverview,
  tags: ["autodocs"],
  title: "Catalog/Overview"
} satisfies Meta<typeof CatalogOverview>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: "Component catalog" })).toBeVisible()
    await expect(canvas.getByRole("navigation", { name: "Catalog sections" })).toBeInTheDocument()
  }
}

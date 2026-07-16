import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

const CatalogOverview = () => (
  <main aria-labelledby="catalog-title" style={{ margin: "0 auto", maxWidth: "72rem", padding: "4rem 2rem" }}>
    <p style={{ fontSize: "1rem", letterSpacing: "0.12em", textTransform: "uppercase" }}>rly · Release Relay</p>
    <h1 id="catalog-title" style={{ fontSize: "clamp(3rem, 9vw, 8rem)", letterSpacing: "-0.07em", lineHeight: 0.88 }}>
      Component catalog
    </h1>
    <p style={{ fontSize: "clamp(1.25rem, 3vw, 2.5rem)", lineHeight: 1.1, maxWidth: "24ch" }}>
      A quiet system for seeing people, evidence, delivery, and agents together.
    </p>

    <nav
      aria-label="Catalog sections"
      style={{ display: "flex", flexWrap: "wrap", gap: "1.5rem", marginBlock: "4rem" }}
    >
      <a href="#foundations">Foundations</a>
      <a href="#primitives">Primitives</a>
      <a href="#patterns">Patterns</a>
      <a href="#diff">Diff workbench</a>
    </nav>

    <section id="foundations">
      <h2>Foundations</h2>
      <p>Tokens, themes, icons, links, and portals.</p>
    </section>
    <section id="primitives">
      <h2>Primitives</h2>
      <p>Reusable framework-neutral interface elements.</p>
    </section>
    <section id="patterns">
      <h2>Patterns</h2>
      <p>Release, entity, provenance, and governed-action patterns.</p>
    </section>
    <section id="diff">
      <h2>Diff workbench</h2>
      <p>Complete CodeCommit pull-request diff presentation.</p>
    </section>
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

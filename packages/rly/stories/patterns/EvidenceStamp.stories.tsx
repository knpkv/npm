import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { EvidenceStamp } from "../../src/patterns/EvidenceStamp.js"
import type { RlyFreshnessState } from "../../src/patterns/FreshnessStamp.js"
import type { RlyService } from "../../src/patterns/ServiceMark.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const evidence = [
  { freshness: "current", service: "codecommit" },
  { freshness: "cached", service: "codepipeline" },
  { freshness: "stale", service: "jira" },
  { freshness: "missing", service: "confluence" },
  { freshness: "unavailable", service: "clockify" }
] satisfies ReadonlyArray<{ readonly freshness: RlyFreshnessState; readonly service: RlyService }>

const EvidenceGallery = () => (
  <main data-evidence-gallery="" style={pageStyle}>
    <Text as="h1" variant="section-title">
      Evidence ledger
    </Text>
    <Text tone="secondary">
      The source rail answers where; the separate freshness stamp answers whether that observation is current.
    </Text>
    <div style={stackStyle}>
      {evidence.map(({ freshness, service }) => (
        <EvidenceStamp
          freshness={freshness}
          freshnessDateTime="2026-07-13T14:00:00Z"
          freshnessTime="Checked 2 minutes ago"
          key={service}
          reference={`evidence/${service}/revision/sha256:49e8c718d805c92c59d73b86cf9a8f4e322a5761d24153a77f292ad5f4a730`}
          service={service}
        />
      ))}
    </div>
  </main>
)

const meta = {
  component: EvidenceStamp,
  tags: ["autodocs"],
  title: "Patterns/EvidenceStamp"
} satisfies Meta<typeof EvidenceStamp>

export default meta
type Story = StoryObj<typeof meta>

export const CompactForcedColors: Story = {
  args: { freshness: "current", reference: "CC-PR-482/revision/17", service: "codecommit" },
  globals: { forcedColors: "active", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    for (const name of ["CodeCommit", "CodePipeline", "Jira", "Confluence", "Clockify"]) {
      await expect(canvas.getByRole("img", { name })).toBeVisible()
    }
    for (const word of ["Current", "Cached", "Stale", "Missing", "Unavailable"]) {
      await expect(canvas.getByText(word)).toBeVisible()
    }

    const gallery = canvasElement.querySelector<HTMLElement>("[data-evidence-gallery]")
    if (gallery === null) throw new Error("Evidence gallery did not render")
    await expect(gallery.scrollWidth).toBeLessThanOrEqual(gallery.clientWidth)
    await expect(canvasElement.querySelectorAll("[data-rly-evidence-source]")).toHaveLength(5)
    await expect(canvasElement.querySelectorAll("[data-rly-evidence-freshness]")).toHaveLength(5)
    canvasElement.dataset.evidenceStampPlayComplete = "true"
  },
  render: () => <EvidenceGallery />
}

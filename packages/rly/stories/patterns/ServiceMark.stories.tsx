import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { type RlyService, ServiceMark } from "../../src/patterns/ServiceMark.js"
import { Text } from "../../src/primitives/Text.js"
import { gridStyle, pageStyle, swatchStyle } from "../primitives/storyStyles.js"

const services = ["codecommit", "codepipeline", "jira", "confluence", "clockify"] satisfies ReadonlyArray<RlyService>

const ServiceMarkGallery = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Service provenance
    </Text>
    <Text tone="secondary">
      Provider color identifies where evidence came from; each code-owned silhouette and full name carries the identity.
    </Text>
    <div style={gridStyle}>
      {services.map((service) => (
        <div key={service} style={swatchStyle}>
          <ServiceMark service={service} />
          <ServiceMark service={service} size="compact" />
        </div>
      ))}
    </div>
  </main>
)

const meta = {
  component: ServiceMark,
  tags: ["autodocs"],
  title: "Patterns/ServiceMark"
} satisfies Meta<typeof ServiceMark>

export default meta
type Story = StoryObj<typeof meta>

export const Gallery: Story = {
  args: { service: "codecommit" },
  play: async ({ canvas, canvasElement }) => {
    for (const name of ["CodeCommit", "CodePipeline", "Jira", "Confluence", "Clockify"]) {
      await expect(canvas.getAllByRole("img", { name })).toHaveLength(2)
    }
    await expect(canvasElement.querySelectorAll("[data-rly-service]")).toHaveLength(10)
    await expect(canvasElement.querySelectorAll("[data-rly-service] svg")).toHaveLength(10)
    canvasElement.dataset.serviceMarkPlayComplete = "true"
  },
  render: () => <ServiceMarkGallery />
}

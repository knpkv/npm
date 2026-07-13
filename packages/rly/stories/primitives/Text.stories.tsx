import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { Text, type RlyTextTone, type RlyTextVariant } from "../../src/primitives/Text.js"
import { pageStyle, rowStyle, stackStyle } from "./storyStyles.js"

const variants = [
  "verdict",
  "page-title",
  "section-title",
  "card-title",
  "body-large",
  "body",
  "label",
  "meta",
  "code"
] satisfies ReadonlyArray<RlyTextVariant>
const tones = ["primary", "secondary", "tertiary", "inherit"] satisfies ReadonlyArray<RlyTextTone>

const TextGallery = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Typography roles
    </Text>
    <div style={stackStyle}>
      {variants.map((variant) =>
        variant === "page-title" || variant === "section-title" || variant === "card-title" ? (
          <Text as="h2" data-text-variant={variant} key={variant} variant={variant}>
            {variant}
          </Text>
        ) : (
          <Text
            data-text-variant={variant}
            key={variant}
            tone={variant === "meta" ? "secondary" : "primary"}
            variant={variant}
          >
            {variant} — interface detail remains readable at every width.
          </Text>
        )
      )}
    </div>
    <div style={rowStyle}>
      {tones.map((tone) => (
        <Text data-text-tone={tone} key={tone} tone={tone}>
          {tone}
        </Text>
      ))}
    </div>
  </main>
)

const meta = { component: Text, tags: ["autodocs"], title: "Primitives/Text" } satisfies Meta<typeof Text>
export default meta
type Story = StoryObj<typeof meta>

export const Gallery: Story = {
  args: { children: "Readable copy", variant: "body" },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("heading", { name: "Typography roles" })).toBeVisible()
    await expect(canvas.getByText(/^verdict/)).toBeVisible()
    await expect(canvas.getAllByText(/^(primary|secondary|tertiary|inherit)$/)).toHaveLength(4)
    await expect(canvasElement.querySelectorAll("[data-text-variant]")).toHaveLength(9)
    await expect(canvasElement.querySelectorAll("[data-text-tone]")).toHaveLength(4)
  },
  render: () => <TextGallery />
}

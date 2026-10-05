import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { Button } from "../../src/primitives/Button.js"
import { Notice } from "../../src/primitives/Notice.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "./storyStyles.js"

const NoticeGallery = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Inline notices
    </Text>
    <div style={stackStyle}>
      <Notice data-notice-tone="neutral">Setting saved. Rescan sessions to update the suggestions.</Notice>
      <Notice data-notice-tone="positive" tone="positive">
        Logged 2h 30m to PROJ-142 in Clockify.
      </Notice>
      <Notice
        action={<Button size="compact">Retry</Button>}
        announce="assertive"
        data-notice-tone="critical"
        tone="critical"
      >
        Clockify rejected the entry: the workspace is archived.
      </Notice>
      <Notice data-notice-tone="caution" tone="caution">
        Jira is read-only for this week. Suggestions can still be logged to Clockify.
      </Notice>
      <Notice announce="polite" data-notice-tone="progress" tone="progress">
        Reading sessions from the last seven days.
      </Notice>
    </div>
  </main>
)

const NarrowAction = () => (
  <main style={{ ...pageStyle, maxInlineSize: "20rem" }}>
    <Notice action={<Button size="compact">Rescan sessions</Button>} tone="caution">
      Directory mappings changed since the last read.
    </Notice>
  </main>
)

const meta = { component: Notice, tags: ["autodocs"], title: "Primitives/Notice" } satisfies Meta<typeof Notice>
export default meta
type Story = StoryObj<typeof meta>

export const Gallery: Story = {
  args: { children: "Setting saved." },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent("Clockify rejected the entry")
    await expect(canvas.getByRole("status")).toHaveTextContent("Reading sessions")
    await expect(canvasElement.querySelectorAll("[data-notice-tone]")).toHaveLength(5)
  },
  render: () => <NoticeGallery />
}

/** The action wraps below the message instead of squeezing it at narrow widths. */
export const NarrowWithAction: Story = {
  args: { children: "Directory mappings changed." },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Rescan sessions" })).toBeVisible()
  },
  render: () => <NarrowAction />
}

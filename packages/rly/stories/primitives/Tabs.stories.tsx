import { useState } from "react"
import type { CSSProperties } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"
import { Surface } from "../../src/primitives/Surface.js"
import { Tabs, type RlyTabItem } from "../../src/primitives/Tabs.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "./storyStyles.js"

const narrowStyle: CSSProperties = { maxWidth: "20rem" }

const panel = (title: string, detail: string) => (
  <Surface padding="compact" tone="secondary">
    <Text as="h2" variant="card-title">
      {title}
    </Text>
    <Text tone="secondary">{detail}</Text>
  </Surface>
)

const items = [
  {
    content: panel("Summary", "The current decision and its concise supporting reason."),
    label: "Summary",
    value: "summary"
  },
  {
    content: panel("Evidence", "Recorded checks and source material supporting the decision."),
    label: "Evidence",
    value: "evidence"
  },
  {
    content: panel("History", "This section is unavailable until a decision has changed."),
    disabled: true,
    label: "Decision history and governed actions",
    value: "history"
  },
  {
    content: panel("Activity", "Recent human and automated updates in chronological order."),
    label: "Activity",
    value: "activity"
  }
] satisfies ReadonlyArray<RlyTabItem>

const TabsInteraction = () => {
  const [value, setValue] = useState("summary")

  return (
    <main style={pageStyle}>
      <Text as="h1" variant="section-title">
        Section navigation
      </Text>
      <div style={stackStyle}>
        <Text tone="secondary">
          Selection stays with the owner while keyboard behavior and relationships remain inside rly.
        </Text>
        <Tabs
          aria-label="Release sections"
          data-tabs-size="default"
          items={items}
          onValueChange={setValue}
          value={value}
        />
      </div>
      <section aria-label="Narrow layout" style={narrowStyle}>
        <Text as="h2" variant="card-title">
          Narrow reflow
        </Text>
        <Tabs
          aria-label="Narrow release sections"
          data-tabs-size="large"
          defaultValue="evidence"
          items={items}
          size="large"
        />
      </section>
    </main>
  )
}

const meta = { component: Tabs, tags: ["autodocs"], title: "Primitives/Tabs" } satisfies Meta<typeof Tabs>
export default meta
type Story = StoryObj<typeof meta>

export const Interaction: Story = {
  args: { "aria-label": "Release sections", items },
  play: async ({ canvas, canvasElement }) => {
    const releaseTabs = within(canvas.getByRole("tablist", { name: "Release sections" }))
    const summary = releaseTabs.getByRole("tab", { name: "Summary" })
    const evidence = releaseTabs.getByRole("tab", { name: "Evidence" })
    const disabled = releaseTabs.getByRole("tab", { name: "Decision history and governed actions" })

    await expect(summary).toHaveAttribute("aria-selected", "true")
    await userEvent.click(evidence)
    await expect(evidence).toHaveAttribute("aria-selected", "true")
    await userEvent.click(summary)
    await userEvent.keyboard("{ArrowRight}")
    await expect(evidence).toHaveFocus()
    await expect(evidence).toHaveAttribute("aria-selected", "true")
    await expect(disabled).toBeDisabled()

    const narrowList = canvas.getByRole("tablist", { name: "Narrow release sections" })
    await expect(getComputedStyle(narrowList).flexWrap).toBe("wrap")
    await expect(canvasElement.querySelectorAll("[data-tabs-size]")).toHaveLength(2)
    canvasElement.dataset.tabsPlayComplete = "true"
  },
  render: () => <TabsInteraction />
}

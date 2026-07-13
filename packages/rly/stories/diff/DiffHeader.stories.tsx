import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { DiffHeader, type RlyDiffFindingFilter, type RlyDiffLayout } from "../../src/diff/DiffHeader.js"
import { pageStyle } from "../primitives/storyStyles.js"

const ControlledHeader = ({ indexedCount = 500 }: { readonly indexedCount?: number }): ReactElement => {
  const [layout, setLayout] = useState<RlyDiffLayout>("split")
  const [isWrapped, setIsWrapped] = useState(false)
  const [findingFilter, setFindingFilter] = useState<RlyDiffFindingFilter>("all")
  return (
    <DiffHeader
      findingFilter={findingFilter}
      heading="PR-184 · Payments idempotency"
      indexedCount={indexedCount}
      isWrapped={isWrapped}
      layout={layout}
      onFindingFilterChange={setFindingFilter}
      onLayoutChange={setLayout}
      onWrapChange={setIsWrapped}
      selectedFileLabel="src/payments/authorize.ts"
      totalCount={500}
    />
  )
}

const narrowStyle = { inlineSize: "100%", maxInlineSize: "320px" }

const meta = {
  args: {
    findingFilter: "all",
    heading: "PR-184 · Payments idempotency",
    indexedCount: 500,
    isWrapped: false,
    layout: "split",
    onFindingFilterChange: () => undefined,
    onLayoutChange: () => undefined,
    onWrapChange: () => undefined,
    totalCount: 500
  },
  component: DiffHeader,
  tags: ["autodocs"],
  title: "Diff/DiffHeader"
} satisfies Meta<typeof DiffHeader>

export default meta
type Story = StoryObj<typeof meta>

export const ControlledPreferences: Story = {
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Stacked" }))
    await expect(canvas.getByRole("button", { name: "Stacked" })).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(canvas.getByRole("button", { name: "Wrap lines" }))
    await expect(canvas.getByRole("button", { name: "Wrap lines" })).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(canvas.getByRole("button", { name: "Agent" }))
    await expect(canvas.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true")
    canvasElement.dataset.diffHeaderControlsPlayComplete = "true"
  },
  render: () => (
    <main style={pageStyle}>
      <ControlledHeader />
    </main>
  )
}

export const Indexing: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("384")).toBeVisible()
    await expect(canvas.getByText("of 500 files indexed")).toBeVisible()
    await expect(canvas.getByRole("progressbar")).toHaveAttribute("value", "384")
    canvasElement.dataset.diffHeaderIndexingPlayComplete = "true"
  },
  render: () => (
    <main style={pageStyle}>
      <ControlledHeader indexedCount={384} />
    </main>
  )
}

export const CompactForcedColors: Story = {
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvasElement }) => {
    const canary = canvasElement.querySelector<HTMLElement>("[data-diff-header-compact]")
    if (canary === null) throw new Error("DiffHeader compact canary did not render")
    await expect(canary.scrollWidth).toBeLessThanOrEqual(canary.clientWidth)
    canvasElement.dataset.diffHeaderCompactPlayComplete = "true"
  },
  render: () => (
    <main data-diff-header-compact="" style={{ ...pageStyle, ...narrowStyle }}>
      <ControlledHeader indexedCount={384} />
    </main>
  )
}

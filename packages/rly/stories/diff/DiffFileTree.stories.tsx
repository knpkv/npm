import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { DiffFileTree, type RlyDiffFile } from "../../src/diff/DiffFileTree.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle } from "../primitives/storyStyles.js"

const stateFiles = [
  { change: "added", content: { state: "ready" }, id: "added", path: "src/payments/idempotency.ts" },
  {
    change: "modified",
    content: { label: "Loading content", state: "loading" },
    id: "loading",
    path: "src/payments/authorize.ts"
  },
  { change: "deleted", content: { reason: "PNG image", state: "binary" }, id: "binary", path: "assets/old-flow.png" },
  {
    change: "renamed",
    content: { reason: "Generated API client", state: "generated" },
    id: "generated",
    path: "src/client/payment-api.ts",
    previousPath: "src/generated/payment-api.ts"
  },
  {
    change: "modified",
    content: { reason: "Exceeds the 2 MiB viewing limit", state: "oversized" },
    id: "oversized",
    path: "fixtures/ledger.json"
  },
  {
    change: "modified",
    content: { reason: "CodeCommit timed out", state: "unavailable" },
    id: "unavailable",
    path: "src/settlement/ledger.ts"
  },
  {
    change: "modified",
    content: { reason: "Content could not be decoded", state: "error" },
    id: "error",
    path: "src/reconcile.ts"
  }
] satisfies ReadonlyArray<RlyDiffFile>

const fiveHundred = Array.from({ length: 500 }, (_, index): RlyDiffFile => ({
  change: index === 0 ? "added" : index % 23 === 0 ? "deleted" : "modified",
  content: index % 97 === 0 ? { reason: "Large generated fixture", state: "oversized" } : { state: "ready" },
  id: `inventory-file-${index + 1}`,
  path: `src/payments/segment-${String(index + 1).padStart(3, "0")}.ts`
}))

const ControlledInventory = ({ files = stateFiles }: { readonly files?: ReadonlyArray<RlyDiffFile> }): ReactElement => {
  const [selectedFileId, setSelectedFileId] = useState(files[0]?.id)
  return (
    <DiffFileTree
      data={{ files, state: "ready" }}
      heading="PR-184 file inventory"
      onSelectedFileChange={setSelectedFileId}
      {...(selectedFileId === undefined ? {} : { selectedFileId })}
    />
  )
}

const narrowStyle = { inlineSize: "100%", maxInlineSize: "320px" }

const meta = {
  component: DiffFileTree,
  tags: ["autodocs"],
  title: "Diff/DiffFileTree"
} satisfies Meta<typeof DiffFileTree>

export default meta
type Story = StoryObj<typeof meta>

export const FileStates: Story = {
  args: {
    data: { files: stateFiles, state: "ready" },
    heading: "PR-184 file inventory",
    onSelectedFileChange: () => undefined
  },
  play: async ({ canvas, canvasElement }) => {
    const completeInventory = canvas.getByRole("navigation", { name: "PR-184 file inventory" })
    await expect(completeInventory.querySelectorAll("[data-rly-diff-file-id]")).toHaveLength(7)
    await expect(completeInventory).toHaveTextContent("src/generated/payment-api.ts")
    await expect(completeInventory).toHaveTextContent("src/client/payment-api.ts")
    const lastFile = completeInventory.querySelector<HTMLButtonElement>("[data-rly-diff-file-id='error'] button")
    if (lastFile === null) throw new Error("Last complete inventory file did not render")
    await userEvent.click(lastFile)
    await expect(lastFile).toHaveAttribute("aria-current", "true")
    canvasElement.dataset.diffFileTreeStatesPlayComplete = "true"
  },
  render: () => (
    <main style={pageStyle}>
      <Text as="h1" variant="section-title">
        Every changed path stays visible
      </Text>
      <ControlledInventory />
      <DiffFileTree
        data={{
          files: stateFiles.slice(0, 2),
          indexedCount: 2,
          label: "Indexing 2 of 8 files",
          state: "loading",
          totalCount: 8
        }}
        heading="Indexing in progress"
        onSelectedFileChange={() => undefined}
      />
      <DiffFileTree
        data={{
          description: "Seven indexed paths remain available while the inventory can be retried.",
          files: stateFiles,
          indexedCount: 7,
          state: "error",
          title: "Indexing stopped at 7 of 8",
          totalCount: 8
        }}
        heading="Interrupted inventory"
        onSelectedFileChange={() => undefined}
      />
    </main>
  )
}

export const CompleteFiveHundred: Story = {
  args: {
    data: { files: fiveHundred, state: "ready" },
    heading: "500-file inventory",
    onSelectedFileChange: () => undefined
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-rly-diff-file-id]")).toHaveLength(500)
    await expect(canvasElement.querySelectorAll("pre")).toHaveLength(0)
    await expect(canvas.getByText("500/500")).toBeVisible()
    canvasElement.dataset.diffFileTreeFiveHundredPlayComplete = "true"
  },
  render: () => (
    <main style={pageStyle}>
      <ControlledInventory files={fiveHundred} />
    </main>
  )
}

export const CompactForcedColors: Story = {
  args: {
    data: { files: stateFiles, state: "ready" },
    heading: "Compact file inventory",
    onSelectedFileChange: () => undefined
  },
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvasElement }) => {
    const canary = canvasElement.querySelector<HTMLElement>("[data-diff-file-tree-compact]")
    if (canary === null) throw new Error("DiffFileTree compact canary did not render")
    await expect(canary.scrollWidth).toBeLessThanOrEqual(canary.clientWidth)
    await expect(canary.querySelectorAll("[data-rly-diff-file-id]")).toHaveLength(7)
    canvasElement.dataset.diffFileTreeCompactPlayComplete = "true"
  },
  render: () => (
    <main data-diff-file-tree-compact="" style={{ ...pageStyle, ...narrowStyle }}>
      <ControlledInventory />
    </main>
  )
}

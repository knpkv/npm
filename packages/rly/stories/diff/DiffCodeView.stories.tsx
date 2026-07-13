import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useRef, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { DiffCodeView } from "../../src/diff/DiffCodeView.js"
import type { RlyDiffCodeItem, RlyDiffCodeViewHandle } from "../../src/diff/types.js"
import { Button } from "../../src/primitives/Button.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const releaseItem = {
  after: {
    cacheKey: "release-gate-v2",
    contents: [
      "export const releaseGate = {",
      '  release: "2.8.0",',
      "  approvedPullRequests: 6,",
      "  blockers: 0,",
      '  verdict: "can-ship"',
      "}",
      ""
    ].join("\n"),
    name: "src/release-gate.ts"
  },
  before: {
    cacheKey: "release-gate-v1",
    contents: [
      "export const releaseGate = {",
      '  release: "2.8.0",',
      "  approvedPullRequests: 5,",
      "  blockers: 1,",
      '  verdict: "held"',
      "}",
      ""
    ].join("\n"),
    name: "src/release-gate.ts"
  },
  id: "release-gate"
} satisfies RlyDiffCodeItem

const auditItem = {
  after: {
    contents: 'export const auditEvidence = ["PR-184", "PR-191"]\n',
    name: "src/audit-evidence.ts"
  },
  before: {
    contents: 'export const auditEvidence = ["PR-184"]\n',
    name: "src/audit-evidence.ts"
  },
  id: "audit-evidence"
} satisfies RlyDiffCodeItem

const DiffHarness = (): ReactElement => {
  const diffRef = useRef<RlyDiffCodeViewHandle>(null)
  const [activity, setActivity] = useState("Two complete source versions")
  return (
    <main style={pageStyle}>
      <div style={{ ...stackStyle, inlineSize: "100%", maxInlineSize: "76rem" }}>
        <div>
          <Text as="h1" variant="section-title">
            Release gate change
          </Text>
          <Text tone="secondary">{activity}</Text>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--rly-space-8)" }}>
          <Button
            onClick={() => {
              diffRef.current?.addItems([auditItem])
              setActivity("Audit evidence appended without resetting the viewer")
            }}
            size="compact"
          >
            Add evidence file
          </Button>
          <Button
            onClick={() => {
              diffRef.current?.scrollTo({ align: "start", id: "release-gate", type: "item" })
              setActivity("Release gate brought into view")
            }}
            size="compact"
            variant="quiet"
          >
            Jump to release gate
          </Button>
        </div>
        <DiffCodeView
          ref={diffRef}
          annotations={[
            {
              id: "approved-check",
              itemId: "release-gate",
              lineNumber: 3,
              message: "All six linked pull requests are now approved.",
              side: "additions"
            }
          ]}
          contextLines={2}
          initialItems={[releaseItem]}
          selectedLines={{ id: "release-gate", range: { end: 5, side: "additions", start: 3 } }}
        />
      </div>
    </main>
  )
}

const meta = {
  component: DiffCodeView,
  tags: ["autodocs"],
  title: "Diff/DiffCodeView"
} satisfies Meta<typeof DiffCodeView>

export default meta
type Story = StoryObj<typeof meta>

export const Workbench: Story = {
  args: { initialItems: [releaseItem] },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelector("[data-rly-diff-code-view]")).not.toBeNull()
    await expect(canvasElement.querySelector("diffs-container")).not.toBeNull()
    await expect(canvas.getByText("All six linked pull requests are now approved.")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Add evidence file" }))
    await expect(canvas.getByText("Audit evidence appended without resetting the viewer")).toBeVisible()
    await expect(canvasElement.querySelectorAll("diffs-container")).toHaveLength(2)
    canvasElement.dataset.diffCodeViewWorkbenchPlayComplete = "true"
  },
  render: () => <DiffHarness />
}

export const StackedWrapped: Story = {
  args: {
    contextLines: 1,
    initialItems: [releaseItem, auditItem],
    mode: "stacked",
    virtualization: "strict",
    wrap: true
  },
  globals: { theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-rly-diff-mode='stacked']")).not.toBeNull()
    await expect(canvasElement.querySelectorAll("diffs-container").length).toBeGreaterThan(0)
    canvasElement.dataset.diffCodeViewStackedWrappedPlayComplete = "true"
  },
  render: (args) => (
    <main style={pageStyle}>
      <div style={{ ...stackStyle, inlineSize: "100%", maxInlineSize: "320px" }}>
        <DiffCodeView {...args} />
      </div>
    </main>
  )
}

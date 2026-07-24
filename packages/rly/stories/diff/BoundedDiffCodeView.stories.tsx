import type { Meta, StoryObj } from "@storybook/react-vite"
import { BoundedDiffCodeView } from "../../src/diff/bounded/BoundedDiffCodeView.js"
import type { RlyDiffCodeItem } from "../../src/diff/types.js"

const releaseItem = {
  after: {
    contents: [
      "export const releaseGate = {",
      "  approvedPullRequests: 6,",
      "  blockers: 0,",
      '  verdict: "can-ship"',
      "}",
      ""
    ].join("\n"),
    name: "src/release-gate.ts"
  },
  before: {
    contents: [
      "export const releaseGate = {",
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

const meta = {
  args: { initialItems: [releaseItem] },
  component: BoundedDiffCodeView,
  tags: ["autodocs"],
  title: "Diff/BoundedDiffCodeView"
} satisfies Meta<typeof BoundedDiffCodeView>

export default meta
type Story = StoryObj<typeof meta>

export const Split: Story = {}

export const StackedWrapped: Story = {
  args: { mode: "stacked", wrap: true },
  globals: { theme: "dark", viewport: { isRotated: false, value: "mobile1" } }
}

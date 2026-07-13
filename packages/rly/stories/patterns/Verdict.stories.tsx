import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, ReactElement } from "react"
import { expect } from "storybook/test"
import { Verdict, type VerdictProps } from "../../src/patterns/Verdict.js"
import { Text } from "../../src/primitives/Text.js"
import { gridStyle, pageStyle } from "../primitives/storyStyles.js"

const narrowStyle: CSSProperties = {
  inlineSize: "100%",
  maxInlineSize: "320px"
}

const verdicts = [
  {
    reason: "The release owner intentionally paused promotion for evidence review.",
    tone: "caution",
    verdict: "Held."
  },
  { reason: "The immutable head requires one recorded merge approval.", tone: "critical", verdict: "Blocked." },
  {
    reason: "The provider returned no authoritative object for this identity.",
    tone: "neutral",
    verdict: "Unavailable."
  },
  {
    reason: "Every required check and approval matches the current release head.",
    tone: "positive",
    verdict: "Ready."
  },
  { reason: "Production rollout is active in the first availability zone.", tone: "progress", verdict: "Deploying." }
] satisfies ReadonlyArray<VerdictProps>

const VerdictStates = (): ReactElement => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Release and entity verdicts
    </Text>
    <div style={gridStyle}>
      {verdicts.map((verdict) => (
        <Verdict {...verdict} key={verdict.tone} />
      ))}
    </div>
    <div data-verdict-narrow="" style={narrowStyle}>
      <Verdict
        reason="The immutable release head 4f9bb31a92cb47cba still needs an explicitly recorded production approver before deployment can begin."
        tone="caution"
        verdict="Production approval still required."
      />
    </div>
  </main>
)

const meta = {
  component: Verdict,
  tags: ["autodocs"],
  title: "Patterns/Verdict"
} satisfies Meta<typeof Verdict>

export default meta
type Story = StoryObj<typeof meta>

const args = {
  reason: "Every required check and approval matches the current release head.",
  tone: "positive",
  verdict: "Ready."
} satisfies Story["args"]

export const States: Story = {
  args,
  play: async ({ canvas, canvasElement }) => {
    for (const verdict of ["Held.", "Blocked.", "Unavailable.", "Ready.", "Deploying."]) {
      await expect(canvas.getByRole("heading", { name: verdict })).toBeVisible()
    }
    await expect(canvasElement.querySelectorAll("[data-rly-verdict-tone]")).toHaveLength(6)

    const narrow = canvasElement.querySelector<HTMLElement>("[data-verdict-narrow]")
    if (narrow === null) throw new Error("Verdict narrow story boundary did not mount")
    await expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)
  },
  render: () => <VerdictStates />
}

export const Dark: Story = {
  args,
  globals: { theme: "dark" },
  render: () => <VerdictStates />
}

export const ForcedColors: Story = {
  args,
  globals: { forcedColors: "active" },
  render: () => <VerdictStates />
}

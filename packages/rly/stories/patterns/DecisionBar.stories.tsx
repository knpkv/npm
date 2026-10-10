import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent } from "storybook/test"
import { DecisionBar, type RlyDecisionBarOutcome, type RlyDecisionBarState } from "../../src/patterns/DecisionBar.js"

const meta = {
  component: DecisionBar,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
  title: "Patterns/DecisionBar"
} satisfies Meta<typeof DecisionBar>
export default meta
type Story = StoryObj<typeof meta>

const target = "Reassign Rotate signing keys from arch to arch-b"

/** Ready (sends, then waits for the server), off with its reason, and the sticky phone bar. */
const Example = () => {
  const [ready, setReady] = useState<RlyDecisionBarState>({ _tag: "ready" })
  return (
    <div style={{ display: "grid", gap: "var(--rly-space-32)", maxInlineSize: "36rem" }}>
      <DecisionBar
        clock="4m 12s left"
        note="If it expires before your tap reaches the hub, you'll see the hub's refusal, not a success."
        onApprove={() => setReady({ _tag: "sending", action: "approve" })}
        onReject={() => setReady({ _tag: "sending", action: "reject" })}
        placement="inline"
        state={ready}
        target={target}
      />
      <DecisionBar
        clock="52s left"
        onApprove={() => undefined}
        onReject={() => undefined}
        state={{ _tag: "off", reason: "Off while the hub is unreachable (last contact 3m ago)." }}
        target="Apply nix config to luna"
      />
      <div style={{ blockSize: "12rem", border: "1px solid var(--rly-color-border-1)", overflow: "auto" }}>
        <p style={{ blockSize: "16rem", margin: 0, padding: "var(--rly-space-16)" }}>
          Request details scroll under the bar.
        </p>
        <DecisionBar
          onApprove={() => undefined}
          onReject={() => undefined}
          placement="sticky"
          state={{ _tag: "ready" }}
          target="Delegate agent work"
        />
      </div>
    </div>
  )
}

export const States: Story = {
  args: { onApprove: () => undefined, onReject: () => undefined, state: { _tag: "ready" }, target },
  play: async ({ canvas }) => {
    const approve = canvas.getByRole("button", { name: `Approve: ${target}` })
    const statuses = canvas.getAllByRole("status")
    await expect(statuses).toHaveLength(3)
    await expect(statuses[0]).toHaveTextContent("")
    await userEvent.click(approve)
    await expect(statuses[0]).toHaveTextContent("Approve sent; waiting for the server's answer.")
    await expect(approve).toHaveAttribute("aria-disabled", "true")
    await expect(approve).toHaveFocus()
    await expect(canvas.getByText("Approve sent; waiting for the server's answer.")).toBeVisible()

    const off = canvas.getByRole("button", { name: "Approve: Apply nix config to luna" })
    await expect(off).toHaveAttribute("aria-disabled", "true")
    await expect(off).toHaveAccessibleDescription("Off while the hub is unreachable (last contact 3m ago).")
    off.focus()
    await expect(off).toHaveFocus()
  },
  render: () => <Example />
}

const decided: ReadonlyArray<{ readonly by: string; readonly outcome: RlyDecisionBarOutcome }> = [
  { by: "by owner@example.com, 2m ago", outcome: { icon: "check", label: "Approved", tone: "positive" } },
  { by: "by owner@example.com, 5m ago", outcome: { icon: "close", label: "Rejected", tone: "critical" } },
  { by: "Nothing was applied.", outcome: { icon: "clock", label: "Expired", tone: "neutral" } }
]

/** A decided target: its outcome as a toned word, who and when quiet beside it. */
export const Outcomes: Story = {
  args: { onApprove: () => undefined, onReject: () => undefined, state: { _tag: "ready" }, target },
  play: async ({ canvas }) => {
    const statuses = canvas.getAllByRole("status")
    await expect(statuses).toHaveLength(3)
    await expect(statuses[0]).toHaveTextContent("Approvedby owner@example.com, 2m ago")
    const off = canvas.getAllByRole("button", { name: `Approve: ${target}` })[2]
    await expect(off).toHaveAccessibleDescription("Expired.")
  },
  render: () => (
    <div style={{ display: "grid", gap: "var(--rly-space-32)", maxInlineSize: "36rem" }}>
      {decided.map(({ by, outcome }) => (
        <DecisionBar
          key={outcome.label}
          onApprove={() => undefined}
          onReject={() => undefined}
          outcome={outcome}
          state={{ _tag: "off", reason: `${outcome.label}.` }}
          status={by}
          target={target}
        />
      ))}
    </div>
  )
}

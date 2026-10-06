import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent } from "storybook/test"
import { DecisionBar, type RlyDecisionBarState } from "../../src/patterns/DecisionBar.js"

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
    await userEvent.click(approve)
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

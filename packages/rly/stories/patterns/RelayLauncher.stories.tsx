import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, type ReactElement, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { RelayLauncher, useRelayShortcut } from "../../src/patterns/RelayLauncher.js"
import { Text } from "../../src/primitives/Text.js"
import { storyMedia } from "../storyMedia.js"
import { pageStyle } from "../primitives/storyStyles.js"

const meta = { component: RelayLauncher, tags: ["autodocs"], title: "Patterns/RelayLauncher" } satisfies Meta<
  typeof RelayLauncher
>
export default meta
type Story = StoryObj<typeof meta>

const header: CSSProperties = {
  alignItems: "center",
  borderBlockEnd: "1px solid var(--rly-color-border-1)",
  display: "flex",
  gap: "var(--rly-space-12)",
  justifyContent: "space-between",
  paddingBlock: "var(--rly-space-8)"
}

/** A host header with the launcher in its controls, toggling an open state like a real panel would. */
const HostHeader = ({ bindsShortcut = true }: { readonly bindsShortcut?: boolean }): ReactElement => {
  const [open, setOpen] = useState(false)
  const shortcut = useRelayShortcut()
  return (
    <main style={pageStyle}>
      <header style={header}>
        <Text as="h1" variant="card-title">
          infra-core #12
        </Text>
        <RelayLauncher
          expanded={open}
          onClick={() => setOpen((value) => !value)}
          shortcut={bindsShortcut ? shortcut : null}
        />
      </header>
      <p data-relay-state={open ? "open" : "closed"}>{open ? "Relay is open." : "Relay is closed."}</p>
    </main>
  )
}

/** The launcher in a header: it toggles, keeps a 32px (44px coarse) target and hides its hint on phones. */
export const Header: Story = {
  args: { expanded: false, shortcut: null },
  play: async ({ canvas, canvasElement }) => {
    const launcher = canvas.getByRole("button", { name: /Relay/ })
    await expect(launcher).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(launcher)
    await expect(launcher).toHaveAttribute("aria-expanded", "true")
    await expect(canvasElement.querySelector("[data-relay-state='open']")).not.toBeNull()
    const coarse = storyMedia(canvasElement, "(pointer: coarse)")
    await expect(launcher.getBoundingClientRect().height).toBeGreaterThanOrEqual(coarse ? 44 : 32)
    // It sits in the header's flow, never fixed over the page.
    await expect(getComputedStyle(launcher).position).toBe("static")
    const hint = launcher.querySelector("kbd")
    const phone = storyMedia(canvasElement, "(max-width: 40rem)")
    await expect(hint === null ? "none" : getComputedStyle(hint).display).toBe(phone ? "none" : "inline")
  },
  render: () => <HostHeader />
}

/** A host that keeps Ctrl/⌘+J for itself (a live terminal) shows no hint and claims no shortcut. */
export const WithoutShortcut: Story = {
  args: { expanded: false, shortcut: null },
  play: async ({ canvas }) => {
    const launcher = canvas.getByRole("button", { name: /Relay/ })
    await expect(launcher).not.toHaveAttribute("aria-keyshortcuts")
    await expect(launcher.querySelector("kbd")).toBeNull()
  },
  render: () => <HostHeader bindsShortcut={false} />
}

/** Forced colours: open is an inverted fill and a heavier border, never Highlight (the focus colour there). */
export const ForcedColors: Story = {
  args: { expanded: false, shortcut: null },
  globals: { forcedColors: "active" },
  play: async ({ canvas }) => {
    const launcher = canvas.getByRole("button", { name: /Relay/ })
    await userEvent.click(launcher)
    await expect(getComputedStyle(launcher).borderTopWidth).toBe("2px")
    await expect(getComputedStyle(launcher).backgroundColor).not.toBe(
      getComputedStyle(launcher.parentElement ?? launcher).backgroundColor
    )
  },
  render: () => <HostHeader />
}

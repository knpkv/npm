import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, type ReactElement, useRef, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { RelayLauncher, useRelayShortcut, useRelaySummon } from "../../src/patterns/RelayLauncher.js"
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

/**
 * A host header with the launcher, and a stand-in Relay region with its composer while open. The host
 * binds the shortcut it advertises through useRelaySummon, which also prevents the browser's own Ctrl+J.
 */
const HostHeader = ({ bindsShortcut = true }: { readonly bindsShortcut?: boolean }): ReactElement => {
  const [open, setOpen] = useState(false)
  const shortcut = useRelayShortcut()
  const region = useRef<HTMLElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  const bound = bindsShortcut ? shortcut : null
  useRelaySummon({ composer, fullscreen: false, launcher, onOpenChange: setOpen, open, region, shortcut: bound })
  return (
    <main style={pageStyle}>
      <header style={header}>
        <Text as="h1" variant="card-title">
          infra-core #12
        </Text>
        <RelayLauncher expanded={open} onClick={() => setOpen((value) => !value)} ref={launcher} shortcut={bound} />
      </header>
      <p data-relay-state={open ? "open" : "closed"}>{open ? "Relay is open." : "Relay is closed."}</p>
      {open ? (
        <section aria-label="Relay" ref={region}>
          <textarea aria-label="Message Relay" ref={composer} />
        </section>
      ) : null}
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
    // The advertised shortcut is bound: from the page it focuses the composer, from Relay it goes back,
    // and Escape in Relay closes it and returns focus to the launcher.
    const composer = canvas.getByRole("textbox", { name: "Message Relay" })
    await userEvent.keyboard("{Control>}j{/Control}")
    await expect(composer).toHaveFocus()
    await userEvent.keyboard("{Control>}j{/Control}")
    await expect(launcher).toHaveFocus()
    await expect(launcher).toHaveAttribute("aria-expanded", "true")
    await userEvent.keyboard("{Control>}j{/Control}")
    await userEvent.keyboard("{Escape}")
    await expect(launcher).toHaveAttribute("aria-expanded", "false")
    await expect(launcher).toHaveFocus()
    const coarse = storyMedia(canvasElement, "(pointer: coarse)")
    await expect(launcher.getBoundingClientRect().height).toBeGreaterThanOrEqual(coarse ? 44 : 32)
    // It sits in the header's flow, never fixed over the page.
    await expect(getComputedStyle(launcher).position).toBe("static")
    const hint = launcher.querySelector("kbd")
    const phone = storyMedia(canvasElement, "(max-width: 40rem)")
    // A flex item's display is blockified, so the check is shown versus hidden, not the display value.
    await expect(hint === null || getComputedStyle(hint).display === "none").toBe(phone)
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
    // Plain values: getComputedStyle is live, so comparing against it later would always pass.
    const fill = getComputedStyle(launcher).backgroundColor
    const ink = getComputedStyle(launcher).color
    await expect(getComputedStyle(launcher).borderTopWidth).toBe("2px")
    await expect(fill).not.toBe(getComputedStyle(launcher.parentElement ?? launcher).backgroundColor)
    // forced-color-adjust: none is inherited, so no descendant may keep an author colour on the fill.
    for (const element of launcher.querySelectorAll("*")) {
      const computed = getComputedStyle(element)
      await expect(computed.color).toBe(ink)
      if (element.tagName === "KBD") await expect(computed.borderTopColor).toBe(ink)
    }
  },
  render: () => <HostHeader />
}

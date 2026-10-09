import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, type ReactElement, useRef, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import { RelayLauncher, useRelayShortcut, useRelaySummon } from "../../src/patterns/RelayLauncher.js"
import { RelayPanel, type RelayPanelProps, type RlyRelayPanelPresentation } from "../../src/patterns/RelayPanel.js"
import { Text } from "../../src/primitives/Text.js"

const header: CSSProperties = {
  alignItems: "center",
  background: "var(--rly-color-surface-1)",
  borderBlockEnd: "1px solid var(--rly-color-border-1)",
  boxSizing: "border-box",
  display: "flex",
  justifyContent: "space-between",
  minBlockSize: "56px",
  paddingInline: "var(--rly-space-16)",
  position: "sticky",
  top: 0,
  zIndex: 10
}

/** The host publishes its header height as --rly-relay-panel-offset; the panel starts below it. */
const page = (pinned: boolean): CSSProperties =>
  Object.assign(
    {
      display: "grid",
      gridTemplateColumns: pinned ? "minmax(0, 1fr) 440px" : "minmax(0, 1fr)",
      minBlockSize: "100dvh"
    },
    { "--rly-relay-panel-offset": "56px" }
  )

const transcript = Array.from({ length: 24 }, (_, index) => (
  <p key={index}>
    Turn {index + 1}: Relay read patch-reader.ts and found the hunk header parser skips a trailing context line.
  </p>
))

const tabs = [
  { content: transcript, label: "Conversation", value: "conversation" },
  { content: <p>Three findings on this head.</p>, count: 3, label: "Findings", value: "findings" }
]

/**
 * A host page: a sticky header with the launcher, page content, and Relay rendered right after the
 * launcher so Tab order follows. The summon hook binds Ctrl/⌘+J.
 */
const HostPage = ({
  presentation,
  setup = false
}: {
  readonly presentation: RlyRelayPanelPresentation
  readonly setup?: boolean
}): ReactElement => {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState("conversation")
  const [pinned, setPinned] = useState(presentation === "pinned")
  // The pin moves Relay between the overlay and the column; full screen has no pin.
  const effective: RlyRelayPanelPresentation =
    presentation === "fullscreen" ? "fullscreen" : pinned ? "pinned" : "overlay"
  const launcher = useRef<HTMLButtonElement>(null)
  const shortcut = useRelayShortcut()
  const { composerRef, regionRef } = useRelaySummon({
    fullscreen: effective === "fullscreen",
    launcher,
    onOpenChange: setOpen,
    open,
    shortcut
  })
  const shared = {
    freshness: "Current head. Reads freely, asks before writes.",
    launcher,
    onClose: () => setOpen(false),
    presentation: effective,
    ref: regionRef,
    scope: { label: "infra-core #12", revision: "bbbbbbb" },
    // Setup has no composer; full screen has no room to pin.
    footer: setup ? undefined : (
      <textarea aria-label="Message Relay" ref={composerRef} rows={2} style={{ inlineSize: "100%" }} />
    ),
    pin: effective === "fullscreen" ? undefined : { onPinnedChange: setPinned, pinned }
  }
  const panel = setup ? (
    <RelayPanel {...shared}>
      <p>Choose the agent Relay runs, then what it focuses on.</p>
    </RelayPanel>
  ) : (
    <RelayPanel {...shared} onTabChange={setTab} selectedTab={tab} tabs={tabs} />
  )
  // Full screen portals out of the page, so the host provides the portal target.
  return (
    <PortalProvider>
      <div style={page(open && effective === "pinned")}>
        <div>
          <header style={header}>
            <Text as="h1" variant="card-title">
              infra-core #12
            </Text>
            <RelayLauncher
              expanded={open}
              onClick={() => setOpen((value) => !value)}
              ref={launcher}
              shortcut={shortcut}
            />
          </header>
          {open && effective !== "pinned" ? panel : null}
          <main data-page-content="" style={{ padding: "var(--rly-space-16)" }}>
            {Array.from({ length: 40 }, (_, index) => (
              <p key={index}>Diff line {index + 1} of src/patch-reader.ts</p>
            ))}
          </main>
        </div>
        {open && effective === "pinned" ? panel : null}
      </div>
    </PortalProvider>
  )
}

const meta = {
  component: RelayPanel,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"],
  title: "Patterns/RelayPanel"
} satisfies Meta<typeof RelayPanel>
export default meta
type Story = StoryObj<typeof meta>

const panelArgs = {
  children: null,
  launcher: { current: null },
  onClose: () => undefined,
  presentation: "overlay",
  scope: { label: "infra-core #12" }
} satisfies Partial<RelayPanelProps>

/**
 * overlay: over the right of the page, no backdrop; opening never moves the page, only the body
 * scrolls so the composer stays on screen, and Escape closes it back to the launcher.
 */
export const Overlay: Story = {
  args: panelArgs,
  play: async ({ canvas, canvasElement }) => {
    const region = canvas.getByRole("complementary", { name: "Relay" })
    await expect(getComputedStyle(region).position).toBe("fixed")
    await expect(canvasElement.querySelector("[aria-modal='true']")).toBeNull()
    const composer = canvas.getByRole("textbox", { name: "Message Relay" })
    await expect(composer.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight)
    // Closing never moves the page content (the overlay takes no layout).
    const content = canvasElement.querySelector("[data-page-content]")
    const before = content?.getBoundingClientRect().top
    await userEvent.click(composer)
    await userEvent.keyboard("{Escape}")
    await expect(canvas.queryByRole("complementary", { name: "Relay" })).toBeNull()
    await expect(canvas.getByRole("button", { name: /Relay/ })).toHaveFocus()
    await expect(content?.getBoundingClientRect().top).toBe(before)
  },
  render: () => <HostPage presentation="overlay" />
}

/** pinned: a sticky column in the host's grid, with the pin pressed. */
export const Pinned: Story = {
  args: { ...panelArgs, presentation: "pinned" },
  play: async ({ canvas }) => {
    const region = canvas.getByRole("complementary", { name: "Relay" })
    await expect(getComputedStyle(region).position).toBe("sticky")
    await expect(canvas.getByRole("button", { name: "Unpin" })).toHaveAttribute("aria-pressed", "true")
    // Unpinning turns the column back into the overlay.
    await userEvent.click(canvas.getByRole("button", { name: "Unpin" }))
    await expect(getComputedStyle(canvas.getByRole("complementary", { name: "Relay" })).position).toBe("fixed")
  },
  render: () => <HostPage presentation="pinned" />
}

/** fullscreen: a modal dialog over the whole viewport, closing back to the launcher. */
export const Fullscreen: Story = {
  args: { ...panelArgs, presentation: "fullscreen" },
  play: async ({ canvasElement }) => {
    const dialog = canvasElement.ownerDocument.querySelector("[data-rly-relay-panel='fullscreen']")
    await expect(dialog?.getAttribute("role")).toBe("dialog")
    await expect(dialog?.getBoundingClientRect().width).toBe(window.innerWidth)
    // The page behind is inert while Relay is full screen.
    await expect(canvasElement.closest("[inert]") ?? canvasElement.querySelector("[inert]")).not.toBeNull()
    await userEvent.keyboard("{Escape}")
    await expect(canvasElement.ownerDocument.querySelector("[data-rly-relay-panel]")).toBeNull()
  },
  render: () => <HostPage presentation="fullscreen" />
}

/** A single view without tabs (setup): the body fills the panel. */
export const Setup: Story = {
  args: panelArgs,
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("tablist")).toBeNull()
    // The overlay enters from opacity 0; visibility is judged once its entrance has finished.
    const region = canvas.getByRole("complementary", { name: "Relay" })
    await Promise.all(region.getAnimations().map((animation) => animation.finished))
    await expect(canvas.getByText(/Choose the agent/)).toBeVisible()
  },
  render: () => <HostPage presentation="overlay" setup />
}

/** Forced colours: the system drops the overlay's shadow, so a CanvasText edge keeps it apart. */
export const ForcedColors: Story = {
  args: panelArgs,
  globals: { forcedColors: "active" },
  play: async ({ canvas }) => {
    const region = canvas.getByRole("complementary", { name: "Relay" })
    await expect(getComputedStyle(region).borderTopStyle).toBe("solid")
  },
  render: () => <HostPage presentation="overlay" />
}

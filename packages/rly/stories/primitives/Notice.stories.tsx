import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { GlobalStyles } from "../../src/foundations/GlobalStyles.js"
import { ThemeProvider } from "../../src/foundations/ThemeProvider.js"
import { Button } from "../../src/primitives/Button.js"
import { Notice } from "../../src/primitives/Notice.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "./storyStyles.js"

const NoticeGallery = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Inline notices
    </Text>
    <div style={stackStyle}>
      <Notice data-notice-tone="neutral">Setting saved. Rescan sessions to update the suggestions.</Notice>
      <Notice data-notice-tone="positive" tone="positive">
        Logged 2h 30m to PROJ-142 in Clockify.
      </Notice>
      <Notice
        action={<Button size="compact">Retry</Button>}
        announce="assertive"
        data-notice-tone="critical"
        tone="critical"
      >
        Clockify rejected the entry: the workspace is archived.
      </Notice>
      <Notice data-notice-tone="caution" tone="caution">
        Jira is read-only for this week. Suggestions can still be logged to Clockify.
      </Notice>
      <Notice announce="polite" data-notice-tone="progress" tone="progress">
        Reading sessions from the last seven days.
      </Notice>
    </div>
  </main>
)

const NarrowAction = () => (
  <main style={{ ...pageStyle, maxInlineSize: "20rem" }}>
    <Notice action={<Button size="compact">Rescan sessions</Button>} tone="caution">
      Directory mappings changed since the last read.
    </Notice>
  </main>
)

const meta = { component: Notice, tags: ["autodocs"], title: "Primitives/Notice" } satisfies Meta<typeof Notice>
export default meta
type Story = StoryObj<typeof meta>

export const Gallery: Story = {
  args: { children: "Setting saved." },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent("Clockify rejected the entry")
    await expect(canvas.getByRole("status")).toHaveTextContent("Reading sessions")
    await expect(canvasElement.querySelectorAll("[data-notice-tone]")).toHaveLength(5)
  },
  render: () => <NoticeGallery />
}

/** The action wraps below the message instead of squeezing it at narrow widths. */
export const NarrowWithAction: Story = {
  args: { children: "Directory mappings changed." },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Rescan sessions" })).toBeVisible()
  },
  render: () => <NarrowAction />
}

/** The native `hidden` attribute hides a notice and its action, even though the notice sets its own display. */
export const Hidden: Story = {
  args: { children: "Hidden notice." },
  play: async ({ canvasElement }) => {
    // toBeVisible trusts the hidden attribute; only the computed box proves the cascade honours it.
    const [shown, hidden, revealed] = Array.from(canvasElement.querySelectorAll<HTMLElement>("main > div"))
    await expect(shown?.getBoundingClientRect().height).toBeGreaterThan(0)
    await expect(hidden?.hasAttribute("hidden")).toBe(true)
    await expect(hidden === undefined ? "missing" : getComputedStyle(hidden).display).toBe("none")
    // Unlayered application CSS still wins, as a print rule revealing inactive panels needs.
    await expect(revealed === undefined ? "missing" : getComputedStyle(revealed).display).toBe("block")

    const roots = Array.from(canvasElement.querySelectorAll<HTMLElement>("main > [data-rly-root]"))
    await expect(roots).toHaveLength(3)
    // Remove the outer catalog scope so it cannot hide a broken asChild root selector.
    const catalog = canvasElement.querySelector<HTMLElement>("[data-rly-catalog]")
    const catalogValue = catalog?.getAttribute("data-rly-catalog") ?? ""
    catalog?.removeAttribute("data-rly-catalog")
    try {
      for (const root of roots) {
        if (root.hidden === true) {
          await expect(getComputedStyle(root).display).toBe("none")
          await expect(root.getBoundingClientRect().height).toBe(0)
        } else {
          await expect(root.getBoundingClientRect().height).toBeGreaterThan(0)
          root.setAttribute("hidden", "until-found")
          try {
            await expect(getComputedStyle(root).display).toBe("flex")
          } finally {
            root.removeAttribute("hidden")
          }
        }
      }
    } finally {
      catalog?.setAttribute("data-rly-catalog", catalogValue)
    }
  },
  render: () => (
    <main style={pageStyle}>
      <Notice>Shown notice.</Notice>
      <Notice action={<Button size="compact">Retry hidden</Button>} hidden tone="critical">
        Hidden notice.
      </Notice>
      <style>{".app-reveal { display: block; }"}</style>
      <Notice className="app-reveal" hidden>
        Revealed by application CSS.
      </Notice>
      <GlobalStyles asChild>
        <Notice>Shown scope root.</Notice>
      </GlobalStyles>
      <GlobalStyles asChild>
        <Notice action={<Button size="compact">Retry hidden root</Button>} hidden tone="critical">
          Hidden scope root.
        </Notice>
      </GlobalStyles>
      <ThemeProvider asChild theme="light">
        <Notice hidden>Hidden theme root.</Notice>
      </ThemeProvider>
    </main>
  )
}

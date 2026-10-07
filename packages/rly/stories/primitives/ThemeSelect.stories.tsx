import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import { ThemeProvider, useDocumentTheme, useStoredTheme } from "../../src/foundations/ThemeProvider.js"
import { Text } from "../../src/primitives/Text.js"
import { ThemeSelect } from "../../src/primitives/ThemeSelect.js"
import { pageStyle, rowStyle, stackStyle } from "./storyStyles.js"

const STORY_KEY = "rly_story_theme"
const browserStorage = (): Storage => window.localStorage

/** A header keeps the label hidden; a settings page shows it. Both share one stored choice. */
const ThemeSelectGallery = () => {
  const [theme, setTheme] = useStoredTheme(STORY_KEY, browserStorage)
  useDocumentTheme(theme)
  return (
    <ThemeProvider data-story-theme theme={theme}>
      <PortalProvider>
        <main style={pageStyle}>
          <header style={{ ...rowStyle, justifyContent: "space-between" }}>
            <Text as="h1" variant="section-title">
              JCF
            </Text>
            <ThemeSelect labelVisibility="hidden" onValueChange={setTheme} value={theme} />
          </header>
          <section style={stackStyle}>
            <Text as="h2" variant="card-title">
              Settings
            </Text>
            <ThemeSelect labelVisibility="visible" onValueChange={setTheme} value={theme} />
          </section>
        </main>
      </PortalProvider>
    </ThemeProvider>
  )
}

const meta = { component: ThemeSelect, tags: ["autodocs"], title: "Primitives/ThemeSelect" } satisfies Meta<
  typeof ThemeSelect
>
export default meta
type Story = StoryObj<typeof meta>

/** A persistent demo: the choice survives reloads and syncs across tabs. */
export const Gallery: Story = {
  args: { onValueChange: () => undefined, value: "system" },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole("combobox", { name: "Appearance" })).toHaveLength(2)
    await expect(canvas.getByText("Appearance", { selector: "label" })).toBeVisible()
  },
  render: () => <ThemeSelectGallery />
}

/** Picking a theme in one control applies it to the page and the other control, then restores the viewer's choice. */
export const PicksTheme: Story = {
  args: { onValueChange: () => undefined, value: "system" },
  play: async ({ canvas, canvasElement }) => {
    const previous = window.localStorage.getItem(STORY_KEY)
    try {
      const [header, settings] = canvas.getAllByRole("combobox", { name: "Appearance" })
      if (header === undefined || settings === undefined) throw new Error("ThemeSelect gallery renders two controls")
      const target = header.textContent.includes("Dark") ? "Light" : "Dark"
      await userEvent.click(header)
      await userEvent.click(await within(canvasElement).findByRole("option", { name: target }))
      await expect(canvasElement.querySelector("[data-story-theme]")).toHaveAttribute(
        "data-theme",
        target.toLowerCase()
      )
      await expect(header).toHaveTextContent(target)
      await expect(settings).toHaveTextContent(target)
    } finally {
      if (previous === null) window.localStorage.removeItem(STORY_KEY)
      else window.localStorage.setItem(STORY_KEY, previous)
      // A direct write skips the hook; a storage event makes it re-read so the page ends consistent.
      window.dispatchEvent(new StorageEvent("storage", { key: STORY_KEY, storageArea: window.localStorage }))
    }
  },
  render: () => <ThemeSelectGallery />
}

/** The forwarded Select sizes: dense by default beside header controls, compact and default for forms. */
export const Sizes: Story = {
  args: { onValueChange: () => undefined, value: "system" },
  play: async ({ canvas }) => {
    const [dense, compact, standard] = canvas.getAllByRole("combobox", { name: "Appearance" })
    const height = (element: HTMLElement | undefined): number => element?.getBoundingClientRect().height ?? 0
    await expect(height(dense)).toBeLessThan(height(compact))
    await expect(height(compact)).toBeLessThan(height(standard))
  },
  render: () => (
    <PortalProvider>
      <main style={pageStyle}>
        <div style={stackStyle}>
          <ThemeSelect labelVisibility="hidden" onValueChange={() => undefined} size="dense" value="system" />
          <ThemeSelect labelVisibility="hidden" onValueChange={() => undefined} size="compact" value="system" />
          <ThemeSelect labelVisibility="hidden" onValueChange={() => undefined} size="default" value="system" />
        </div>
      </main>
    </PortalProvider>
  )
}

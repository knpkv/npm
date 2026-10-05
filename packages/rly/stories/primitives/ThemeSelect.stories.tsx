import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { ThemeProvider, useStoredTheme } from "../../src/foundations/ThemeProvider.js"
import { Text } from "../../src/primitives/Text.js"
import { ThemeSelect } from "../../src/primitives/ThemeSelect.js"
import { pageStyle, rowStyle, stackStyle } from "./storyStyles.js"

const browserStorage = (): Storage => window.localStorage

/** A header keeps the label hidden; a settings page shows it. Both share one stored choice. */
const ThemeSelectGallery = () => {
  const [theme, setTheme] = useStoredTheme("rly_story_theme", browserStorage)
  return (
    <ThemeProvider theme={theme}>
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
    </ThemeProvider>
  )
}

const meta = { component: ThemeSelect, tags: ["autodocs"], title: "Primitives/ThemeSelect" } satisfies Meta<
  typeof ThemeSelect
>
export default meta
type Story = StoryObj<typeof meta>

export const Gallery: Story = {
  args: { onValueChange: () => undefined, value: "system" },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole("combobox", { name: "Appearance" })).toHaveLength(2)
    await expect(canvas.getByText("Appearance", { selector: "label" })).toBeVisible()
  },
  render: () => <ThemeSelectGallery />
}

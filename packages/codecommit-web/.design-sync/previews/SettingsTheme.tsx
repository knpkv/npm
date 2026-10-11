// Fixtures from packages/codecommit-web/test/settings-page.test.ts.
import { SettingsTheme, ThemeProvider } from "@knpkv/codecommit-web-design-system"

// The app's private theme context is absent; its default selection is System.
/** System remains selected in the light presentation. */
export const LightSystem = () => <SettingsTheme />
/** Dark presentation, with the same default System selection. */
export const DarkSystem = () => <ThemeProvider theme="dark"><div className="dark" style={{ padding: 16, background: "var(--rly-color-canvas)", color: "var(--rly-color-text-1)" }}><SettingsTheme /></div></ThemeProvider>

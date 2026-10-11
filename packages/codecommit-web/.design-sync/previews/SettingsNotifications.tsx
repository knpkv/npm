// Fixtures from packages/codecommit-web/test/settings-page.test.ts.
import { SettingsNotifications, ThemeProvider } from "@knpkv/codecommit-web-design-system"

// No test fixture constructs notification permission or browser-storage state.
/** Browser-native permission and stored preferences in the light presentation. */
export const Light = () => <SettingsNotifications />
/** The same browser-native state in the dark presentation. */
export const Dark = () => <ThemeProvider theme="dark"><div className="dark" style={{ padding: 16, background: "var(--rly-color-canvas)", color: "var(--rly-color-text-1)" }}><SettingsNotifications /></div></ThemeProvider>

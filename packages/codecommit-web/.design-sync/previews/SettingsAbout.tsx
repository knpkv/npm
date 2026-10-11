// Fixtures from packages/codecommit-web/test/settings-page.test.ts and packages/codecommit-web/e2e/sandbox-layout.spec.ts.
import { SettingsAbout, ThemeProvider } from "@knpkv/codecommit-web-design-system"

/** The static shortcuts panel in the default light theme. */
export const Light = () => <SettingsAbout />
/** The same shortcuts panel in the dark theme. */
export const Dark = () => <ThemeProvider theme="dark"><div className="dark" style={{ padding: 16, background: "var(--rly-color-canvas)", color: "var(--rly-color-text-1)" }}><SettingsAbout /></div></ThemeProvider>

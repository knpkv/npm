// Fixtures from packages/codecommit-web/test/settings-sandbox.test.ts.
import { ConfigUnavailableView, SettingsSandboxView } from "@knpkv/codecommit-web-design-system"
import { failedConfig, loadingConfig, noop, readySandboxConfig, saveSandbox } from "../fixtures/settings.js"

const unavailable = () => <ConfigUnavailableView path="fixture-config.json" connectionDetail={null} onRetry={noop} />
/** A pinned sandbox image with the test's empty setup lists. */
export const Configured = () => <SettingsSandboxView config={readySandboxConfig} renderConfigUnavailable={unavailable} saveConfig={saveSandbox} />
/** Config has not arrived yet. */
export const Loading = () => <SettingsSandboxView config={loadingConfig} renderConfigUnavailable={unavailable} saveConfig={saveSandbox} />
/** The caller supplies the existing config failure panel. */
export const Unavailable = () => <SettingsSandboxView config={failedConfig} renderConfigUnavailable={unavailable} saveConfig={saveSandbox} />

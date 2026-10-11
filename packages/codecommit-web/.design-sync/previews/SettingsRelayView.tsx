// Fixtures from packages/codecommit-web/test/settings-relay.test.ts.
import { SettingsRelayView } from "@knpkv/codecommit-web-design-system"
import { emptySkills, environmentSkills, failedConfig, loadingConfig, noop, readyConfig, saveRelay } from "../fixtures/settings.js"

/** Default profiles with an empty skill inventory. */
export const Profiles = () => <SettingsRelayView config={readyConfig} skills={emptySkills} saveConfig={saveRelay} />
/** Profiles have not loaded yet. */
export const Loading = () => <SettingsRelayView config={loadingConfig} skills={emptySkills} saveConfig={saveRelay} />
/** Config failed; reload is available. */
export const Unavailable = () => <SettingsRelayView config={failedConfig} skills={emptySkills} saveConfig={saveRelay} onReload={noop} />
/** An installed environment skill can be selected. */
export const EnvironmentSkill = () => <SettingsRelayView config={readyConfig} skills={environmentSkills} saveConfig={saveRelay} />

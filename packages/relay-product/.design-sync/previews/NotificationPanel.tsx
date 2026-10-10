// Fixtures from packages/herdr-hub/test/notification-panel.test.tsx.
import { NotificationPanel } from "@knpkv/relay-app-design-system"

const noop = () => undefined
const props = { canonicalUrl: "https://ser8.example.test/", onDisable: noop, onEnable: noop }

export const Enabled = () => <NotificationPanel {...props} state="enabled" />
export const Disabled = () => <NotificationPanel {...props} state="disabled" />
export const Loading = () => <NotificationPanel {...props} state="loading" />
export const Error = () => (
  <NotificationPanel {...props} failure="the push service answered 410" state="error" />
)
export const Denied = () => <NotificationPanel {...props} state="denied" />

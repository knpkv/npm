import { Button, Text } from "@knpkv/rly/primitives"
import { agentConnectTarget, type AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"

export type NotificationState = "loading" | "unsupported" | "disabled" | "denied" | "enabled" | "error"

export const connectWorkerHref = (worker: AgentWorkerIdentity): string => agentConnectTarget(worker).url

/**
 * Push notifications for approvals, as a status word and the one action that applies. `failure`
 * is the cause when checking or enabling failed, shown as said, never as a stack.
 */
export const NotificationPanel = ({
  canonicalUrl,
  failure,
  onDisable,
  onEnable,
  state
}: {
  readonly canonicalUrl: string
  readonly failure?: string | undefined
  readonly onDisable: (() => void) | undefined
  readonly onEnable: (() => void) | undefined
  readonly state: NotificationState
}) => {
  if (state === "enabled" || state === "loading") {
    return (
      <div className="notification-status" aria-label="Approval notifications">
        <Text as="span" className="notification-word" variant="label">
          {state === "enabled" ? "Notifications on" : "Checking notifications…"}
        </Text>
        {state === "enabled" ? (
          <Button size="compact" variant="quiet" onClick={onDisable}>
            Turn off
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <div className="notification-status notification-status-action" aria-label="Approval notifications">
      <Text as="span" className="notification-word" variant="label">
        {state === "denied" ? "Notifications blocked" : "Notifications off"}
      </Text>
      {state === "unsupported" ? (
        <Text as="small" className="notice" tone="secondary" variant="meta">
          This browser can't receive push alerts here. On iPhone, add this page to the Home Screen first.
        </Text>
      ) : state === "denied" ? (
        <Text as="small" className="notice" tone="secondary" variant="meta">
          This browser blocked notifications for the hub. Allow them in its site settings (on iPhone: Settings, then
          Notifications), then come back.
        </Text>
      ) : state === "error" ? (
        <Text as="small" className="notice" tone="secondary" variant="meta">
          {failure === undefined ? "Couldn't check notifications." : `Couldn't check notifications: ${failure}.`} Then
          press Enable again.
        </Text>
      ) : null}
      {state === "unsupported" || state === "denied" ? null : (
        <Button size="compact" variant="quiet" onClick={onEnable}>
          Enable
        </Button>
      )}
      <details className="notification-help">
        <summary>Setup help</summary>
        <ol className="install-guidance">
          <li>Use iOS 16.4 or newer and connect Tailscale.</li>
          <li>
            Open <span className="notification-url">{canonicalUrl}</span> in Safari.
          </li>
          <li>Share, then Add to Home Screen, then open the installed app.</li>
          <li>Tap Enable.</li>
        </ol>
      </details>
    </div>
  )
}

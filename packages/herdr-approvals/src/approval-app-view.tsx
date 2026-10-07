import { Button, Surface, Text } from "@knpkv/rly/primitives"
import { useState, type FormEvent } from "react"
import { agentConnectTarget, type AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import type { ChatHistory, ChatMode, ChatState } from "@knpkv/herdr-coordinator/model"

export type NotificationState = "loading" | "unsupported" | "disabled" | "denied" | "enabled" | "error"

export interface ChatDraftResult {
  readonly error: string | null
  readonly message: string
}

export const chatModeForShortcut = ({
  key,
  modified,
  shift
}: {
  readonly key: string
  readonly modified: boolean
  readonly shift: boolean
}): ChatMode | null => {
  if (key !== "Enter" || !modified) return null
  return shift ? "work" : "ask"
}

export const connectWorkerHref = (worker: AgentWorkerIdentity): string => agentConnectTarget(worker).url

export const submitChatDraft = async (
  mode: ChatMode,
  message: string,
  submit: (mode: ChatMode, message: string) => Promise<boolean>
): Promise<ChatDraftResult> =>
  (await submit(mode, message)) ? { error: null, message: "" } : { error: "Message not sent. Try again.", message }

const chatLabel = (state: ChatState): string => {
  switch (state) {
    case "pending":
      return "Pending"
    case "running":
      return "Running"
    case "failed":
      return "Failed"
    case "interrupted":
      return "Interrupted"
    case "completed":
      return "Completed"
  }
}

export const CoordinatorChatPanel = ({
  busy,
  history,
  onSubmit
}: {
  readonly busy: boolean
  readonly history: ChatHistory
  readonly onSubmit: ((mode: ChatMode, message: string) => Promise<boolean>) | undefined
}) => {
  const [message, setMessage] = useState("")
  const [error, setError] = useState<string | null>(null)
  const sendMessage = async (mode: ChatMode): Promise<void> => {
    if (busy || onSubmit === undefined || message.length === 0) return
    setError(null)
    const result = await submitChatDraft(mode, message, onSubmit)
    setMessage(result.message)
    setError(result.error)
  }
  const submit =
    (mode: ChatMode) =>
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      await sendMessage(mode)
    }
  return (
    <Surface as="section" padding="spacious" className="chat-panel">
      <div className="section-heading">
        <div>
          <Text as="h2" variant="section-title">
            Coordinator chat
          </Text>
          <Text tone="secondary" variant="meta">
            Conversations are kept across restarts.
          </Text>
        </div>
      </div>
      {/* A scrollable log: focusable so a keyboard can scroll it, named for screen readers. */}
      <div aria-label="Coordinator conversation" aria-live="polite" className="chat-history" role="log" tabIndex={0}>
        {history.entries.map((entry) => (
          <article className="chat-turn" key={entry.id}>
            <div className="chat-turn-heading">
              <Text variant="meta" tone="secondary">
                {entry.mode === "ask" ? "You asked" : "You asked for work"}
              </Text>
              <span className="chat-turn-state" data-state={entry.state}>
                {chatLabel(entry.state)}
              </span>
            </div>
            <Text as="p">{entry.message}</Text>
            {entry.worker === undefined || entry.connectTarget === undefined ? null : (
              <Text as="p" variant="meta" tone="secondary">
                Worker{" "}
                <a href={entry.connectTarget.url}>
                  {entry.worker.name} on {entry.worker.host}
                </a>
              </Text>
            )}
            {entry.reply === null ? null : (
              <div className="coordinator-reply">
                <Text variant="meta" tone="secondary">
                  Coordinator
                </Text>
                <Text as="p">{entry.reply}</Text>
              </div>
            )}
          </article>
        ))}
        {history.entries.length === 0 ? <Text tone="secondary">No coordinator conversation yet.</Text> : null}
      </div>
      <form className="chat-compose" onSubmit={submit("ask")}>
        <label htmlFor="coordinator-message">Message</label>
        <textarea
          id="coordinator-message"
          maxLength={2_000}
          name="coordinator-message"
          required
          rows={4}
          value={message}
          onChange={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.currentTarget.blur()
              return
            }
            const mode = chatModeForShortcut({
              key: event.key,
              modified: event.ctrlKey || event.metaKey,
              shift: event.shiftKey
            })
            if (mode === null) return
            event.preventDefault()
            void sendMessage(mode)
          }}
          placeholder="Ask about the fleet or request work"
        />
        <div className="chat-actions">
          <Button type="submit" variant="quiet" disabled={busy}>
            Ask
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={busy}
            onClick={() => {
              void sendMessage("work")
            }}
          >
            Do work
          </Button>
        </div>
        <div className="keyboard-hints" aria-label="Chat keyboard shortcuts">
          <span>
            <kbd>⌘/Ctrl</kbd> <kbd>Enter</kbd> Ask
          </span>
          <span>
            <kbd>⌘/Ctrl</kbd> <kbd>Shift</kbd> <kbd>Enter</kbd> Do work
          </span>
          <span>
            <kbd>Esc</kbd> Leave composer
          </span>
        </div>
        {error === null ? null : <p role="alert">{error}</p>}
      </form>
    </Surface>
  )
}

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
          {failure === undefined ? "Couldn't check notifications." : `Couldn't check notifications: ${failure}.`} Try
          Enable again.
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

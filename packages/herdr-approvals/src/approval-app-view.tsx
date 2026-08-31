import { Button, StateLabel, Surface, Text } from "@knpkv/rly/primitives"
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

const chatTone = (state: ChatState): "neutral" | "positive" | "critical" | "progress" => {
  switch (state) {
    case "pending":
      return "neutral"
    case "running":
      return "progress"
    case "failed":
      return "critical"
    case "interrupted":
      return "neutral"
    case "completed":
      return "positive"
  }
}

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
          <Text variant="meta" tone="secondary">
            KNPKV-SER8
          </Text>
          <Text as="h2" variant="section-title">
            Coordinator chat
          </Text>
        </div>
        <StateLabel label="Persistent" tone="positive" size="compact" />
      </div>
      <div className="chat-history" aria-live="polite">
        {history.entries.map((entry) => (
          <article className="chat-turn" key={entry.id}>
            <div className="chat-turn-heading">
              <Text variant="meta" tone="secondary">
                You · {entry.mode === "ask" ? "Ask" : "Do work"}
              </Text>
              <StateLabel label={chatLabel(entry.state)} tone={chatTone(entry.state)} size="compact" />
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

export const NotificationPanel = ({
  canonicalUrl,
  onDisable,
  onEnable,
  state
}: {
  readonly canonicalUrl: string
  readonly onDisable: (() => void) | undefined
  readonly onEnable: (() => void) | undefined
  readonly state: NotificationState
}) => {
  if (state === "enabled" || state === "loading") {
    return (
      <div className="notification-status" aria-label="Approval notifications">
        <StateLabel
          label={state === "enabled" ? "Notifications on" : "Checking notifications"}
          tone={state === "enabled" ? "positive" : "neutral"}
          size="compact"
        />
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
      <StateLabel
        label={state === "denied" ? "Notifications blocked" : "Notifications off"}
        tone="neutral"
        size="compact"
      />
      {state === "unsupported" ? (
        <Text as="small" className="notice" tone="secondary" variant="meta">
          Install this page to the iPhone Home Screen to enable alerts.
        </Text>
      ) : state === "denied" ? (
        <Text as="small" className="notice" tone="secondary" variant="meta">
          Re-enable in iPhone Settings.
        </Text>
      ) : state === "error" ? (
        <Text as="small" className="notice" tone="secondary" variant="meta">
          Setup failed. Refresh and retry.
        </Text>
      ) : null}
      <Button size="compact" variant="quiet" disabled={state === "unsupported"} onClick={onEnable}>
        Enable
      </Button>
      <details className="notification-help">
        <summary>Setup help</summary>
        <ol className="install-guidance">
          <li>Use iOS 16.4 or newer and connect Tailscale.</li>
          <li>Open {canonicalUrl} in Safari.</li>
          <li>Share → Add to Home Screen, then open the installed app.</li>
          <li>Tap Enable.</li>
        </ol>
      </details>
    </div>
  )
}

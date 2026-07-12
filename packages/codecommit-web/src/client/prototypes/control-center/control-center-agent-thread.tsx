import { Bot, Check, FilePenLine, ListChecks, LoaderCircle, Sparkles } from "lucide-react"
import { useEffect, useRef } from "react"
import type { AgentThreadEntry } from "./control-center-state.js"

type ThreadAction = NonNullable<AgentThreadEntry["action"]>

const actionDetails: Readonly<
  Record<
    ThreadAction,
    {
      readonly completed: string
      readonly label: string
      readonly pending: string
    }
  >
> = {
  checks: {
    completed: "Checks finished: 125 passed, 3 checkout tests still fail in PR #279.",
    label: "Run checks",
    pending: "Starting a fresh payments-production verification run…"
  },
  description: {
    completed: "Release description updated from 6 Jira items, 3 PRs, and the verified runbook.",
    label: "Update description",
    pending: "Drafting the release description from linked delivery evidence…"
  },
  summary: {
    completed: "Blockers summarized: fix 3 checkout tests and record Maya’s production approval.",
    label: "Summarize blockers",
    pending: "Correlating test failures, approvals, and missing relationships…"
  }
}

const initialMessages = (release: string, state: string): ReadonlyArray<AgentThreadEntry> => [
  {
    actor: "agent",
    id: `${release}-welcome`,
    text:
      release === "payments-api:2.18.0"
        ? "I checked this release. Three checkout tests fail, and Maya’s production approval is not recorded."
        : `I checked ${release}. Delivery evidence is synchronized. Current state: ${state}.`,
    time: "10:20"
  },
  {
    actor: "system",
    id: `${release}-evidence`,
    text:
      release === "payments-api:2.18.0"
        ? "Evidence refreshed · 6 Jira items · 3 PRs · pipeline #1842"
        : "Release evidence refreshed from connected services.",
    time: "10:20"
  }
]

export function AgentThread({
  entries,
  onChange,
  release,
  state
}: {
  readonly entries: ReadonlyArray<AgentThreadEntry>
  readonly onChange: (entries: ReadonlyArray<AgentThreadEntry>) => void
  readonly release: string
  readonly state: string
}) {
  const entriesRef = useRef(entries)
  const onChangeRef = useRef(onChange)
  entriesRef.current = entries
  onChangeRef.current = onChange
  const messages = [...initialMessages(release, state), ...entries]
  const pendingActions = new Set(entries.filter(({ status }) => status === "pending").map(({ action }) => action))
  const pendingSignature = entries
    .filter(({ status }) => status === "pending")
    .map(({ id }) => id)
    .join("|")
  useEffect(() => {
    if (!pendingSignature) return
    const timer = window.setTimeout(() => {
      onChangeRef.current(
        entriesRef.current.map((entry) => {
          if (entry.status !== "pending" || !entry.action) return entry
          const details = actionDetails[entry.action]
          const isPayments = release === "payments-api:2.18.0"
          const completedText = isPayments
            ? details.completed
            : entry.action === "checks"
              ? `Checks finished for ${release.replace(":", " ")}. Current release state: ${state}.`
              : entry.action === "description"
                ? `${release.replace(":", " ")} description updated from synchronized delivery evidence.`
                : `${release.replace(":", " ")} blockers summarized. Current release state: ${state}.`
          return { ...entry, status: "completed", text: completedText }
        })
      )
    }, 700)
    return () => window.clearTimeout(timer)
  }, [pendingSignature, release, state])

  const runAction = (action: ThreadAction) => {
    const details = actionDetails[action]
    const isPayments = release === "payments-api:2.18.0"
    const pendingText = isPayments
      ? details.pending
      : action === "checks"
        ? `Starting a fresh ${release.replace(":", " ")} verification run…`
        : action === "description"
          ? `Drafting the ${release.replace(":", " ")} description from linked evidence…`
          : `Correlating blockers and approvals for ${release.replace(":", " ")}…`
    const sequence = entries.length + 1
    const humanId = `${release}-${action}-${sequence}-human`
    const agentId = `${release}-${action}-${sequence}-agent`
    const next: ReadonlyArray<AgentThreadEntry> = [
      ...entries,
      {
        action,
        actor: "human",
        id: humanId,
        text: details.label,
        time: "Now"
      },
      {
        action,
        actor: "agent",
        id: agentId,
        status: "pending",
        text: pendingText,
        time: "Now"
      }
    ]
    onChange(next)
  }

  return (
    <section className="cc-agent-thread" aria-labelledby={`agent-thread-${release.replaceAll(":", "-")}`}>
      <header>
        <span>
          <Bot size={17} />
        </span>
        <div>
          <h2 id={`agent-thread-${release.replaceAll(":", "-")}`}>Release Guardian</h2>
          <small>
            Agent thread · {release.replace(":", " ")} · {state}
          </small>
        </div>
        <i>Active</i>
      </header>
      <div className="cc-agent-thread-history" aria-live="polite">
        {messages.map((message) => (
          <article className={message.actor} key={message.id}>
            <span>
              {message.actor === "agent" ? (
                <Bot size={13} />
              ) : message.actor === "system" ? (
                <Sparkles size={13} />
              ) : (
                "You"
              )}
            </span>
            <div>
              <p>{message.text}</p>
              <small>{message.time}</small>
            </div>
            {message.status === "pending" && <LoaderCircle className="spin" size={14} aria-label="Pending" />}
            {message.status === "completed" && <Check size={14} aria-label="Completed" />}
          </article>
        ))}
      </div>
      <footer aria-label="Quick actions">
        <button disabled={pendingActions.size > 0} onClick={() => runAction("description")}>
          <FilePenLine size={14} />
          Update description
        </button>
        <button disabled={pendingActions.size > 0} onClick={() => runAction("checks")}>
          <ListChecks size={14} />
          Run checks
        </button>
        <button disabled={pendingActions.size > 0} onClick={() => runAction("summary")}>
          <Sparkles size={14} />
          Summarize blockers
        </button>
      </footer>
    </section>
  )
}

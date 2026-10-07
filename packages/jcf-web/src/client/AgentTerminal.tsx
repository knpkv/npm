import { Button } from "@knpkv/rly/primitives"
import { useMemo, useState } from "react"
import type { AgentActivity } from "./useWeek.js"
import { formatAgentText } from "./agentText.js"

/** What a response says when the read stopped before the agent answered. */
const endedText = { failed: "No output: the read failed.", cancelled: "No output: the read was cancelled." }

/**
 * A read-only conversation per batch. Request precedes the live or completed response. `ended` says
 * the read stopped, so a missing response is explained rather than shown as still awaited.
 */
export const AgentTerminal = (props: {
  readonly activity: ReadonlyArray<AgentActivity>
  readonly ended: "failed" | "cancelled" | null
}) => {
  const waiting = props.ended === null ? "Waiting for agent output" : endedText[props.ended]
  const [selected, setSelected] = useState<number | null>(null)
  const entry = props.activity.find((item) => item.batch === selected) ?? props.activity.at(-1)

  const request = useMemo(() => formatAgentText(entry?.request ?? ""), [entry?.request])
  const response = useMemo(() => formatAgentText(entry?.text ?? ""), [entry?.text])

  return (
    <section className="jcf-agent-terminal" aria-label="Agent activity">
      <div className="jcf-terminal-toolbar">
        <strong>Agent activity</strong>
        <span>Read only</span>
        <div className="jcf-terminal-batches" role="group" aria-label="Agent batches">
          {props.activity.map((batch) => (
            <Button
              key={batch.batch}
              size="compact"
              variant="quiet"
              aria-pressed={entry?.batch === batch.batch}
              onClick={() => setSelected(batch.batch)}
            >
              {`Batch ${batch.batch}/${batch.batches}`}
            </Button>
          ))}
        </div>
      </div>
      <div className="jcf-agent-conversation" key={entry?.batch}>
        <section className="jcf-agent-message" data-speaker="request" aria-label="Agent request">
          <h3>Request</h3>
          <pre data-kind={request.kind} tabIndex={0}>
            {request.text || "Request not available for this batch"}
          </pre>
        </section>
        <section className="jcf-agent-message" data-speaker="response" aria-label="Agent response">
          <header>
            <h3>Response</h3>
            <span className="jcf-terminal-status">{entry?.status ?? waiting}</span>
          </header>
          <pre data-kind={response.kind} tabIndex={0}>
            {response.text || waiting}
          </pre>
        </section>
      </div>
    </section>
  )
}

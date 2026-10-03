import { Button } from "@knpkv/rly/primitives"
import { useMemo, useState } from "react"
import type { AgentActivity } from "./useWeek.js"
import { formatAgentText } from "./agentText.js"

/** A read-only conversation per batch. Request precedes the live or completed response. */
export const AgentTerminal = (props: { readonly activity: ReadonlyArray<AgentActivity> }) => {
  const [selected, setSelected] = useState<number | null>(null)
  const entry = props.activity.find((item) => item.batch === selected) ?? props.activity.at(-1)

  const request = useMemo(() => formatAgentText(entry?.request ?? ""), [entry?.request])
  const response = useMemo(() => formatAgentText(entry?.text ?? ""), [entry?.text])

  return (
    <section className="jcf-agent-terminal" aria-label="Agent activity">
      <div className="jcf-terminal-toolbar">
        <strong>Agent activity</strong>
        <span>Read only</span>
        <div className="jcf-terminal-batches" aria-label="Agent batches">
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
          <pre tabIndex={0}>{request || "Request not available for this batch"}</pre>
        </section>
        <section className="jcf-agent-message" data-speaker="response" aria-label="Agent response">
          <header>
            <h3>Response</h3>
            <span className="jcf-terminal-status">{entry?.status ?? "Waiting for agent output"}</span>
          </header>
          <pre tabIndex={0}>{response || "Waiting for agent output"}</pre>
        </section>
      </div>
    </section>
  )
}

import { Button, StatePanel } from "@knpkv/rly/primitives"
import { useEffect, useState } from "react"
import type { ReadProgress } from "../shared/contracts.js"

export const readStages: ReadonlyArray<{ readonly stage: ReadProgress["stage"]; readonly label: string }> = [
  { stage: "sessions", label: "Read sessions" },
  { stage: "attribution", label: "Match tickets" },
  { stage: "recorded", label: "Read logged time" },
  { stage: "issues", label: "Check ownership" },
  { stage: "calendar", label: "Build calendar" }
]

/** The timer renders independently so a one-second tick never recalculates calendar geometry. */
export const ReadStatus = (props: {
  readonly mode: "full" | "recorded"
  readonly progress: ReadonlyArray<ReadProgress>
  readonly startedAt: number
  readonly onCancel: () => void
}) => {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - props.startedAt) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [props.startedAt])
  const stages =
    props.mode === "recorded"
      ? readStages.filter((step) => step.stage === "recorded" || step.stage === "calendar")
      : readStages
  const current = props.progress.at(-1)
  const index = stages.findIndex((step) => step.stage === current?.stage)
  return (
    <section className="jcf-read-status" aria-label="Week loading progress">
      <div className="jcf-read-summary">
        <div role="status" aria-live="polite">
          <strong>{current?.message ?? "Connecting to your local JCF server."}</strong>
        </div>
        <span className="jcf-muted jcf-elapsed" aria-label={`${elapsed} seconds elapsed`}>
          {elapsed}s
        </span>
        <Button onClick={props.onCancel} size="compact" variant="quiet">
          Cancel read
        </Button>
      </div>
      <progress
        aria-label={current?.total === undefined ? "Reading week" : "Sessions checked"}
        max={current?.total}
        value={current?.total === undefined ? undefined : current.completed}
      />
      <details>
        <summary>Loading details{index < 0 ? "" : ` · stage ${index + 1} of ${stages.length}`}</summary>
        <ol className="jcf-read-stages">
          {stages.map((step, stepIndex) => {
            const detail = props.progress.find((entry) => entry.stage === step.stage)
            return (
              <li key={step.stage} data-state={stepIndex < index ? "done" : stepIndex === index ? "active" : "waiting"}>
                <span>{stepIndex < index ? "✓" : stepIndex === index ? "•" : "○"}</span>
                <div>
                  <strong>{step.label}</strong>
                  <p>{detail?.message ?? "Waiting"}</p>
                </div>
              </li>
            )
          })}
        </ol>
      </details>
      {elapsed < 20 ? null : (
        <StatePanel
          title="Still working"
          tone="neutral"
          description={
            props.mode === "recorded"
              ? "Waiting for Jira/Clockify to return current totals. Session matches are kept; cancelling this refresh does not undo time already logged."
              : "Agent batches and provider requests can take a while. Updates above come from the server; you can cancel this read without logging any time."
          }
        />
      )}
    </section>
  )
}

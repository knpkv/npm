import { type ComponentPropsWithRef, type ReactElement, type ReactNode, useId } from "react"
import { Button } from "../primitives/Button.js"
import { StateLabel, type RlyStateTone } from "../primitives/StateLabel.js"
import { classNames, cssClass, requireText } from "../internal/component.js"
import styles from "./AgentJob.module.css"

const style = (name: string): string => cssClass(styles, name)

const requireSlot = (value: ReactNode, label: string): void => {
  if (value === undefined || value === null || typeof value === "boolean") {
    throw new Error(`${label} must contain renderable content`)
  }
  if (typeof value === "string") requireText(value, label)
}

export type RlyAgentJobState = "queued" | "running" | "cancel-requested" | "succeeded" | "failed" | "cancelled"

type AgentJobRevision =
  { readonly sandbox: string; readonly revision?: string } | { readonly sandbox?: string; readonly revision: string }

type AgentJobActiveState =
  | {
      readonly state: "queued"
      readonly progress?: number
      readonly onCancel?: () => void
      readonly outcome?: never
    }
  | {
      readonly state: "running"
      readonly progress: number
      readonly onCancel?: () => void
      readonly outcome?: never
    }
  | {
      readonly state: "cancel-requested"
      readonly progress?: number
      readonly onCancel?: never
      readonly outcome?: never
    }

type AgentJobTerminalState = {
  readonly state: "succeeded" | "failed" | "cancelled"
  readonly progress?: number
  readonly onCancel?: never
  /** Presenter-owned truthful terminal result; required for every terminal state. */
  readonly outcome: ReactNode
}

/** Controlled display props. The component never invokes a provider or mutates job state. */
export type AgentJobProps = Omit<ComponentPropsWithRef<"article">, "aria-label" | "children" | "onCancel"> &
  AgentJobRevision &
  (AgentJobActiveState | AgentJobTerminalState) & {
    readonly heading: string
    readonly provider: string
    readonly capability: string
    readonly context: ReactNode
    readonly evidence: ReactNode
    readonly cancelLabel?: string
  }

const statePresentation: Readonly<Record<RlyAgentJobState, { label: string; tone: RlyStateTone }>> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "progress" },
  "cancel-requested": { label: "Cancel requested", tone: "caution" },
  succeeded: { label: "Succeeded", tone: "positive" },
  failed: { label: "Failed", tone: "critical" },
  cancelled: { label: "Cancelled", tone: "neutral" }
}

const validateProgress = (progress: number | undefined): void => {
  if (progress !== undefined && (!Number.isFinite(progress) || progress < 0 || progress > 100)) {
    throw new Error("AgentJob progress must be between 0 and 100")
  }
}

/** Render provider-owned job state, immutable context, evidence, and a controlled cancel request. */
export const AgentJob = ({
  cancelLabel = "Request cancellation",
  capability,
  className,
  context,
  evidence,
  heading,
  onCancel,
  outcome,
  progress,
  provider,
  revision,
  sandbox,
  state,
  ...props
}: AgentJobProps): ReactElement => {
  const visibleHeading = requireText(heading, "AgentJob heading")
  const visibleProvider = requireText(provider, "AgentJob provider")
  const visibleCapability = requireText(capability, "AgentJob capability")
  const visibleCancelLabel = requireText(cancelLabel, "AgentJob cancelLabel")
  requireSlot(context, "AgentJob context")
  requireSlot(evidence, "AgentJob evidence")
  if (state === "succeeded" || state === "failed" || state === "cancelled") {
    requireSlot(outcome, "AgentJob terminal outcome")
  }
  if (sandbox !== undefined) requireText(sandbox, "AgentJob sandbox")
  if (revision !== undefined) requireText(revision, "AgentJob revision")
  validateProgress(progress)
  const presentation = statePresentation[state]
  const cancellable = state === "queued" || state === "running"
  const progressId = `rly-agent-job-progress-${useId()}`

  return (
    <article
      {...props}
      aria-busy={state === "queued" || state === "running" || state === "cancel-requested"}
      className={classNames(style("root"), className)}
      data-rly-agent-job-state={state}
    >
      <header className={style("header")}>
        <span aria-hidden="true" className={style("agentGlyph")}>
          AI
        </span>
        <span className={style("titleBlock")}>
          <span className={style("eyebrow")}>
            {visibleProvider} · {visibleCapability}
          </span>
          <h2>{visibleHeading}</h2>
        </span>
        <StateLabel label={presentation.label} size="compact" tone={presentation.tone} />
      </header>

      {progress === undefined ? null : (
        <div className={style("progressBlock")}>
          <span className={style("progressLabel")} id={progressId}>
            Progress <strong>{Math.round(progress)}%</strong>
          </span>
          <progress aria-labelledby={progressId} max={100} value={progress} />
        </div>
      )}

      <dl className={style("metadata")}>
        <div>
          <dt>Provider</dt>
          <dd>{visibleProvider}</dd>
        </div>
        <div>
          <dt>Capability</dt>
          <dd>{visibleCapability}</dd>
        </div>
        {sandbox === undefined ? null : (
          <div>
            <dt>Sandbox</dt>
            <dd>
              <code>{sandbox}</code>
            </dd>
          </div>
        )}
        {revision === undefined ? null : (
          <div>
            <dt>Revision</dt>
            <dd>
              <code>{revision}</code>
            </dd>
          </div>
        )}
      </dl>

      <section className={style("slot")} data-rly-agent-job-context="">
        <h3>Exact context</h3>
        {context}
      </section>
      <section className={style("slot")} data-rly-agent-job-evidence="">
        <h3>Evidence</h3>
        {evidence}
      </section>
      {outcome === undefined ? null : (
        <section className={classNames(style("slot"), style("outcome"))} data-rly-agent-job-outcome={state}>
          <h3>Terminal outcome</h3>
          {outcome}
        </section>
      )}
      {cancellable && onCancel !== undefined ? (
        <footer className={style("footer")}>
          <Button onClick={onCancel} size="compact" variant="quiet">
            {visibleCancelLabel}
          </Button>
        </footer>
      ) : null}
    </article>
  )
}

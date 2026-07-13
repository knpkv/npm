import type { ComponentPropsWithRef, ReactElement } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import styles from "./AgentContextButton.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Optional application-owned work status shown without deriving agent activity. */
export interface RlyAgentJobSummary {
  readonly count?: number
  readonly status: string
}

/** Props for an explicit, context-named agent launcher. */
export type AgentContextButtonProps = Omit<ComponentPropsWithRef<"button">, "children"> & {
  readonly actionLabel?: string
  readonly agentName: string
  readonly context: string
  readonly contextLabel?: string
  readonly job?: RlyAgentJobSummary
}

const AgentMark = (): ReactElement => (
  <span aria-hidden="true" className={style("mark")}>
    <svg className={style("glyph")} focusable="false" viewBox="0 0 24 24">
      <path d="M12 3.5 14 10l6.5 2-6.5 2-2 6.5L10 14l-6.5-2 6.5-2Z" fill="currentColor" />
    </svg>
  </span>
)

/**
 * Launch an application-owned agent surface while keeping its complete context
 * visible before activation.
 */
export const AgentContextButton = ({
  actionLabel = "Ask agent",
  agentName,
  className,
  context,
  contextLabel = "Context",
  job,
  type,
  ...props
}: AgentContextButtonProps): ReactElement => {
  const visibleAction = requireText(actionLabel, "AgentContextButton actionLabel")
  const visibleAgent = requireText(agentName, "AgentContextButton agentName")
  const visibleContext = requireText(context, "AgentContextButton context")
  const visibleContextLabel = requireText(contextLabel, "AgentContextButton contextLabel")
  const visibleJob = job === undefined ? undefined : requireText(job.status, "AgentContextButton job status")
  if (job?.count !== undefined && (!Number.isInteger(job.count) || job.count < 0)) {
    throw new Error("AgentContextButton job count must be a non-negative integer")
  }

  return (
    <button
      {...props}
      className={classNames(style("root"), className)}
      data-rly-agent-context-button=""
      type={type ?? "button"}
    >
      <AgentMark />
      <span className={style("copy")}>
        <span className={style("action")}>{visibleAction}</span>
        <span className={style("agent")}>{visibleAgent}</span>
        <span className={style("contextRow")}>
          <span className={style("contextLabel")}>{visibleContextLabel}</span>
          <span className={style("context")}>{visibleContext}</span>
        </span>
      </span>
      {visibleJob === undefined ? null : (
        <span className={style("job")} data-rly-agent-job="">
          {visibleJob}
          {job?.count === undefined ? null : <span className={style("count")}>{job.count}</span>}
        </span>
      )}
    </button>
  )
}

import { type ComponentPropsWithRef, type ReactElement, useId } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import styles from "./DiffFinding.module.css"

const style = (name: string): string => cssClass(styles, name)

/** A current immutable line anchor or a preserved anchor invalidated by a newer revision. */
export type RlyDiffFindingAnchor =
  | {
      readonly contextHash: string
      readonly fileId: string
      readonly line: number
      readonly path: string
      readonly revision: string
      readonly side: "before" | "after"
      readonly state: "current"
    }
  | {
      readonly contextHash: string
      readonly currentRevision?: string
      readonly fileId: string
      readonly line: number
      readonly path: string
      readonly reason: string
      readonly revision: string
      readonly side: "before" | "after"
      readonly state: "stale"
    }

/** Semantic presentation data for one human or agent-authored finding. */
export interface RlyDiffFinding {
  readonly anchor: RlyDiffFindingAnchor
  readonly authorName: string
  readonly body: string
  readonly id: string
  readonly severity: "note" | "warning" | "critical"
  readonly source: "human" | "agent"
  readonly status: "open" | "resolved"
  readonly title: string
}

/** Props for a semantic finding card with an application-controlled anchor callback. */
export type DiffFindingProps = Omit<ComponentPropsWithRef<"article">, "aria-label" | "children"> & {
  readonly finding: RlyDiffFinding
  readonly onAnchorActivate: (findingId: string) => void
}

const validateFinding = (finding: RlyDiffFinding): void => {
  requireText(finding.id, "DiffFinding id")
  requireText(finding.authorName, "DiffFinding authorName")
  requireText(finding.title, "DiffFinding title")
  requireText(finding.body, "DiffFinding body")
  requireText(finding.anchor.fileId, "DiffFinding anchor fileId")
  requireText(finding.anchor.path, "DiffFinding anchor path")
  requireText(finding.anchor.revision, "DiffFinding anchor revision")
  requireText(finding.anchor.contextHash, "DiffFinding anchor contextHash")
  if (!Number.isInteger(finding.anchor.line) || finding.anchor.line < 1) {
    throw new Error("DiffFinding anchor line must be a positive integer")
  }
  if (finding.anchor.state === "stale") {
    requireText(finding.anchor.reason, "DiffFinding stale anchor reason")
    if (finding.anchor.currentRevision !== undefined) {
      requireText(finding.anchor.currentRevision, "DiffFinding currentRevision")
    }
  }
}

/** Render a finding as evidence; agent authorship never implies human approval. */
export const DiffFinding = ({ className, finding, onAnchorActivate, ...props }: DiffFindingProps): ReactElement => {
  validateFinding(finding)
  const titleId = `rly-diff-finding-${useId()}`
  const anchorLabel = `${finding.anchor.path}, ${finding.anchor.side} line ${finding.anchor.line}`

  return (
    <article
      {...props}
      aria-labelledby={titleId}
      className={classNames(style("root"), className)}
      data-rly-diff-finding-anchor={finding.anchor.state}
      data-rly-diff-finding-source={finding.source}
      data-rly-diff-finding-status={finding.status}
    >
      <header className={style("header")}>
        <span aria-hidden="true" className={classNames(style("avatar"), style(finding.source))}>
          {finding.source === "agent" ? "AI" : finding.authorName.slice(0, 1).toUpperCase()}
        </span>
        <span className={style("identity")}>
          <strong>{finding.authorName}</strong>
          <span>{finding.source === "agent" ? "Agent finding · not an approval" : "Human finding"}</span>
        </span>
        <span className={style("state")}>{finding.status}</span>
      </header>

      <section className={style("body")}>
        <span className={style("severity")}>{finding.severity}</span>
        <h2 id={titleId}>{finding.title}</h2>
        <p>{finding.body}</p>
      </section>

      <dl className={style("anchorDetails")}>
        <div>
          <dt>Revision</dt>
          <dd>
            <code>{finding.anchor.revision}</code>
          </dd>
        </div>
        <div>
          <dt>Context</dt>
          <dd>
            <code>{finding.anchor.contextHash}</code>
          </dd>
        </div>
        {finding.anchor.state === "stale" && finding.anchor.currentRevision !== undefined ? (
          <div>
            <dt>Current revision</dt>
            <dd>
              <code>{finding.anchor.currentRevision}</code>
            </dd>
          </div>
        ) : null}
      </dl>

      <footer className={style("footer")}>
        {finding.anchor.state === "current" ? (
          <button onClick={() => onAnchorActivate(finding.id)} type="button">
            <span>Open anchor</span>
            <code>{anchorLabel}</code>
          </button>
        ) : (
          <span className={style("stale")} role="status">
            <strong>Stale anchor</strong>
            <span>{finding.anchor.reason}</span>
            <code>{anchorLabel}</code>
          </span>
        )}
      </footer>
    </article>
  )
}

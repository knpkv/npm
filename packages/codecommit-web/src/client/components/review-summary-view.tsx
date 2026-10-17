/** Recorded agent output is prose, not approval authority or a computed verdict. @module */
import { CommitLabel } from "@knpkv/review/react"
import type { ReviewRun, ReviewWorkspaceThreads, ThreadsConflict } from "@knpkv/review"
import { Result, type DateTime } from "effect"
import type { ReactElement } from "react"
import { reviewReadingTime } from "../review-reading-time.js"
import { reviewRunProvenance } from "../review-run-provenance.js"
import styles from "./review-status-views.module.css"

export interface ReviewSummaryViewProps {
  readonly run: ReviewRun
  /** The host joins this run with comments once. Conflict hides counts, never the recorded verdict. */
  readonly threads: Result.Result<ReviewWorkspaceThreads, ThreadsConflict>
  /** Validated named viewer zone; absent uses the browser zone. Parse settings with DateTime.zoneMakeNamed. */
  readonly timeZone?: DateTime.TimeZone.Named | undefined
}

/** Show only saved output and provenance. Missing legacy axes, patches and risk fields stay absent. */
export function ReviewSummaryView({ run, threads, timeZone }: ReviewSummaryViewProps): ReactElement {
  const time = reviewReadingTime(run.completedAt, timeZone)
  const provenance = reviewRunProvenance(run)
  const counts =
    run.kind !== "explain" && Result.isSuccess(threads)
      ? ([
          ["P0", threads.success.primary.filter(({ finding }) => finding.severity === "P0").length],
          ["P1", threads.success.primary.filter(({ finding }) => finding.severity === "P1").length],
          ["P2 and below", threads.success.secondary.length]
        ] satisfies ReadonlyArray<readonly [string, number]>)
      : null
  return (
    <section aria-label="Review summary" className={styles.summary} data-review-summary="recorded">
      {run.kind === "explain" && run.explanation !== null ? (
        <div className={styles.explanation}>
          {run.summary.length > 0 ? (
            <blockquote className={styles.quote}>
              <p>{run.summary}</p>
            </blockquote>
          ) : null}
          <small>Agent review, not an approval</small>
          <h3>Change explanation</h3>
          {run.explanation.split(/\n\s*\n/u).map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      ) : (
        <>
          <div className={styles.verdict}>
            {run.summary.length > 0 ? (
              <blockquote className={styles.quote}>
                <p>{run.summary}</p>
              </blockquote>
            ) : null}
            <small>Agent review, not an approval</small>
          </div>
          {run.explanation !== null ? (
            <div className={styles.facts}>
              <h3>Change explanation</h3>
              {run.explanation.split(/\n\s*\n/u).map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
          ) : null}
        </>
      )}
      {run.risks !== null && run.risks.length > 0 ? (
        <div className={styles.facts}>
          <h3>Risks</h3>
          <ul>
            {run.risks.map((risk, index) => (
              <li key={index}>{risk}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {counts !== null ? (
        <div className={styles.counts}>
          <div className={styles.facts}>
            <h3>By severity</h3>
            <dl>
              {counts.map(([severity, count]) => (
                <div className={styles.countRow} key={severity}>
                  <dt>{severity}</dt>
                  <dd>{count}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      ) : null}
      <div className={styles.provenance}>
        <span>{provenance}</span>
        <small>
          Reviewed{" "}
          <time dateTime={time.iso} title={time.full}>
            {time.clock}
          </time>
          , head <CommitLabel commit={run.identity.headRevision} />
        </small>
      </div>
    </section>
  )
}

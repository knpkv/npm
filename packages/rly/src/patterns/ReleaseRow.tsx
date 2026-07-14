import { type ComponentPropsWithRef, type ReactElement, type ReactNode, useId } from "react"
import { Button } from "../primitives/Button.js"
import { classNames, cssClass, requireText } from "../internal/component.js"
import { FreshnessStamp } from "./FreshnessStamp.js"
import { Person } from "./Person.js"
import {
  type RlyReleasePresentation,
  type RlyReleaseTransitionNames,
  validateReleasePresentation,
  validateReleaseTransitionNames
} from "./ReleasePresentation.js"
import { ReleaseRelay } from "./ReleaseRelay.js"
import styles from "./ReleaseRow.module.css"

export type {
  RlyReleaseFact,
  RlyReleasePresentation,
  RlyReleaseState,
  RlyReleaseTransitionNames
} from "./ReleasePresentation.js"

const style = (name: string): string => cssClass(styles, name)

/** Props for one complete, caller-owned release presentation row. */
export type ReleaseRowProps = Omit<ComponentPropsWithRef<"article">, "children"> & {
  /** Optional adjacent agent affordance; rly does not assign behavior to it. */
  readonly agentEntry?: ReactNode
  /** Called once when the visible preview action is activated. */
  readonly onPreview: () => void
  /** Visible preview action label. */
  readonly previewLabel?: string
  /** Complete presentation projection supplied by the application. */
  readonly release: RlyReleasePresentation
  /** Optional unique names used while an application-owned View Transition is active. */
  readonly transitionNames?: RlyReleaseTransitionNames
}

/** Render a full-width release dossier row without deriving release state or readiness. */
export const ReleaseRow = ({
  agentEntry,
  className,
  onPreview,
  previewLabel = "Preview release",
  release: suppliedRelease,
  transitionNames,
  ...props
}: ReleaseRowProps): ReactElement => {
  const release = validateReleasePresentation(suppliedRelease)
  const validatedTransitionNames = validateReleaseTransitionNames(transitionNames)
  const visiblePreviewLabel = requireText(previewLabel, "ReleaseRow previewLabel")
  const verdictId = `rly-release-row-verdict-${useId()}`
  const freshness =
    release.freshnessDateTime === undefined ? (
      <FreshnessStamp size="compact" state={release.freshness} />
    ) : (
      <FreshnessStamp
        dateTime={release.freshnessDateTime}
        size="compact"
        state={release.freshness}
        time={release.freshnessTime}
      />
    )

  return (
    <article
      {...props}
      className={classNames(style("root"), className)}
      data-rly-release-id={release.id}
      data-rly-release-state={release.state}
    >
      <div className={style("identity")}>
        <ReleaseRelay
          algorithm={release.algorithm}
          codename={release.codename}
          data-rly-release-transition-name={validatedTransitionNames?.relay}
          data-rly-release-transition-part="relay"
          size="compact"
          style={
            validatedTransitionNames === undefined ? undefined : { viewTransitionName: validatedTransitionNames.relay }
          }
          symbolIndices={release.symbolIndices}
        />
        <p
          className={style("version")}
          data-rly-release-transition-name={validatedTransitionNames?.version}
          data-rly-release-transition-part="version"
          style={
            validatedTransitionNames === undefined
              ? undefined
              : { viewTransitionName: validatedTransitionNames.version }
          }
        >
          {release.version}
        </p>
        {freshness}
      </div>

      <section
        aria-labelledby={verdictId}
        className={style("verdictBlock")}
        data-rly-release-transition-name={validatedTransitionNames?.verdict}
        data-rly-release-transition-part="verdict"
        style={
          validatedTransitionNames === undefined ? undefined : { viewTransitionName: validatedTransitionNames.verdict }
        }
      >
        <h2 className={style("verdict")} id={verdictId}>
          {release.verdict}
        </h2>
        <p className={style("reason")}>{release.reason}</p>
      </section>

      <div className={style("people")}>
        <div className={style("personGroup")}>
          <span className={style("eyebrow")}>Owner</span>
          {release.owner === undefined ? (
            <span className={style("unassigned")} data-rly-release-owner="unassigned">
              Unassigned
            </span>
          ) : (
            <Person person={release.owner} size="compact" />
          )}
        </div>
        {release.approver === undefined ? null : (
          <div className={style("personGroup")}>
            <span className={style("eyebrow")}>Approver</span>
            <Person person={release.approver} size="compact" />
          </div>
        )}
      </div>

      <dl className={style("facts")}>
        {release.facts.map((fact) => (
          <div className={style("fact")} key={fact.id}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>

      <div className={style("actions")}>
        <Button className={style("previewButton")} onClick={onPreview} size="default">
          {visiblePreviewLabel}
        </Button>
        {agentEntry === undefined ? null : <div className={style("agentEntry")}>{agentEntry}</div>}
      </div>
    </article>
  )
}

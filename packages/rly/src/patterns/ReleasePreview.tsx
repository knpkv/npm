import { type ReactElement, type ReactNode, useRef } from "react"
import { Button } from "../primitives/Button.js"
import { Dialog } from "../primitives/Dialog.js"
import { cssClass, requireText } from "../internal/component.js"
import { FreshnessStamp } from "./FreshnessStamp.js"
import { Person } from "./Person.js"
import { type RlyReleasePresentation, validateReleasePresentation } from "./ReleasePresentation.js"
import { ReleaseRelay } from "./ReleaseRelay.js"
import { Verdict } from "./Verdict.js"
import styles from "./ReleasePreview.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Controlled release-preview composition with application-owned content slots. */
export interface ReleasePreviewProps {
  /** Required agent entry supplied by the application. */
  readonly agentEntry: ReactNode
  /** Required evidence composition supplied by the application. */
  readonly evidence: ReactNode
  /** Called once when the final full-view action is activated. */
  readonly onOpenFullView: () => void
  /** Receives controlled dialog state requests. */
  readonly onOpenChange: (open: boolean) => void
  /** Visible label for the final full-view action. */
  readonly openFullViewLabel?: string
  /** Controlled dialog state. */
  readonly open: boolean
  /** Required primary release action supplied by the application. */
  readonly primaryAction: ReactNode
  /** Complete presentation projection supplied by the application. */
  readonly release: RlyReleasePresentation
  /** Required delivery-stage composition supplied by the application. */
  readonly stages: ReactNode
  /** Required workset composition supplied by the application. */
  readonly workset: ReactNode
}

/** Render a wide release dossier dialog without routing, executing, or deriving domain state. */
export const ReleasePreview = ({
  agentEntry,
  evidence,
  onOpenChange,
  onOpenFullView,
  open,
  openFullViewLabel = "Open full view",
  primaryAction,
  release: suppliedRelease,
  stages,
  workset
}: ReleasePreviewProps): ReactElement => {
  const release = validateReleasePresentation(suppliedRelease)
  const visibleOpenFullViewLabel = requireText(openFullViewLabel, "ReleasePreview openFullViewLabel")
  const summaryRef = useRef<HTMLElement>(null)
  const freshness =
    release.freshnessDateTime === undefined ? (
      <FreshnessStamp state={release.freshness} />
    ) : (
      <FreshnessStamp dateTime={release.freshnessDateTime} state={release.freshness} time={release.freshnessTime} />
    )

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Content
        initialFocusRef={summaryRef}
        size="wide"
        title={`Release preview: ${release.version} ${release.codename}`}
      >
        <div className={style("body")} data-rly-release-state={release.state}>
          <section
            aria-label="Release summary"
            className={style("summary")}
            data-rly-release-preview-summary=""
            ref={summaryRef}
            tabIndex={-1}
          >
            <div className={style("identityRow")}>
              <ReleaseRelay
                algorithm={release.algorithm}
                codename={release.codename}
                size="hero"
                symbolIndices={release.symbolIndices}
              />
              <div className={style("releaseMeta")}>
                <p className={style("version")}>{release.version}</p>
                {freshness}
              </div>
            </div>

            <div className={style("people")}>
              <div className={style("personGroup")}>
                <span className={style("eyebrow")}>Owner</span>
                <Person person={release.owner} />
              </div>
              {release.approver === undefined ? null : (
                <div className={style("personGroup")}>
                  <span className={style("eyebrow")}>Approver</span>
                  <Person person={release.approver} />
                </div>
              )}
            </div>

            <Verdict reason={release.reason} tone={release.tone} verdict={release.verdict} />

            <dl className={style("facts")}>
              {release.facts.map((fact) => (
                <div className={style("fact")} key={fact.id}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <div className={style("slot")} data-rly-release-preview-slot="primary-action">
            {primaryAction}
          </div>
          <div className={style("slot")} data-rly-release-preview-slot="stages">
            {stages}
          </div>
          <div className={style("slot")} data-rly-release-preview-slot="workset">
            {workset}
          </div>
          <div className={style("slot")} data-rly-release-preview-slot="evidence">
            {evidence}
          </div>
          <div className={style("slot")} data-rly-release-preview-slot="agent-entry">
            {agentEntry}
          </div>
          <div className={style("fullView")}>
            <Button className={style("fullViewButton")} onClick={onOpenFullView} size="default" variant="secondary">
              {visibleOpenFullViewLabel}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  )
}

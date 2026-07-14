import { type ReactElement, type ReactNode, useRef } from "react"
import { Button } from "../primitives/Button.js"
import { Dialog } from "../primitives/Dialog.js"
import { Sheet } from "../primitives/Sheet.js"
import { cssClass, requireText } from "../internal/component.js"
import { FreshnessStamp } from "./FreshnessStamp.js"
import { Person } from "./Person.js"
import {
  type RlyReleasePresentation,
  type RlyReleaseTransitionNames,
  validateReleasePresentation,
  validateReleaseTransitionNames
} from "./ReleasePresentation.js"
import { ReleaseRelay } from "./ReleaseRelay.js"
import { Verdict } from "./Verdict.js"
import styles from "./ReleasePreview.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Caller-selected overlay presentation; rly does not inspect viewport state. */
export type RlyReleasePreviewPresentation = "dialog" | "sheet"

/** Controlled release-preview composition with application-owned content slots. */
export interface ReleasePreviewProps {
  /** Required agent entry supplied by the application. */
  readonly agentEntry: ReactNode
  /** Optional complete collaborator composition supplied by the application. */
  readonly collaborators?: ReactNode
  /** Required evidence composition supplied by the application. */
  readonly evidence: ReactNode
  /** Entry ownership sampled per open cycle; external suppresses dialog/sheet entry while preserving exit motion. */
  readonly entryMotion?: "external" | "intrinsic"
  /** Called once when the final full-view action is activated. */
  readonly onOpenFullView: () => void
  /** Receives controlled overlay state requests. */
  readonly onOpenChange: (open: boolean) => void
  /** Visible label for the final full-view action. */
  readonly openFullViewLabel?: string
  /** Controlled overlay state. */
  readonly open: boolean
  /** Caller-selected overlay presentation. Defaults to the desktop dialog. */
  readonly presentation?: RlyReleasePreviewPresentation
  /** Required primary release action supplied by the application. */
  readonly primaryAction: ReactNode
  /** Complete presentation projection supplied by the application. */
  readonly release: RlyReleasePresentation
  /** Required delivery-stage composition supplied by the application. */
  readonly stages: ReactNode
  /** Optional unique names used while an application-owned View Transition is active. */
  readonly transitionNames?: RlyReleaseTransitionNames
  /** Required workset composition supplied by the application. */
  readonly workset: ReactNode
}

/** Render a caller-selected release dossier overlay without routing, executing, or deriving domain state. */
export const ReleasePreview = ({
  agentEntry,
  collaborators,
  entryMotion = "intrinsic",
  evidence,
  onOpenChange,
  onOpenFullView,
  open,
  openFullViewLabel = "Open full view",
  presentation = "dialog",
  primaryAction,
  release: suppliedRelease,
  stages,
  transitionNames,
  workset
}: ReleasePreviewProps): ReactElement => {
  const release = validateReleasePresentation(suppliedRelease)
  const validatedTransitionNames = validateReleaseTransitionNames(transitionNames)
  const visibleOpenFullViewLabel = requireText(openFullViewLabel, "ReleasePreview openFullViewLabel")
  const summaryRef = useRef<HTMLElement>(null)
  const freshness =
    release.freshnessDateTime === undefined ? (
      <FreshnessStamp state={release.freshness} />
    ) : (
      <FreshnessStamp dateTime={release.freshnessDateTime} state={release.freshness} time={release.freshnessTime} />
    )

  const title = `Release preview: ${release.version} ${release.codename}`
  const dossier = (
    <div
      className={style("body")}
      data-rly-release-preview-presentation={presentation}
      data-rly-release-state={release.state}
    >
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
            data-rly-release-transition-name={validatedTransitionNames?.relay}
            data-rly-release-transition-part="relay"
            size="hero"
            style={
              validatedTransitionNames === undefined
                ? undefined
                : { viewTransitionName: validatedTransitionNames.relay }
            }
            symbolIndices={release.symbolIndices}
          />
          <div className={style("releaseMeta")}>
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
        </div>

        <div className={style("people")}>
          <div className={style("personGroup")}>
            <span className={style("eyebrow")}>Owner</span>
            {release.owner === undefined ? (
              <span className={style("unassigned")} data-rly-release-owner="unassigned">
                Unassigned
              </span>
            ) : (
              <Person person={release.owner} />
            )}
          </div>
          <div className={style("personGroup")}>
            <span className={style("eyebrow")}>Approver</span>
            {release.approver === undefined ? (
              <span className={style("unassigned")} data-rly-release-approver="unassigned">
                Unassigned
              </span>
            ) : (
              <Person person={release.approver} />
            )}
          </div>
        </div>

        <Verdict
          data-rly-release-transition-name={validatedTransitionNames?.verdict}
          data-rly-release-transition-part="verdict"
          reason={release.reason}
          style={
            validatedTransitionNames === undefined
              ? undefined
              : { viewTransitionName: validatedTransitionNames.verdict }
          }
          tone={release.tone}
          verdict={release.verdict}
        />

        <dl className={style("facts")}>
          {release.facts.map((fact) => (
            <div className={style("fact")} key={fact.id}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {collaborators === undefined ? null : (
        <div className={style("slot")} data-rly-release-preview-slot="collaborators">
          {collaborators}
        </div>
      )}
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
    </div>
  )

  const fullViewAction = (
    <Button className={style("fullViewButton")} onClick={onOpenFullView} size="default" variant="secondary">
      {visibleOpenFullViewLabel}
    </Button>
  )

  return presentation === "sheet" ? (
    <Sheet.Root onOpenChange={onOpenChange} open={open}>
      <Sheet.Content entryMotion={entryMotion} initialFocusRef={summaryRef} title={title}>
        <Sheet.Body data-rly-release-preview-scroll="sheet">{dossier}</Sheet.Body>
        <Sheet.Footer className={style("sheetFooter")} data-rly-release-preview-footer="sheet">
          {fullViewAction}
        </Sheet.Footer>
      </Sheet.Content>
    </Sheet.Root>
  ) : (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Content
        className={style("dialogSurface")}
        entryMotion={entryMotion}
        initialFocusRef={summaryRef}
        size="wide"
        title={title}
      >
        <div className={style("dialogFrame")}>
          <div className={style("dialogClose")}>
            <Dialog.Close size="compact" variant="quiet">
              Close preview
            </Dialog.Close>
          </div>
          <div className={style("dialogScroll")} data-rly-release-preview-scroll="dialog">
            {dossier}
          </div>
          <footer className={style("dialogFooter")} data-rly-release-preview-footer="dialog">
            {fullViewAction}
          </footer>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  )
}

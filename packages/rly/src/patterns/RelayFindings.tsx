import type { ReactElement, ReactNode } from "react"
import { createElement, Fragment, useEffect, useId, useRef, useState } from "react"
import { Icon } from "../foundations/Icon.js"
import { RlyLink } from "../foundations/LinkProvider.js"
import { cssClass, requireText } from "../internal/component.js"
import { Button } from "../primitives/Button.js"
import styles from "./RelayFindings.module.css"

const style = (name: string): string => cssClass(styles, name)

/** A finding's priority, P1 most severe. */
export type RlyRelayFindingPriority = "P1" | "P2" | "P3" | "P4"

/** Where a finding points: the whole pull request, one file, or one line on the old or new side. */
export type RlyRelayFindingLocation =
  | { readonly scope: "general" }
  | { readonly scope: "file"; readonly filePath: string }
  | { readonly line: number; readonly filePath: string; readonly scope: "line"; readonly side: "before" | "after" }

/** One review finding, the shape of codecommit's RelayReviewFinding (rly takes no dependency on it). */
export interface RlyRelayFinding {
  readonly details: string
  readonly id: string
  readonly location: RlyRelayFindingLocation
  readonly priority: RlyRelayFindingPriority
  readonly recommendation: string
  readonly summary: string
  readonly title: string
  readonly verification: string
}

/** What the reader and the host have done with a finding; the host owns it. */
export type RlyRelayFindingDisposition =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "Dismissed" }
  | { readonly _tag: "Posting" }
  | { readonly _tag: "Posted"; readonly receipt: { readonly href?: string; readonly summary: string } }
  | { readonly _tag: "Failed"; readonly cause: string }

/** Inputs for the findings view. */
export interface RelayFindingsProps {
  /** The old side's revision, when known, so a before-side line says which code it means. */
  readonly baseRevision?: string
  /** The pull request's head now; differing from `reviewedHead` makes the set stale. */
  readonly currentHead: string
  readonly dispositions: Readonly<Record<string, RlyRelayFindingDisposition>>
  readonly findings: ReadonlyArray<RlyRelayFinding>
  /** The level of each location group's heading, chosen by the host's outline. */
  readonly headingLevel: 2 | 3 | 4 | 5 | 6
  /** Toggle Accept or Dismiss; pressing the pressed one again returns the finding to pending. */
  readonly onDispositionChange: (id: string, next: "Accepted" | "Dismissed" | "Pending") => void
  /** Attach the finding set to the conversation as context and ask about this finding. */
  readonly onDiscuss: (id: string) => void
  /** Open a finding where it points; never offered for a before-side line (the head has no such line). */
  readonly onOpen?: (finding: RlyRelayFinding) => void
  /** Start posting the given accepted findings, each as its own confirmed call. */
  readonly onPostAccepted: (ids: ReadonlyArray<string>) => void
  /** Review the current head again. */
  readonly onRerun: () => void
  /** Run one failed finding's confirmed post again. */
  readonly onRetry: (id: string) => void
  /** The revision the findings were made against; they are never relabelled with a newer head. */
  readonly reviewedHead: string
  /** What was reviewed, for the empty result: "correctness with Codex". */
  readonly reviewedFor: string
}

const severity = {
  P1: { icon: "alert", word: "Blocking" },
  P2: { icon: "alert", word: "Should fix" },
  P3: { icon: "minus", word: "Consider" },
  P4: { icon: "minus", word: "Nit" }
} satisfies Readonly<Record<RlyRelayFindingPriority, { readonly icon: "alert" | "minus"; readonly word: string }>>

const dispositionWord = {
  Accepted: "Accepted",
  Dismissed: "Dismissed",
  Failed: "Not confirmed posted",
  Pending: "To review",
  Posted: "Posted",
  Posting: "Posting…"
} satisfies Readonly<Record<RlyRelayFindingDisposition["_tag"], string>>

const groupKey = (location: RlyRelayFindingLocation): string => (location.scope === "general" ? "" : location.filePath)
const lineOf = (location: RlyRelayFindingLocation): number => (location.scope === "line" ? location.line : 0)

/** A path that wraps after each "/" and keeps its full text for assistive technology. */
const WrappingPath = ({ path }: { readonly path: string }): ReactElement => (
  <>
    {path.split("/").map((part, index, parts) => (
      <Fragment key={index}>
        {part}
        {index < parts.length - 1 ? (
          <>
            /<wbr />
          </>
        ) : null}
      </Fragment>
    ))}
  </>
)

const Heading = ({
  children,
  level
}: {
  readonly children: ReactNode
  readonly level: RelayFindingsProps["headingLevel"]
}) => createElement(`h${level}`, { className: style("heading") }, children)

/**
 * Relay's review findings (Relay UX decision): grouped by where they point, the whole pull request
 * first, then each file in the order the review raised it, most severe first within a group. Severity
 * is an icon, a word and the P-number, never colour alone. Accept and Dismiss are toggles; Discuss
 * attaches the set to the conversation. "Post accepted" starts one confirmed call per finding, never a
 * bulk write. When the head has moved since the review, a banner says so, and line findings wait for a
 * re-run rather than land on the wrong line. A before-side line is shown as text and never opens a
 * head line. Posting outcomes, which the reader did not just do, are announced once per finding.
 */
export const RelayFindings = (props: RelayFindingsProps): ReactElement => {
  const { currentHead, dispositions, findings, headingLevel, reviewedHead } = props
  const postId = useId()
  const root = useRef<HTMLDivElement | null>(null)
  const [announcement, setAnnouncement] = useState("")
  // Words waiting to be said, numbered so a repeat is a change; delivered apart from other renders.
  const [pending, setPending] = useState<{ readonly count: number; readonly words: string } | null>(null)
  const previous = useRef(new Map<string, RlyRelayFindingDisposition["_tag"]>())
  const announced = useRef(new Set<string>())
  const stale = reviewedHead !== currentHead
  const disposition = (id: string): RlyRelayFindingDisposition => dispositions[id] ?? { _tag: "Pending" }

  const accepted = findings.filter((finding) => disposition(finding.id)._tag === "Accepted")
  const postable = accepted.filter((finding) => !(stale && finding.location.scope === "line"))
  const postReason =
    accepted.length === 0
      ? "Accept findings to post them."
      : postable.length === 0
        ? "Line findings wait for a re-run: the head moved since the review."
        : undefined

  // Posting outcomes arrive asynchronously; say each once. Cleared first so a repeat is still heard.
  useEffect(() => {
    let words: string | undefined
    for (const finding of findings) {
      const now = disposition(finding.id)._tag
      const before = previous.current.get(finding.id)
      previous.current.set(finding.id, now)
      const key = `${finding.id}:${now}`
      if (before !== "Posting" || (now !== "Posted" && now !== "Failed") || announced.current.has(key)) continue
      announced.current.add(key)
      words = now === "Posted" ? `Posted ${finding.id}: ${finding.title}` : `${finding.id} was not confirmed posted`
    }
    if (words === undefined) return
    const said = words
    setPending((before) => ({ count: (before?.count ?? 0) + 1, words: said }))
  }, [dispositions, findings])

  useEffect(() => {
    if (pending === null) return
    const view = root.current?.ownerDocument.defaultView ?? null
    setAnnouncement("")
    if (view === null) return setAnnouncement(pending.words)
    const frame = view.requestAnimationFrame(() => setAnnouncement(pending.words))
    return () => view.cancelAnimationFrame(frame)
  }, [pending])

  const groups = new Map<string, Array<RlyRelayFinding>>()
  for (const finding of findings) {
    const key = groupKey(finding.location)
    groups.set(key, [...(groups.get(key) ?? []), finding])
  }
  const ordered = [...groups.entries()].sort(([left], [right]) => (left === "" ? -1 : right === "" ? 1 : 0))

  return (
    <div className={style("root")} ref={root}>
      {stale ? (
        <div className={style("stale")}>
          <p className={style("staleText")}>
            <Icon decorative name="alert" size="small" />
            Reviewed <code>{reviewedHead}</code>; the head is now <code>{currentHead}</code>. Findings may not match the
            code.
          </p>
          <Button onClick={props.onRerun} type="button">
            Re-run
          </Button>
        </div>
      ) : null}
      {findings.length === 0 ? (
        <p className={style("empty")}>
          No findings at <code>{reviewedHead}</code>. Reviewed for{" "}
          {requireText(props.reviewedFor, "RelayFindings reviewed for")}.
        </p>
      ) : (
        <>
          <div className={style("post")}>
            <Button
              aria-describedby={postId}
              aria-disabled={postReason !== undefined}
              onClick={() => {
                if (postReason === undefined) props.onPostAccepted(postable.map((finding) => finding.id))
              }}
              type="button"
              variant="primary"
            >
              {`Post accepted (${postable.length})`}
            </Button>
            <p className={style("meta")} id={postId}>
              {postReason ?? "Each is posted as its own comment, after you confirm it."}
            </p>
          </div>
          {ordered.map(([key, group]) => {
            const sorted = [...group].sort(
              (left, right) =>
                left.priority.localeCompare(right.priority) || lineOf(left.location) - lineOf(right.location)
            )
            const blocking = group.filter((finding) => finding.priority === "P1").length
            return (
              <section className={style("group")} key={key === "" ? "general" : key}>
                <Heading level={headingLevel}>
                  {key === "" ? "Whole pull request" : <WrappingPath path={key} />}
                  <span className={style("count")}>
                    {`, ${group.length} ${group.length === 1 ? "finding" : "findings"}${blocking === 0 ? "" : `, ${blocking} blocking`}`}
                  </span>
                </Heading>
                <ol className={style("list")}>
                  {sorted.map((finding) => (
                    <FindingItem
                      baseRevision={props.baseRevision}
                      disposition={disposition(finding.id)}
                      finding={finding}
                      key={finding.id}
                      onDiscuss={props.onDiscuss}
                      onDispositionChange={props.onDispositionChange}
                      onOpen={props.onOpen}
                      onRetry={props.onRetry}
                    />
                  ))}
                </ol>
              </section>
            )
          })}
        </>
      )}
      <p aria-live="polite" className={style("announcer")}>
        {announcement}
      </p>
    </div>
  )
}

const Location = ({
  baseRevision,
  finding,
  onOpen
}: {
  readonly baseRevision: string | undefined
  readonly finding: RlyRelayFinding
  readonly onOpen: RelayFindingsProps["onOpen"]
}): ReactElement | null => {
  const location = finding.location
  if (location.scope === "general") return null
  if (location.scope === "line" && location.side === "before") {
    // The old side's line does not exist in the head: shown, never opened against the head file.
    return (
      <span className={style("location")}>
        <WrappingPath path={location.filePath} />
        {`:${location.line}, old side${baseRevision === undefined ? "" : ` at ${baseRevision}`}`}
      </span>
    )
  }
  const label = location.scope === "line" ? `${location.filePath}:${location.line}` : location.filePath
  const text = (
    <>
      <WrappingPath path={location.filePath} />
      {location.scope === "line" ? `:${location.line}` : null}
    </>
  )
  return onOpen === undefined ? (
    <span className={style("location")}>{text}</span>
  ) : (
    <button aria-label={`Open ${label}`} className={style("open")} onClick={() => onOpen(finding)} type="button">
      {text}
    </button>
  )
}

const FindingItem = ({
  baseRevision,
  disposition,
  finding,
  onDiscuss,
  onDispositionChange,
  onOpen,
  onRetry
}: {
  readonly baseRevision: string | undefined
  readonly disposition: RlyRelayFindingDisposition
  readonly finding: RlyRelayFinding
  readonly onDiscuss: RelayFindingsProps["onDiscuss"]
  readonly onDispositionChange: RelayFindingsProps["onDispositionChange"]
  readonly onOpen: RelayFindingsProps["onOpen"]
  readonly onRetry: RelayFindingsProps["onRetry"]
}): ReactElement => {
  const { icon, word } = severity[finding.priority]
  const decided = disposition._tag === "Posting" || disposition._tag === "Posted"
  return (
    <li className={style("finding")} data-disposition={disposition._tag}>
      <p className={style("severity")}>
        <Icon decorative name={icon} size="small" />
        {`${word} (${finding.priority})`}
        <span className={style("state")}>{dispositionWord[disposition._tag]}</span>
      </p>
      <p className={style("title")}>{requireText(finding.title, "RelayFindings title")}</p>
      <Location baseRevision={baseRevision} finding={finding} onOpen={onOpen} />
      <p className={style("summary")}>{requireText(finding.summary, "RelayFindings summary")}</p>
      <details className={style("details")}>
        <summary>Evidence and recommendation</summary>
        <dl className={style("evidence")}>
          <dt>Evidence</dt>
          <dd>{finding.details}</dd>
          <dt>Recommendation</dt>
          <dd>{finding.recommendation}</dd>
          <dt>Verification</dt>
          <dd>{finding.verification}</dd>
        </dl>
      </details>
      {disposition._tag === "Posted" ? (
        <p className={style("meta")}>
          {disposition.receipt.href === undefined ? (
            disposition.receipt.summary
          ) : (
            <RlyLink href={disposition.receipt.href}>{disposition.receipt.summary}</RlyLink>
          )}
        </p>
      ) : null}
      {disposition._tag === "Failed" ? (
        <p className={style("failed")}>
          {disposition.cause} It may or may not have been posted; check before trying again.
        </p>
      ) : null}
      {decided ? null : (
        <div className={style("actions")}>
          {disposition._tag === "Failed" ? (
            <Button onClick={() => onRetry(finding.id)} type="button">
              Try again
            </Button>
          ) : (
            <>
              <Button
                aria-pressed={disposition._tag === "Accepted"}
                onClick={() =>
                  onDispositionChange(finding.id, disposition._tag === "Accepted" ? "Pending" : "Accepted")
                }
                type="button"
              >
                Accept
              </Button>
              <Button
                aria-pressed={disposition._tag === "Dismissed"}
                onClick={() =>
                  onDispositionChange(finding.id, disposition._tag === "Dismissed" ? "Pending" : "Dismissed")
                }
                type="button"
              >
                Dismiss
              </Button>
            </>
          )}
          <Button onClick={() => onDiscuss(finding.id)} type="button" variant="quiet">
            Discuss
          </Button>
        </div>
      )}
    </li>
  )
}

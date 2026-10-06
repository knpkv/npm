import { type ComponentPropsWithRef, type ReactElement, type ReactNode, useId } from "react"
import { RlyLink } from "../foundations/LinkProvider.js"
import { classNames, cssClass, requireText } from "../internal/component.js"
import { ServiceMark, type RlyService } from "./ServiceMark.js"
import styles from "./TimelineRow.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Explicit actor identities supported by normalized activity presentation. */
export type RlyTimelineActorKind = "human" | "agent" | "plugin" | "system"

/**
 * How an event changed the record, told apart by shape and by a visible label:
 * `auto` was applied automatically (an observation), `approved` was approved by a person,
 * `pending` waits for approval, `unknown` could not be read and changed nothing, and `flag`
 * only raised a flag.
 */
export type RlyTimelineProvenanceKind = "auto" | "approved" | "pending" | "unknown" | "flag"

/** The provenance of one event: its kind and the words that say it ("Applied automatically, from GitHub"). */
export interface RlyTimelineProvenance {
  readonly kind: RlyTimelineProvenanceKind
  readonly label: string
}

/** One application-supplied activity record with no time or provenance derivation. */
export interface RlyTimelineEvent {
  readonly actor?: ReactNode
  readonly actorKind: RlyTimelineActorKind
  readonly dateTime: string
  readonly detail: string
  readonly href?: string
  readonly id: string
  /** Optional provenance; when given, the marker takes its shape and its label is shown. */
  readonly provenance?: RlyTimelineProvenance
  readonly service?: RlyService
  readonly time: string
  readonly title: string
}

/** Props for one native timeline list item. */
export type TimelineRowProps = Omit<ComponentPropsWithRef<"li">, "children"> & {
  /** Whether the neutral chronology line continues to the following item. */
  readonly continued: boolean
  readonly event: RlyTimelineEvent
}

const actorLabels = {
  human: "Human",
  agent: "Agent",
  plugin: "Plugin",
  system: "System"
} satisfies Readonly<Record<RlyTimelineActorKind, string>>

const provenanceMarkClass = {
  auto: "markAuto",
  approved: "markApproved",
  pending: "markPending",
  unknown: "markUnknown",
  flag: "markFlag"
} satisfies Readonly<Record<RlyTimelineProvenanceKind, string>>

const validateEvent = (event: RlyTimelineEvent): RlyTimelineEvent => {
  requireText(event.id, "TimelineRow event id")
  requireText(event.title, "TimelineRow event title")
  requireText(event.detail, "TimelineRow event detail")
  requireText(event.dateTime, "TimelineRow event dateTime")
  requireText(event.time, "TimelineRow event time")
  if (event.href !== undefined) requireText(event.href, "TimelineRow event href")
  if (event.provenance !== undefined) {
    if (!Object.hasOwn(provenanceMarkClass, event.provenance.kind)) {
      throw new Error("TimelineRow provenance kind must be auto, approved, pending, unknown, or flag")
    }
    requireText(event.provenance.label, "TimelineRow provenance label")
  }
  if (!Object.hasOwn(actorLabels, event.actorKind)) {
    throw new Error("TimelineRow event actorKind must be human, agent, plugin, or system")
  }
  return event
}

/** Render a complete activity record without owning filtering, grouping, or live announcements. */
export const TimelineRow = ({
  className,
  continued,
  event: suppliedEvent,
  ...props
}: TimelineRowProps): ReactElement => {
  const event = validateEvent(suppliedEvent)
  const titleId = `rly-timeline-row-${useId()}`
  const title = (
    <h2 className={style("title")} id={titleId}>
      {event.title}
    </h2>
  )

  return (
    <li
      {...props}
      className={classNames(style("root"), className)}
      data-rly-timeline-actor={event.actorKind}
      data-rly-timeline-event-id={event.id}
    >
      <time className={style("time")} dateTime={event.dateTime}>
        {event.time}
      </time>
      <span aria-hidden="true" className={style("marker")}>
        <span
          className={event.provenance === undefined ? style("dot") : style(provenanceMarkClass[event.provenance.kind])}
          data-rly-timeline-provenance={event.provenance?.kind}
        />
        {continued ? <span className={style("connector")} data-rly-timeline-connector="" /> : null}
      </span>
      <article aria-labelledby={titleId} className={style("content")}>
        {event.href === undefined ? (
          title
        ) : (
          <RlyLink className={style("link")} href={event.href}>
            {title}
          </RlyLink>
        )}
        <p className={style("detail")}>{event.detail}</p>
        {event.provenance === undefined ? null : (
          <p className={style("provenance")} data-rly-timeline-provenance-label={event.provenance.kind}>
            {event.provenance.label}
          </p>
        )}
      </article>
      <div className={style("meta")}>
        <span className={style("actorKind")}>{actorLabels[event.actorKind]}</span>
        {event.service === undefined ? null : <ServiceMark service={event.service} size="compact" />}
        {event.actor === undefined ? null : <div className={style("actor")}>{event.actor}</div>}
      </div>
    </li>
  )
}

const keyLabels = {
  auto: "applied automatically",
  approved: "approved",
  pending: "waiting for approval",
  unknown: "couldn't read",
  flag: "flag only"
} satisfies Readonly<Record<RlyTimelineProvenanceKind, string>>

/** Props for the legend of provenance shapes shown beside a timeline. */
export type TimelineProvenanceKeyProps = Omit<ComponentPropsWithRef<"ul">, "children"> & {
  /** Kinds to explain, in order. Defaults to every kind. */
  readonly kinds?: ReadonlyArray<RlyTimelineProvenanceKind>
  /** Required accessible name of the legend, such as "Observation key". */
  readonly label: string
  /** Words per kind, when the application's wording differs from the defaults. */
  readonly labels?: Partial<Readonly<Record<RlyTimelineProvenanceKind, string>>>
}

/** The key for provenance shapes: a named list, each shape beside its words, kept together when it wraps. */
export const TimelineProvenanceKey = ({
  className,
  kinds = ["auto", "approved", "pending", "unknown", "flag"],
  label,
  labels = {},
  ...props
}: TimelineProvenanceKeyProps): ReactElement => (
  <ul
    {...props}
    aria-label={requireText(label, "TimelineProvenanceKey label")}
    className={classNames(style("key"), className)}
    role="list"
  >
    {kinds.map((kind) => (
      <li className={style("keyItem")} key={kind}>
        <span aria-hidden="true" className={style(provenanceMarkClass[kind])} data-rly-timeline-provenance={kind} />{" "}
        {labels[kind] ?? keyLabels[kind]}
      </li>
    ))}
  </ul>
)

import { type ComponentPropsWithRef, type ReactElement, type ReactNode, useId } from "react"
import { RlyLink } from "../foundations/LinkProvider.js"
import { classNames, cssClass, requireText } from "../internal/component.js"
import { ServiceMark, type RlyService } from "./ServiceMark.js"
import styles from "./TimelineRow.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Explicit actor identities supported by normalized activity presentation. */
export type RlyTimelineActorKind = "human" | "agent" | "plugin" | "system"

/** One application-supplied activity record with no time or provenance derivation. */
export interface RlyTimelineEvent {
  readonly actor?: ReactNode
  readonly actorKind: RlyTimelineActorKind
  readonly dateTime: string
  readonly detail: string
  readonly href?: string
  readonly id: string
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

const validateEvent = (event: RlyTimelineEvent): RlyTimelineEvent => {
  requireText(event.id, "TimelineRow event id")
  requireText(event.title, "TimelineRow event title")
  requireText(event.detail, "TimelineRow event detail")
  requireText(event.dateTime, "TimelineRow event dateTime")
  requireText(event.time, "TimelineRow event time")
  if (event.href !== undefined) requireText(event.href, "TimelineRow event href")
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
        <span className={style("dot")} />
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
      </article>
      <div className={style("meta")}>
        <span className={style("actorKind")}>{actorLabels[event.actorKind]}</span>
        {event.service === undefined ? null : <ServiceMark service={event.service} size="compact" />}
        {event.actor === undefined ? null : <div className={style("actor")}>{event.actor}</div>}
      </div>
    </li>
  )
}

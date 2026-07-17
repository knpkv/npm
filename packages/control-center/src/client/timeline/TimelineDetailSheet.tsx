import { ServiceMark } from "@knpkv/rly/patterns"
import { Button, Sheet, Skeleton, StateLabel, StatePanel, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import type { ReactElement } from "react"
import { Link } from "react-router"

import type { TimelineEvent, TimelineEventDetail, TimelineSourceKind } from "../../domain/timeline.js"
import styles from "./TimelineDetailSheet.module.css"
import { type TimelineDetailTransport, useTimelineDetail } from "./useTimelineDetail.js"

const sourceLabels: Readonly<Record<TimelineSourceKind, string>> = {
  action: "Governed action",
  "plugin-sync": "Service sync",
  relationship: "Delivery link",
  system: "Control Center"
}

const formatTimestamp = (event: TimelineEvent): string =>
  DateTime.formatUtc(event.occurredAt, {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    locale: "en-GB",
    minute: "2-digit",
    month: "short",
    second: "2-digit",
    year: "numeric"
  })

/** Non-secret durable references that make one owner-visible event attributable. */
export const timelineDetailLedger = (
  detail: TimelineEventDetail
): ReadonlyArray<{ readonly label: string; readonly value: string }> => {
  const optionalEntries: ReadonlyArray<{ readonly label: string; readonly value: string | null }> = [
    { label: "Actor", value: detail.identifiers.actorId },
    { label: "Agent job", value: detail.agentJob?.jobId ?? null },
    { label: "Action", value: detail.identifiers.actionId },
    { label: "Relationship", value: detail.identifiers.relationshipId },
    { label: "Connection", value: detail.identifiers.pluginConnectionId },
    { label: "Release", value: detail.identifiers.releaseId },
    { label: "Entity", value: detail.identifiers.entityId }
  ]
  return [
    { label: "Event", value: detail.event.eventKey },
    { label: "Type", value: detail.event.eventType },
    ...optionalEntries.filter(
      (entry): entry is { readonly label: string; readonly value: string } => entry.value !== null
    )
  ]
}

/** Owner-only expansion of one redacted Timeline row into its durable provenance. */
export const TimelineDetailSheet = ({
  agentHref,
  event,
  onClose,
  onSessionExpired,
  sessionKey,
  transport
}: {
  readonly agentHref: string
  readonly event: TimelineEvent | null
  readonly onClose: () => void
  readonly onSessionExpired: (sessionKey: string) => void
  readonly sessionKey: string | null
  readonly transport?: TimelineDetailTransport
}): ReactElement => {
  const controller = useTimelineDetail(event?.eventKey ?? null, sessionKey, onSessionExpired, transport)

  return (
    <Sheet.Root
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open={event !== null}
    >
      <Sheet.Content
        closeLabel="Close event details"
        description="Durable provenance for this exact workspace event."
        title="Event details"
      >
        <Sheet.Body className={styles.body}>
          {event === null || controller.state._tag === "idle" || controller.state._tag === "loading" ? (
            <div aria-busy="true" aria-label="Loading event details" className={styles.loading}>
              <Skeleton height="10rem" />
              <Skeleton height="14rem" />
            </div>
          ) : controller.state._tag === "failed" ? (
            <StatePanel
              action={<Button onClick={controller.retry}>Try again</Button>}
              description="The Timeline row remains unchanged. Its provenance could not be loaded."
              title="Event details unavailable"
              tone="caution"
            />
          ) : (
            <div className={styles.content}>
              <section aria-labelledby="timeline-detail-title" className={styles.identity}>
                <Text tone="secondary" variant="label">
                  {sourceLabels[controller.state.detail.event.sourceKind]}
                </Text>
                <Text as="h2" id="timeline-detail-title" variant="page-title">
                  {controller.state.detail.event.title}
                </Text>
                <div className={styles.identityMeta}>
                  <StateLabel
                    label={controller.state.detail.event.actor.kind}
                    size="compact"
                    tone={controller.state.detail.event.actor.kind === "agent" ? "progress" : "neutral"}
                  />
                  {controller.state.detail.event.service === null ? null : (
                    <ServiceMark service={controller.state.detail.event.service} size="compact" />
                  )}
                  <Text tone="secondary" variant="meta">
                    {controller.state.detail.event.actor.label}
                  </Text>
                  <Text
                    as="time"
                    dateTime={DateTime.formatIso(controller.state.detail.event.occurredAt)}
                    tone="secondary"
                    variant="meta"
                  >
                    {formatTimestamp(controller.state.detail.event)} UTC
                  </Text>
                </div>
              </section>

              <section aria-labelledby="timeline-provenance-title" className={styles.section}>
                <Text as="h3" id="timeline-provenance-title" variant="section-title">
                  Provenance
                </Text>
                <dl className={styles.ledger}>
                  {timelineDetailLedger(controller.state.detail).map(({ label, value }) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>
          )}
        </Sheet.Body>
        <Sheet.Footer>
          <Link className={styles.footerLink} to={agentHref}>
            Ask Relay about this event
          </Link>
        </Sheet.Footer>
      </Sheet.Content>
    </Sheet.Root>
  )
}

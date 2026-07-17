import { Button, Sheet, Skeleton, StateLabel, StatePanel, Text } from "@knpkv/rly/primitives"
import type { RlyStateTone } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import type { ReactElement } from "react"

import type { EvidenceInspection, RelationshipHistoryInspection } from "../../api/deliveryGraph.js"
import type { DeliveryRelationship, EvidenceClaim, EvidenceItem } from "../../domain/deliveryGraph.js"
import type { EvidenceId } from "../../domain/identifiers.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import styles from "./RelationshipDetailSheet.module.css"
import { type RelationshipDetailsTransport, useRelationshipDetails } from "./useRelationshipDetails.js"

const titleCase = (value: string): string =>
  value
    .split("-")
    .map((part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`)
    .join(" ")

export const formatRelationshipTimestamp = (value: UtcTimestamp): string =>
  DateTime.formatUtc(value, {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    locale: "en-GB",
    minute: "2-digit",
    month: "short",
    year: "numeric"
  })

export const relationshipActorLabel = (actor: DeliveryRelationship["recordedBy"]): string => {
  switch (actor._tag) {
    case "human":
      return `Human · ${actor.personId.slice(-6)}`
    case "agent":
      return `Agent · ${actor.agentId.slice(-6)}`
    case "system":
      return `System · ${actor.component}`
  }
}

export const relationshipProvenanceLabel = (provenance: DeliveryRelationship["provenance"]): string => {
  switch (provenance._tag) {
    case "plugin":
      return `Plugin source · ${provenance.pluginConnectionId.slice(-6)}`
    case "human":
      return `Human decision · ${provenance.personId.slice(-6)}`
    case "agent":
      return `Agent proposal · ${provenance.agentId.slice(-6)}`
    case "rule":
      return `Rule · ${provenance.ruleId} v${String(provenance.ruleVersion)}`
  }
}

const relationshipRationale = (relationship: DeliveryRelationship): string => {
  switch (relationship.confidence._tag) {
    case "confirmed":
      return "Confirmed by immutable evidence."
    case "inferred":
    case "unknown":
      return relationship.confidence.rationale
  }
}

const relationshipConfidenceLabel = (relationship: DeliveryRelationship): string => {
  switch (relationship.confidence._tag) {
    case "confirmed":
      return "Confirmed"
    case "inferred":
      return `Inferred ${String(Math.round(relationship.confidence.score * 100))}%`
    case "unknown":
      return "Confidence unknown"
  }
}

const relationshipLifecycleTone = (relationship: DeliveryRelationship): RlyStateTone => {
  switch (relationship.lifecycle._tag) {
    case "missing":
    case "rejected":
      return "critical"
    case "governed":
    case "verified":
      return "positive"
    case "inferred":
    case "proposed":
      return "progress"
    case "superseded":
      return "neutral"
  }
}

const relationshipScopeLabel = (relationship: DeliveryRelationship): string => {
  if (relationship.scope === null) return "Workspace"
  if (relationship.scope._tag === "release") return `Release · ${relationship.scope.releaseId.slice(-6)}`
  return `Environment · ${relationship.scope.environmentId.slice(-6)}`
}

const evidenceFreshnessTone = (evidence: EvidenceItem): RlyStateTone => {
  switch (evidence.freshness._tag) {
    case "current":
      return "positive"
    case "stale":
      return "caution"
    case "missing":
    case "unavailable":
      return "critical"
  }
}

const lifecycleReason = (relationship: DeliveryRelationship): string | null => {
  switch (relationship.lifecycle._tag) {
    case "missing":
    case "rejected":
    case "superseded":
      return relationship.lifecycle.reason
    case "governed":
    case "inferred":
    case "proposed":
    case "verified":
      return null
  }
}

const evidencePartyLabel = (party: EvidenceItem["attribution"] | EvidenceItem["verifier"]): string => {
  switch (party._tag) {
    case "plugin":
      return `Plugin · ${party.pluginConnectionId.slice(-6)}`
    case "human":
      return `Human · ${party.personId.slice(-6)}`
    case "agent":
      return `Agent · ${party.agentId.slice(-6)}`
    case "system":
      return `System · ${party.component}`
  }
}

export const evidenceClaimValueLabel = (claim: EvidenceClaim): string => {
  switch (claim.value._tag) {
    case "flag":
      return claim.value.value ? "Yes" : "No"
    case "state":
    case "revision":
      return claim.value.value
    case "reference":
      return `Node ${claim.value.targetNodeId.slice(-6)}`
  }
}

const EvidenceCard = ({
  claims,
  inspection,
  relationship
}: {
  readonly claims: ReadonlyArray<EvidenceClaim>
  readonly inspection: EvidenceInspection
  readonly relationship: DeliveryRelationship
}): ReactElement => {
  const relatedClaimIds = new Set(relationship.evidenceClaimIds)
  const relatedClaims = claims.filter(
    ({ evidenceClaimId, evidenceId }) =>
      evidenceId === inspection.evidence.evidenceId && relatedClaimIds.has(evidenceClaimId)
  )
  const evidence = inspection.evidence
  return (
    <article className={styles.evidenceCard}>
      <div className={styles.evidenceHeading}>
        <Text as="h4" variant="label">
          Evidence {evidence.evidenceId.slice(-6)}
        </Text>
        <StateLabel label={titleCase(evidence.freshness._tag)} size="compact" tone={evidenceFreshnessTone(evidence)} />
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Observed</dt>
          <dd>{formatRelationshipTimestamp(evidence.observedAt)}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{evidencePartyLabel(evidence.attribution)}</dd>
        </div>
        <div>
          <dt>Verified by</dt>
          <dd>{evidencePartyLabel(evidence.verifier)}</dd>
        </div>
        <div>
          <dt>Retention</dt>
          <dd>
            {titleCase(evidence.retention.classification)}
            {evidence.retention.legalHold ? " · Legal hold" : ""}
          </dd>
        </div>
        <div>
          <dt>Valid until</dt>
          <dd>
            {evidence.validUntil === null ? "No expiry recorded" : formatRelationshipTimestamp(evidence.validUntil)}
          </dd>
        </div>
      </dl>
      {relatedClaims.length === 0 ? (
        <Text tone="secondary" variant="meta">
          No referenced claim was returned for this observation.
        </Text>
      ) : (
        <ul className={styles.claims}>
          {relatedClaims.map((claim) => (
            <li key={claim.evidenceClaimId}>
              <Text as="span" variant="label">
                {titleCase(claim.predicate)}
              </Text>
              <Text as="span" tone="secondary">
                {evidenceClaimValueLabel(claim)}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

/** Report the bounded history prefix without presenting it as a complete ledger. */
export const relationshipHistoryCountLabel = (revisions: RelationshipHistoryInspection["revisions"]): string => {
  let newestRevision = 0
  for (const revision of revisions) newestRevision = Math.max(newestRevision, revision.revision)
  if (newestRevision > revisions.length) return `${String(revisions.length)} of ${String(newestRevision)} revisions`
  return `${String(revisions.length)} revision${revisions.length === 1 ? "" : "s"}`
}

/** URL-owned detail panel for immutable relationship history and evidence. */
export const RelationshipDetailSheet = ({
  claims,
  evidenceIds,
  onClose,
  onSessionExpired,
  relationship,
  sessionKey,
  transport
}: {
  readonly claims: ReadonlyArray<EvidenceClaim>
  readonly evidenceIds: ReadonlyArray<EvidenceId>
  readonly onClose: () => void
  readonly onSessionExpired: (sessionKey: string) => void
  readonly relationship: DeliveryRelationship | null
  readonly sessionKey: string | null
  readonly transport?: RelationshipDetailsTransport
}): ReactElement => {
  const controller = useRelationshipDetails(
    relationship?.relationshipId ?? null,
    evidenceIds,
    sessionKey,
    onSessionExpired,
    transport
  )
  const title = relationship === null ? "Relationship details" : `${titleCase(relationship.kind)} relationship`
  const evidenceIntegrityComplete = relationship === null || claims.length === relationship.evidenceClaimIds.length

  return (
    <Sheet.Root
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open={relationship !== null}
    >
      <Sheet.Content
        closeLabel={`Close ${title}`}
        description="Immutable delivery history and the evidence used to establish this connection."
        title={title}
      >
        <Sheet.Body className={styles.body}>
          {relationship === null || controller.state._tag === "idle" || controller.state._tag === "loading" ? (
            <div aria-busy="true" aria-label="Loading relationship details" className={styles.loading}>
              <Skeleton height="7rem" />
              <Skeleton height="12rem" />
            </div>
          ) : controller.state._tag === "failed" ? (
            <StatePanel
              action={<Button onClick={controller.retry}>Try again</Button>}
              description="The selected relationship remains unchanged. Its history could not be loaded."
              title="Relationship details unavailable"
              tone="caution"
            />
          ) : (
            <div className={styles.content}>
              <section aria-labelledby="relationship-summary-title" className={styles.summary}>
                <div className={styles.summaryHeading}>
                  <Text as="h3" id="relationship-summary-title" variant="section-title">
                    {relationship.sourceNodeKind} → {relationship.targetNodeKind}
                  </Text>
                  <div className={styles.tags}>
                    <StateLabel
                      label={titleCase(relationship.lifecycle._tag)}
                      size="compact"
                      tone={relationshipLifecycleTone(relationship)}
                    />
                    <StateLabel label={relationshipConfidenceLabel(relationship)} size="compact" tone="neutral" />
                  </div>
                </div>
                <Text tone="secondary">{relationshipRationale(relationship)}</Text>
                <dl className={styles.facts}>
                  <div>
                    <dt>Revision</dt>
                    <dd>{String(relationship.revision)}</dd>
                  </div>
                  <div>
                    <dt>Recorded by</dt>
                    <dd>{relationshipActorLabel(relationship.recordedBy)}</dd>
                  </div>
                  <div>
                    <dt>Origin</dt>
                    <dd>{relationshipProvenanceLabel(relationship.provenance)}</dd>
                  </div>
                  <div>
                    <dt>Scope</dt>
                    <dd>{relationshipScopeLabel(relationship)}</dd>
                  </div>
                  <div>
                    <dt>Recorded</dt>
                    <dd>{formatRelationshipTimestamp(relationship.recordedAt)}</dd>
                  </div>
                </dl>
              </section>

              <section aria-labelledby="relationship-history-title" className={styles.section}>
                <div className={styles.sectionHeading}>
                  <Text as="h3" id="relationship-history-title" variant="label">
                    History
                  </Text>
                  <StateLabel
                    label={relationshipHistoryCountLabel(controller.state.details.history.revisions)}
                    size="compact"
                    tone="neutral"
                  />
                </div>
                {controller.state.details.history.revisions.length === 0 ? (
                  <Text tone="secondary">No immutable ledger revisions were returned.</Text>
                ) : (
                  <ol className={styles.history}>
                    {controller.state.details.history.revisions.map((revision) => {
                      const reason = lifecycleReason(revision)
                      return (
                        <li key={`${revision.relationshipId}:${String(revision.revision)}`}>
                          <div className={styles.historyHeading}>
                            <Text as="span" variant="label">
                              Revision {String(revision.revision)}
                            </Text>
                            <StateLabel
                              label={titleCase(revision.lifecycle._tag)}
                              size="compact"
                              tone={relationshipLifecycleTone(revision)}
                            />
                          </div>
                          <Text tone="secondary" variant="meta">
                            {relationshipActorLabel(revision.recordedBy)} ·{" "}
                            {formatRelationshipTimestamp(revision.recordedAt)}
                          </Text>
                          {reason === null ? null : <Text tone="secondary">{reason}</Text>}
                        </li>
                      )
                    })}
                  </ol>
                )}
              </section>

              <section aria-labelledby="relationship-evidence-title" className={styles.section}>
                <div className={styles.sectionHeading}>
                  <Text as="h3" id="relationship-evidence-title" variant="label">
                    Evidence
                  </Text>
                  <StateLabel
                    label={`${String(controller.state.details.evidence.length)} observation${controller.state.details.evidence.length === 1 ? "" : "s"}`}
                    size="compact"
                    tone="neutral"
                  />
                </div>
                {evidenceIntegrityComplete ? null : (
                  <div className={styles.integrity}>
                    <StateLabel label="Evidence incomplete" size="compact" tone="critical" />
                    <Text tone="secondary">
                      One or more referenced claims are missing from the release slice. Refresh before relying on this
                      relationship.
                    </Text>
                  </div>
                )}
                {controller.state.details.evidence.length === 0 ? (
                  <Text tone="secondary">No immutable evidence is attached to this relationship revision.</Text>
                ) : (
                  <div className={styles.evidence}>
                    {controller.state.details.evidence.map((inspection) => (
                      <EvidenceCard
                        claims={claims}
                        inspection={inspection}
                        key={inspection.evidence.evidenceId}
                        relationship={relationship}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </Sheet.Body>
      </Sheet.Content>
    </Sheet.Root>
  )
}

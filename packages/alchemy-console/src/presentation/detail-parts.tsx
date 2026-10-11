import { Icon } from "@knpkv/rly/foundations"
import { Button, Skeleton, Text } from "@knpkv/rly/primitives"
import type { ReactElement, ReactNode } from "react"
import { DateTime, Option, Schema } from "effect"
import type { StackListCopy } from "./StackListView.js"
import type { ResourcePresentation, StackDetailState } from "./detail-model.js"

export const Missing = (): ReactElement => <span className="ac-detail-muted">Not available yet</span>

export const DetailPanel = ({
  children,
  title,
  unavailable = false
}: {
  readonly title: string
  readonly children?: ReactNode
  readonly unavailable?: boolean
}): ReactElement => (
  <div className={unavailable ? "ac-detail-panel ac-detail-unavailable" : "ac-detail-panel"}>
    <Text as="p" className="ac-detail-panel-title">
      {title}
    </Text>
    {children === undefined ? null : (
      <Text as="p" tone="secondary">
        {children}
      </Text>
    )}
  </div>
)

export const ResourceStatus = ({ status }: { readonly status: ResourcePresentation["status"] }): ReactElement => {
  if (status === null) return <span className="ac-detail-muted">Unknown</span>
  const success = status === "created" || status === "updated" || status === "replaced"
  return (
    <span
      className={`ac-resource-status ${success ? "ac-resource-success" : status === "failed" ? "ac-resource-failed" : "ac-resource-working"}`}
    >
      <Icon name={success ? "check" : status === "failed" ? "alert" : "loader"} decorative size="small" />
      {status.slice(0, 1).toUpperCase()}
      {status.slice(1)}
    </span>
  )
}

/** Display the actual recorded instant; unavailable times stay distinct from a known value. */
export const RecordedTime = ({ value }: { readonly value: string | null }): ReactElement => {
  const time = Option.getOrNull(Schema.decodeUnknownOption(Schema.DateTimeUtcFromString)(value))
  if (time === null) return <Missing />
  return (
    <time dateTime={DateTime.formatIso(time)}>
      {new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      }).format(DateTime.toEpochMillis(time))}
    </time>
  )
}

/** Provider labels describe validated normalized console URLs, never raw state URLs or clickable output values. */
export const ProviderLink = ({ resource }: { readonly resource: ResourcePresentation }): ReactElement | null => {
  if (resource.consoleUrl === null) return null
  return (
    <a
      data-rly-hit-area
      className="ac-detail-link ac-provider-link"
      href={resource.consoleUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      Open in {resource.resourceType.startsWith("Cloudflare.") ? "Cloudflare" : "AWS"} console{" "}
      <span aria-hidden="true">↗</span>
      <span className="ac-sr-only"> for {resource.logicalId}, opens in a new tab</span>
    </a>
  )
}

export const DetailBoundary = ({
  copy,
  onReadAgain,
  state
}: {
  readonly state: Exclude<StackDetailState, { readonly _tag: "Ready" }>
  readonly copy: StackListCopy
  readonly onReadAgain: () => void
}): ReactElement =>
  state._tag === "Loading" ? (
    <div aria-busy="true" className="ac-detail-loading">
      <span className="ac-sr-only" role="status">
        Reading stack state…
      </span>
      <Skeleton className="ac-detail-title-skeleton" />
      <Skeleton variant="block" className="ac-detail-body-skeleton" />
    </div>
  ) : (
    <section className="ac-state-panel" role="status">
      <Text as="h1" className="ac-state-title" variant="section-title">
        {state._tag === "Unauthorized"
          ? state.reason === "bootstrap"
            ? "Sign-in failed or link already used."
            : `Your ${copy.product} session has ended.`
          : state._tag === "NotFound"
            ? "This stack is no longer available."
            : "Stack state is unavailable right now."}
      </Text>
      <Text as="p" tone="secondary">
        {state._tag === "Unauthorized"
          ? "Sign in again to see stacks."
          : state._tag === "NotFound"
            ? "Return to Stacks and Read again. Nothing was changed."
            : "The stack state couldn’t be read, so no resources are shown. Nothing was changed."}
      </Text>
      {state._tag === "Unauthorized" ? (
        <Text as="p" variant="meta" tone="secondary">
          {copy.signInInstruction}
        </Text>
      ) : state._tag === "Failed" ? (
        <Button className="ac-read" onClick={onReadAgain}>
          Retry
        </Button>
      ) : null}
    </section>
  )

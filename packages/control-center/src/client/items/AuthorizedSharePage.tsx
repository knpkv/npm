import { ServiceMark } from "@knpkv/rly/patterns"
import { Button, Skeleton, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { type ReactElement, useEffect, useState } from "react"
import { Link, useParams } from "react-router"

import type { AuthorizedShareResolution } from "../../api/shares.js"
import { ShareId, WorkspaceId } from "../../domain/identifiers.js"
import { useBrowserSession } from "../BrowserSession.js"
import { browserAuthorizedShareTransport, type AuthorizedShareTransport } from "./authorizedShareTransport.js"
import { serviceFor, statusFor, statusPresentation } from "./presentWorkspaceItems.js"
import styles from "./AuthorizedSharePage.module.css"

type AuthorizedSharePageState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "not-found" }
  | { readonly _tag: "ready"; readonly resolution: AuthorizedShareResolution }

const SHARE_REVALIDATION_MILLISECONDS = 30_000

const isTaggedFailure =
  (tag: string) =>
  (failure: unknown): boolean =>
    Predicate.hasProperty(failure, "_tag") && failure._tag === tag

const isNotFound = isTaggedFailure("NotFoundApiError")
const isUnauthorized = isTaggedFailure("UnauthorizedApiError")

export interface AuthorizedSharePageProps {
  readonly transport?: AuthorizedShareTransport
}

/** Direct-load authenticated page for one exact shared normalized item. */
export const AuthorizedSharePage = ({
  transport = browserAuthorizedShareTransport
}: AuthorizedSharePageProps = {}): ReactElement => {
  const params = useParams()
  const browserSession = useBrowserSession()
  const decodedShareId = Schema.decodeUnknownOption(ShareId)(params.shareId)
  const decodedWorkspaceId = Schema.decodeUnknownOption(WorkspaceId)(params.workspaceId)
  const shareId = Option.isSome(decodedShareId) ? decodedShareId.value : null
  const workspaceId = Option.isSome(decodedWorkspaceId) ? decodedWorkspaceId.value : null
  const session =
    browserSession.state._tag === "authenticated" && browserSession.state.session.workspaceId === workspaceId
      ? browserSession.state.session
      : null
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<AuthorizedSharePageState>({ _tag: "idle" })

  useEffect(() => {
    if (shareId === null || workspaceId === null || session === null) {
      setState({ _tag: "idle" })
      return
    }
    const request = new AbortController()
    setState({ _tag: "loading" })
    const program = Effect.gen(function* () {
      while (!request.signal.aborted) {
        const result = yield* Effect.tryPromise({
          try: () => transport.resolve(workspaceId, shareId, request.signal),
          catch: (cause) => cause
        }).pipe(Effect.result)
        if (request.signal.aborted) return
        if (result._tag === "Failure") {
          if (isUnauthorized(result.failure)) browserSession.invalidateSession(session.sessionId)
          setState(isNotFound(result.failure) ? { _tag: "not-found" } : { _tag: "failed" })
          return
        }
        setState({ _tag: "ready", resolution: result.success })
        yield* Effect.sleep(Duration.millis(SHARE_REVALIDATION_MILLISECONDS))
      }
    })
    Effect.runPromise(program, { signal: request.signal }).catch(() => {
      if (!request.signal.aborted) setState({ _tag: "failed" })
    })
    return () => request.abort()
  }, [browserSession, requestRevision, session, shareId, transport, workspaceId])

  if (shareId === null || workspaceId === null) {
    return (
      <StatePanel
        action={<Link to="/">Return to Control Center</Link>}
        description="This authorized link is malformed. No item was substituted."
        title="Share unavailable"
        tone="caution"
      />
    )
  }

  if (browserSession.state._tag === "checking" || state._tag === "loading") {
    return (
      <section aria-label="Loading authorized share" className={styles.page}>
        <Skeleton height="8rem" variant="block" />
        <Skeleton height="18rem" variant="block" />
      </section>
    )
  }

  if (browserSession.state._tag !== "authenticated") {
    return (
      <StatePanel
        action={<Link to="/pair">Pair this browser</Link>}
        description="This link grants no bearer access. Pair as the selected person, then reopen it."
        title="Authentication required"
        tone="caution"
      />
    )
  }

  if (browserSession.state.session.workspaceId !== workspaceId) {
    return (
      <StatePanel
        action={<Link to={`/w/${browserSession.state.session.workspaceId}/items`}>Open workspace items</Link>}
        description="This link is scoped to another workspace. No item was substituted."
        title="Share unavailable"
        tone="caution"
      />
    )
  }

  if (state._tag === "not-found") {
    return (
      <StatePanel
        action={<Link to={`/w/${browserSession.state.session.workspaceId}/items`}>Open workspace items</Link>}
        description="The link may target another person, be expired or revoked, or point to a deleted item."
        title="Share unavailable"
        tone="caution"
      />
    )
  }

  if (state._tag === "failed" || state._tag === "idle") {
    return (
      <StatePanel
        action={<Button onClick={() => setRequestRevision((revision) => revision + 1)}>Try again</Button>}
        description="Control Center could not resolve this authorized link."
        title="Share unavailable"
        tone="caution"
      />
    )
  }

  const projection = state.resolution.item.projection
  const status = statusFor(projection.details)
  const presentation = statusPresentation(projection.entityType, status)
  return (
    <article className={styles.page}>
      <header className={styles.hero}>
        <Text as="p" tone="secondary" variant="label">
          Authorized item
        </Text>
        <Text as="h1" variant="verdict">
          Exact scope. Nothing adjacent.
        </Text>
        <Text tone="secondary" variant="body-large">
          This view contains only the granted current item projection. Releases, relationships, and evidence remain
          private.
        </Text>
      </header>
      <Surface as="section" className={styles.item} padding="spacious" tone="secondary">
        <div className={styles.itemHeader}>
          <ServiceMark service={serviceFor(projection.entityType)} size="compact" />
          <StateLabel label={status} size="compact" tone={presentation.tone} />
        </div>
        <Text as="p" tone="secondary" variant="label">
          {projection.displayKey}
        </Text>
        <Text as="h2" variant="section-title">
          {projection.title}
        </Text>
        <dl className={styles.facts}>
          <div>
            <dt>Type</dt>
            <dd>{projection.entityType}</dd>
          </div>
          <div>
            <dt>Observed</dt>
            <dd>{DateTime.formatIso(state.resolution.item.recordedAt)}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{DateTime.formatIso(state.resolution.share.expiresAt)}</dd>
          </div>
        </dl>
        <Link to={`/w/${browserSession.state.session.workspaceId}/items?object=${projection.entityId}#item-details`}>
          Open in workspace
        </Link>
      </Surface>
    </article>
  )
}

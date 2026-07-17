import { Button, StateLabel, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import { type FormEvent, type ReactElement, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router"

import type { WorkspaceEntityOwner } from "../../api/deliveryGraph.js"
import type { EntityId, ShareId, WorkspaceId } from "../../domain/identifiers.js"
import { PersonId } from "../../domain/identifiers.js"
import {
  browserAuthorizedShareTransport,
  type AuthorizedShareLifetime,
  type AuthorizedShareTransport,
  type CreateAuthorizedShareTransportInput
} from "./authorizedShareTransport.js"
import styles from "./ItemsPage.module.css"

interface ShareGrantee {
  readonly displayName: string
  readonly personId: PersonId
}

type AuthorizedSharePanelState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "creating" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly shareId: ShareId; readonly expiresAt: string }
  | { readonly _tag: "revoking"; readonly shareId: ShareId; readonly expiresAt: string }
  | { readonly _tag: "revoked" }

export interface AuthorizedSharePanelProps {
  readonly currentPersonId: PersonId
  readonly entityId: EntityId
  readonly grantees: ReadonlyArray<WorkspaceEntityOwner>
  readonly transport?: AuthorizedShareTransport
  readonly workspaceId: WorkspaceId
}

const shareLifetime = (value: string): AuthorizedShareLifetime => (value === "hour" || value === "week" ? value : "day")

const shareGrantees = (
  currentPersonId: PersonId,
  grantees: ReadonlyArray<WorkspaceEntityOwner>
): ReadonlyArray<ShareGrantee> => {
  const byId = new Map<PersonId, ShareGrantee>()
  byId.set(currentPersonId, { displayName: "You", personId: currentPersonId })
  for (const grantee of grantees) {
    byId.set(grantee.personId, { displayName: grantee.displayName, personId: grantee.personId })
  }
  return [...byId.values()]
}

/** Owner-only creation and revocation controls for one exact item share. */
export const AuthorizedSharePanel = ({
  currentPersonId,
  entityId,
  grantees,
  transport = browserAuthorizedShareTransport,
  workspaceId
}: AuthorizedSharePanelProps): ReactElement => {
  const options = useMemo(() => shareGrantees(currentPersonId, grantees), [currentPersonId, grantees])
  const [granteePersonId, setGranteePersonId] = useState<PersonId>(options[0]?.personId ?? currentPersonId)
  const [lifetime, setLifetime] = useState<AuthorizedShareLifetime>("day")
  const [state, setState] = useState<AuthorizedSharePanelState>({ _tag: "idle" })
  const createIntent = useRef<CreateAuthorizedShareTransportInput | null>(null)
  const currentRequest = useRef<AbortController | null>(null)
  const statusRegion = useRef<HTMLElement | null>(null)

  useEffect(() => () => currentRequest.current?.abort(), [])
  useEffect(() => {
    if (state._tag === "ready" || state._tag === "revoked") statusRegion.current?.focus()
  }, [state._tag])

  const create = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    currentRequest.current?.abort()
    const request = new AbortController()
    currentRequest.current = request
    setState({ _tag: "creating" })
    const existingIntent = createIntent.current
    const intent =
      existingIntent !== null &&
      existingIntent.entityId === entityId &&
      existingIntent.granteePersonId === granteePersonId &&
      existingIntent.lifetime === lifetime
        ? Promise.resolve(existingIntent)
        : transport.prepareCreate({ entityId, granteePersonId, lifetime }).then((nextIntent) => {
            createIntent.current = nextIntent
            return nextIntent
          })
    intent
      .then((currentIntent) => transport.create(currentIntent, request.signal))
      .then(
        (share) => {
          if (request.signal.aborted) return
          const currentIntent = createIntent.current
          if (
            currentIntent === null ||
            share.shareId !== currentIntent.shareId ||
            share.entityId !== currentIntent.entityId ||
            share.granteePersonId !== currentIntent.granteePersonId
          ) {
            setState({ _tag: "failed" })
            return
          }
          setState({
            _tag: "ready",
            shareId: share.shareId,
            expiresAt: DateTime.formatIso(share.expiresAt)
          })
        },
        () => {
          if (!request.signal.aborted) setState({ _tag: "failed" })
        }
      )
  }

  const revoke = (shareId: ShareId, expiresAt: string): void => {
    currentRequest.current?.abort()
    const request = new AbortController()
    currentRequest.current = request
    setState({ _tag: "revoking", shareId, expiresAt })
    transport.revoke(workspaceId, shareId, request.signal).then(
      () => {
        if (!request.signal.aborted) setState({ _tag: "revoked" })
      },
      () => {
        if (!request.signal.aborted) setState({ _tag: "ready", shareId, expiresAt })
      }
    )
  }

  const selectGrantee = (value: string): void => {
    createIntent.current = null
    setGranteePersonId(PersonId.make(value))
  }
  const selectLifetime = (value: string): void => {
    createIntent.current = null
    setLifetime(shareLifetime(value))
  }
  const createAnother = (): void => {
    createIntent.current = null
    setState({ _tag: "idle" })
  }

  if (state._tag === "ready" || state._tag === "revoking") {
    const sharePath = `/shares/${workspaceId}/${state.shareId}`
    return (
      <section
        aria-label="Authorized share"
        aria-live="polite"
        className={styles.shareResult}
        ref={statusRegion}
        role="status"
        tabIndex={-1}
      >
        <div>
          <Text as="h3" variant="body-large">
            Authorized link ready
          </Text>
          <Text tone="secondary">Only the selected person can open this exact item. Expires {state.expiresAt}.</Text>
        </div>
        <Link to={sharePath}>{sharePath}</Link>
        <Button disabled={state._tag === "revoking"} onClick={() => revoke(state.shareId, state.expiresAt)}>
          {state._tag === "revoking" ? "Revoking…" : "Revoke link"}
        </Button>
      </section>
    )
  }

  if (state._tag === "revoked") {
    return (
      <section
        aria-label="Authorized share"
        aria-live="polite"
        className={styles.shareResult}
        ref={statusRegion}
        role="status"
        tabIndex={-1}
      >
        <StateLabel label="Revoked" size="compact" tone="neutral" />
        <Text tone="secondary">This link no longer resolves.</Text>
        <Button onClick={createAnother}>Create another</Button>
      </section>
    )
  }

  return (
    <form className={styles.shareForm} onSubmit={create}>
      <div>
        <Text as="h3" variant="body-large">
          Share this exact item
        </Text>
        <Text tone="secondary">Authenticated access only. Related releases and relationships stay private.</Text>
      </div>
      <label>
        <span>Person</span>
        <select
          disabled={state._tag === "creating"}
          onChange={(event) => selectGrantee(event.currentTarget.value)}
          value={granteePersonId}
        >
          {options.map((option) => (
            <option key={option.personId} value={option.personId}>
              {option.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Expires</span>
        <select
          disabled={state._tag === "creating"}
          onChange={(event) => selectLifetime(event.currentTarget.value)}
          value={lifetime}
        >
          <option value="hour">In 1 hour</option>
          <option value="day">In 1 day</option>
          <option value="week">In 7 days</option>
        </select>
      </label>
      <Button disabled={state._tag === "creating"} type="submit">
        {state._tag === "creating" ? "Creating…" : "Create authorized link"}
      </Button>
      {state._tag === "failed" ? (
        <Text role="alert" tone="secondary">
          Could not create the link. Check the person and try again.
        </Text>
      ) : null}
    </form>
  )
}

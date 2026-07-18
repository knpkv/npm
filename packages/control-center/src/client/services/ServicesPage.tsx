import { ServiceMark } from "@knpkv/rly/patterns"
import { Button, Field, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import * as Predicate from "effect/Predicate"
import { type FormEvent, type ReactElement, useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router"

import type {
  CreatePluginConnectionValue,
  PluginConnectionSummary,
  PluginConnectionTestResult,
  PluginOverviewResponse,
  PluginServiceCatalogEntry
} from "../../api/plugins.js"
import type { PluginConnectionId } from "../../domain/identifiers.js"
import type { ProviderId } from "../../domain/sourceRevision.js"
import { browserReadableSessionKey, useBrowserSession } from "../BrowserSession.js"
import { browserConnectionTestTransport, type ConnectionTestTransport } from "./connectionTestTransport.js"
import styles from "./ServicesPage.module.css"

type ConnectionTestState =
  | { readonly _tag: "testing" }
  | { readonly _tag: "result"; readonly result: PluginConnectionTestResult }
  | { readonly _tag: "request-failed" }

type ConnectionsState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly overview: PluginOverviewResponse }

const statusFor = (
  connection: PluginConnectionSummary
): { readonly label: string; readonly tone: "neutral" | "positive" | "critical" | "caution" } => {
  if (connection.health === null) return { label: "Not checked", tone: "neutral" }
  switch (connection.health._tag) {
    case "healthy":
      return { label: "Healthy", tone: "positive" }
    case "degraded":
      return { label: "Degraded", tone: "caution" }
    case "unavailable":
      return { label: "Unavailable", tone: "critical" }
    case "disabled":
      return { label: "Disabled", tone: "neutral" }
  }
}

const checkedAt = (result: PluginConnectionTestResult): string => DateTime.formatIso(result.checkedAt)

const TestEvidence = ({ state }: { readonly state: ConnectionTestState | undefined }): ReactElement | null => {
  if (state === undefined || state._tag === "testing") return null
  if (state._tag === "request-failed") {
    return (
      <div aria-live="polite" className={styles.testEvidence} role="status">
        <StateLabel label="Test failed" tone="critical" />
        <Text tone="secondary" variant="body">
          Control Center could not complete the test. Check the server and try again.
        </Text>
      </div>
    )
  }
  const result = state.result
  return (
    <div aria-live="polite" className={styles.testEvidence} role="status">
      <StateLabel
        label={result._tag === "healthy" ? "Connection healthy" : "Test failed"}
        tone={result._tag === "healthy" ? "positive" : "critical"}
      />
      {result._tag === "healthy" ? (
        <div className={styles.identity}>
          <Text tone="secondary" variant="meta">
            {result.identity.label}
          </Text>
          <Text as="span" variant="card-title">
            {result.identity.displayName}
          </Text>
          <Text className={styles.identifier} tone="secondary" variant="body">
            {result.identity.providerImmutableId}
          </Text>
        </div>
      ) : (
        <Text tone="secondary" variant="body">
          {result.safeMessage}
        </Text>
      )}
      <Text tone="secondary" variant="meta">
        Checked <time dateTime={checkedAt(result)}>{checkedAt(result)}</time> · {result.latencyMilliseconds} ms
      </Text>
    </div>
  )
}

const ConnectionCard = ({
  canConfigure,
  canTest,
  connection,
  onConfigure,
  onTest,
  testState
}: {
  readonly canConfigure: boolean
  readonly canTest: boolean
  readonly connection: PluginConnectionSummary
  readonly onConfigure: () => void
  readonly onTest: (pluginConnectionId: PluginConnectionId) => void
  readonly testState: ConnectionTestState | undefined
}): ReactElement => {
  const status = statusFor(connection)
  const isTesting = testState?._tag === "testing"
  const hasTested = testState !== undefined && testState._tag !== "testing"
  return (
    <Surface as="article" className={styles.card} padding="default" shape="grouped">
      <div className={styles.cardHeading}>
        <div className={styles.connectionIdentity}>
          <ServiceMark service={connection.providerId} size="compact" />
          <Text as="h2" variant="card-title">
            {connection.displayName}
          </Text>
        </div>
        <StateLabel label={status.label} size="compact" tone={status.tone} />
      </div>
      <TestEvidence state={testState} />
      <div className={styles.cardAction}>
        <Button
          disabled={!canTest || isTesting || !connection.isEnabled}
          loading={isTesting}
          onClick={() => onTest(connection.pluginConnectionId)}
          variant="secondary"
        >
          {hasTested ? "Retry test" : "Test connection"}
        </Button>
        <Button disabled={!canConfigure} onClick={onConfigure} variant="secondary">
          Add connection
        </Button>
        {!canTest ? (
          <Text tone="secondary" variant="meta">
            Owner access is required.
          </Text>
        ) : null}
      </div>
    </Surface>
  )
}

const setupValue = (field: PluginServiceCatalogEntry["configurationFields"][number], value: string) => {
  switch (field.kind) {
    case "integer":
      return { _tag: "integer", key: field.key, value: Number(value) } satisfies CreatePluginConnectionValue
    case "secret":
      return { _tag: "secret", key: field.key, value } satisfies CreatePluginConnectionValue
    case "text":
    case "url":
      return { _tag: field.kind, key: field.key, value } satisfies CreatePluginConnectionValue
  }
}

const SetupForm = ({
  catalog,
  isSubmitting,
  onCancel,
  onSubmit
}: {
  readonly catalog: PluginServiceCatalogEntry
  readonly isSubmitting: boolean
  readonly onCancel: () => void
  readonly onSubmit: (displayName: string, values: ReadonlyArray<CreatePluginConnectionValue>) => Promise<boolean>
}): ReactElement => {
  const [displayName, setDisplayName] = useState(catalog.displayName)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [values, setValues] = useState<ReadonlyMap<string, string>>(
    new Map(catalog.configurationFields.map((field) => [field.key, field.defaultValue ?? ""]))
  )

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setSetupError(null)
    const requestValues = catalog.configurationFields.map((field) => setupValue(field, values.get(field.key) ?? ""))
    onSubmit(displayName, requestValues).then((didCreate) => {
      if (!didCreate) {
        setSetupError("Control Center could not create this connection. Check the fields and try again.")
        return
      }
      setValues((current) => {
        const cleared = new Map(current)
        for (const field of catalog.configurationFields) {
          if (field.kind === "secret") cleared.set(field.key, "")
        }
        return cleared
      })
    })
  }

  return (
    <form className={styles.setupForm} onSubmit={submit}>
      <Field label="Connection name" required size="compact">
        {(controlProps) => (
          <input
            {...controlProps}
            maxLength={200}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            value={displayName}
          />
        )}
      </Field>
      {catalog.configurationFields.map((field) => (
        <Field
          description={field.description}
          key={field.key}
          label={field.label}
          required={field.required}
          size="compact"
        >
          {(controlProps) => (
            <input
              {...controlProps}
              autoComplete={field.kind === "secret" ? "off" : undefined}
              disabled={field.isReadOnly}
              max={field.maximum ?? undefined}
              maxLength={field.kind === "integer" ? undefined : field.kind === "secret" ? 16_384 : 4_096}
              min={field.minimum ?? undefined}
              onChange={(event) => setValues((current) => new Map(current).set(field.key, event.currentTarget.value))}
              type={
                field.kind === "secret"
                  ? "password"
                  : field.kind === "integer"
                    ? "number"
                    : field.kind === "url"
                      ? "url"
                      : "text"
              }
              value={values.get(field.key) ?? ""}
            />
          )}
        </Field>
      ))}
      {setupError === null ? null : (
        <Text as="p" className={styles.setupError} role="alert" variant="body">
          {setupError}
        </Text>
      )}
      <div className={styles.setupActions}>
        <Button disabled={isSubmitting} onClick={onCancel} type="button" variant="secondary">
          Cancel
        </Button>
        <Button loading={isSubmitting} type="submit" variant="primary">
          Connect and test
        </Button>
      </div>
    </form>
  )
}

const CatalogCard = ({
  canConfigure,
  catalog,
  isOpen,
  isRecovery,
  isSubmitting,
  onCancel,
  onOpen,
  onSubmit
}: {
  readonly canConfigure: boolean
  readonly catalog: PluginServiceCatalogEntry
  readonly isOpen: boolean
  readonly isSubmitting: boolean
  readonly isRecovery: boolean
  readonly onCancel: () => void
  readonly onOpen: () => void
  readonly onSubmit: (displayName: string, values: ReadonlyArray<CreatePluginConnectionValue>) => Promise<boolean>
}): ReactElement => (
  <Surface as="article" className={styles.card} padding="default" shape="grouped">
    <div className={styles.cardHeading}>
      <div className={styles.connectionIdentity}>
        <ServiceMark service={catalog.providerId} size="compact" />
        <Text as="h2" variant="card-title">
          {catalog.displayName}
        </Text>
      </div>
      <StateLabel
        label={isRecovery ? "Needs correction" : "Not configured"}
        size="compact"
        tone={isRecovery ? "critical" : "neutral"}
      />
    </div>
    <Text tone="secondary" variant="body">
      {catalog.description}
    </Text>
    {isOpen ? (
      <SetupForm catalog={catalog} isSubmitting={isSubmitting} onCancel={onCancel} onSubmit={onSubmit} />
    ) : (
      <div className={styles.cardAction}>
        <Button disabled={!canConfigure} onClick={onOpen} variant="secondary">
          Configure
        </Button>
        {!canConfigure ? (
          <Text tone="secondary" variant="meta">
            Owner access is required.
          </Text>
        ) : null}
      </div>
    )}
  </Surface>
)

/** Manage fixed first-party providers and prove configured identities with owner-only live checks. */
export const ServicesPage = ({
  transport = browserConnectionTestTransport
}: {
  readonly transport?: ConnectionTestTransport
} = {}): ReactElement => {
  const { invalidateSession, state: sessionState } = useBrowserSession()
  const sessionKey = browserReadableSessionKey(sessionState)
  const [requestRevision, setRequestRevision] = useState(0)
  const [connectionsState, setConnectionsState] = useState<ConnectionsState>({ _tag: "idle" })
  const [testStates, setTestStates] = useState<ReadonlyMap<PluginConnectionId, ConnectionTestState>>(new Map())
  const [openProvider, setOpenProvider] = useState<ProviderId | null>(null)
  const [submittingProvider, setSubmittingProvider] = useState<ProviderId | null>(null)
  const testRequests = useRef(new Map<PluginConnectionId, AbortController>())
  const createRequest = useRef<AbortController | null>(null)

  useEffect(() => {
    if (sessionKey === null) {
      setConnectionsState({ _tag: "idle" })
      return
    }
    const request = new AbortController()
    setConnectionsState({ _tag: "loading" })
    transport.overview(request.signal).then(
      (overview) => {
        if (!request.signal.aborted) setConnectionsState({ _tag: "ready", overview })
      },
      (failure) => {
        if (request.signal.aborted) return
        if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
        setConnectionsState({ _tag: "failed" })
      }
    )
    return () => request.abort()
  }, [invalidateSession, requestRevision, sessionKey, transport])

  useEffect(() => {
    setTestStates(new Map())
    setOpenProvider(null)
    setSubmittingProvider(null)
    return () => {
      for (const request of testRequests.current.values()) request.abort()
      testRequests.current.clear()
      createRequest.current?.abort()
      createRequest.current = null
    }
  }, [sessionKey])

  const testConnection = useCallback(
    (pluginConnectionId: PluginConnectionId): void => {
      if (sessionKey === null) return
      testRequests.current.get(pluginConnectionId)?.abort()
      const request = new AbortController()
      testRequests.current.set(pluginConnectionId, request)
      setTestStates((current) => new Map(current).set(pluginConnectionId, { _tag: "testing" }))
      transport.test(pluginConnectionId, request.signal).then(
        (result) => {
          if (request.signal.aborted) return
          testRequests.current.delete(pluginConnectionId)
          setTestStates((current) => new Map(current).set(pluginConnectionId, { _tag: "result", result }))
        },
        (failure) => {
          if (request.signal.aborted) return
          testRequests.current.delete(pluginConnectionId)
          if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
          setTestStates((current) => new Map(current).set(pluginConnectionId, { _tag: "request-failed" }))
        }
      )
    },
    [invalidateSession, sessionKey, transport]
  )

  const createConnection = useCallback(
    (
      catalog: PluginServiceCatalogEntry,
      displayName: string,
      values: ReadonlyArray<CreatePluginConnectionValue>
    ): Promise<boolean> => {
      if (sessionKey === null) return Promise.resolve(false)
      createRequest.current?.abort()
      const request = new AbortController()
      createRequest.current = request
      setSubmittingProvider(catalog.providerId)
      return transport
        .makeConnectionId()
        .then((pluginConnectionId) =>
          transport.create({ pluginConnectionId, providerId: catalog.providerId, displayName, values }, request.signal)
        )
        .then(
          (response) => {
            if (request.signal.aborted) return false
            createRequest.current = null
            setConnectionsState((current) =>
              current._tag === "ready"
                ? {
                    _tag: "ready",
                    overview: {
                      ...current.overview,
                      connections: [...current.overview.connections, response.connection]
                    }
                  }
                : current
            )
            setTestStates((current) =>
              new Map(current).set(response.connection.pluginConnectionId, {
                _tag: "result",
                result: response.test
              })
            )
            setOpenProvider(response.test._tag === "healthy" ? null : catalog.providerId)
            setSubmittingProvider(null)
            return true
          },
          (failure) => {
            if (request.signal.aborted) return false
            createRequest.current = null
            if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
            setSubmittingProvider(null)
            return false
          }
        )
    },
    [invalidateSession, sessionKey, transport]
  )

  const session =
    sessionState._tag === "authenticated" || sessionState._tag === "storage-unavailable" ? sessionState.session : null
  const canConfigure = sessionState._tag === "authenticated" && sessionState.session.permission === "workspace-owner"

  return (
    <section aria-labelledby="services-title" className={styles.page}>
      <header className={styles.heading}>
        <Text as="h1" id="services-title" variant="page-title">
          Services
        </Text>
        <Text tone="secondary" variant="body-large">
          Configure first-party providers and verify the exact account each connection represents.
        </Text>
      </header>
      {session === null ? (
        <StatePanel
          action={
            <Link className={styles.textLink} to="/pair">
              Pair this browser
            </Link>
          }
          description="Connection details are available after this browser is paired."
          title="Connections stay private"
        />
      ) : connectionsState._tag === "loading" || connectionsState._tag === "idle" ? (
        <StatePanel description="Reading the services available to this workspace." title="Loading services" />
      ) : connectionsState._tag === "failed" ? (
        <StatePanel
          action={<Button onClick={() => setRequestRevision((revision) => revision + 1)}>Try again</Button>}
          description="Control Center could not load the service catalog."
          title="Services unavailable"
        />
      ) : (
        <div className={styles.grid}>
          {connectionsState.overview.catalog.flatMap((catalog) => {
            const configured = connectionsState.overview.connections.filter(
              (connection) => connection.providerId === catalog.providerId
            )
            const cards = configured.map((connection) => (
              <ConnectionCard
                canConfigure={canConfigure}
                canTest={canConfigure}
                connection={connection}
                key={connection.pluginConnectionId}
                onConfigure={() => setOpenProvider(catalog.providerId)}
                onTest={testConnection}
                testState={testStates.get(connection.pluginConnectionId)}
              />
            ))
            if (configured.length > 0 && openProvider !== catalog.providerId) return cards
            return [
              ...cards,
              <CatalogCard
                canConfigure={canConfigure}
                catalog={catalog}
                isOpen={openProvider === catalog.providerId}
                isRecovery={configured.length > 0}
                isSubmitting={submittingProvider === catalog.providerId}
                key={`${catalog.providerId}-catalog`}
                onCancel={() => setOpenProvider(null)}
                onOpen={() => setOpenProvider(catalog.providerId)}
                onSubmit={(displayName, values) => createConnection(catalog, displayName, values)}
              />
            ]
          })}
        </div>
      )}
    </section>
  )
}

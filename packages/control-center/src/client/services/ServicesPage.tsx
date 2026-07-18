import { ServiceMark } from "@knpkv/rly/patterns"
import { Button, Field, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import * as Predicate from "effect/Predicate"
import { type FormEvent, type ReactElement, useCallback, useEffect, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router"

import type {
  AwsProfileDiscoveryResponse,
  CreatePluginConnectionValue,
  PluginConnectionSummary,
  PluginConnectionTestResult,
  PluginOverviewResponse,
  PluginServiceCatalogEntry
} from "../../api/plugins.js"
import type { PluginConnectionId } from "../../domain/identifiers.js"
import { firstPartyServiceIdentities, type FirstPartyServiceIdentity } from "../../domain/firstPartyServices.js"
import type { ProviderId } from "../../domain/sourceRevision.js"
import { browserReadableSessionKey, useBrowserSession } from "../BrowserSession.js"
import { AwsAccountSetupForm } from "./AwsAccountSetupForm.js"
import { browserConnectionTestTransport, type ConnectionTestTransport } from "./connectionTestTransport.js"
import { type ServiceConnectionDraft, serviceSetupValue } from "./serviceSetupValues.js"
import { selectedServiceProvider, servicePairingPath } from "./serviceOnboarding.js"
import styles from "./ServicesPage.module.css"

type ConnectionTestState =
  | { readonly _tag: "testing" }
  | { readonly _tag: "result"; readonly result: PluginConnectionTestResult }
  | { readonly _tag: "request-failed" }

type ConnectionEnablementState = "changing" | "request-failed"

type AwsProfilesState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly profiles: AwsProfileDiscoveryResponse }

type ConnectionsState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly overview: PluginOverviewResponse }

const statusFor = (
  connection: PluginConnectionSummary,
  testState: ConnectionTestState | undefined
): { readonly label: string; readonly tone: "neutral" | "positive" | "critical" | "caution" | "progress" } => {
  if (!connection.isEnabled) return { label: "Disabled", tone: "neutral" }
  if (testState?._tag === "testing") return { label: "Checking", tone: "progress" }
  if (testState?._tag === "result") {
    return testState.result._tag === "healthy"
      ? { label: "Healthy", tone: "positive" }
      : { label: "Unavailable", tone: "critical" }
  }
  if (connection.health === null) return { label: "Not checked", tone: "neutral" }
  switch (connection.health._tag) {
    case "healthy":
      return { label: "Healthy", tone: "positive" }
    case "degraded":
      return { label: "Degraded", tone: "caution" }
    case "unavailable":
      return { label: "Unavailable", tone: "critical" }
    case "disabled":
      return { label: "Not checked", tone: "neutral" }
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
  enablementState,
  onConfigure,
  onSetEnabled,
  onTest,
  testState
}: {
  readonly canConfigure: boolean
  readonly canTest: boolean
  readonly connection: PluginConnectionSummary
  readonly enablementState: ConnectionEnablementState | undefined
  readonly onConfigure: () => void
  readonly onSetEnabled: (pluginConnectionId: PluginConnectionId, isEnabled: boolean) => void
  readonly onTest: (pluginConnectionId: PluginConnectionId) => void
  readonly testState: ConnectionTestState | undefined
}): ReactElement => {
  const isTesting = testState?._tag === "testing"
  const hasTested = testState !== undefined && testState._tag !== "testing"
  const isChanging = enablementState === "changing"
  const status = statusFor(connection, testState)
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
          disabled={!canTest || isChanging || isTesting || !connection.isEnabled}
          loading={isTesting}
          onClick={() => onTest(connection.pluginConnectionId)}
          variant="secondary"
        >
          {hasTested ? "Retry test" : "Test connection"}
        </Button>
        <Button disabled={!canConfigure} onClick={onConfigure} variant="secondary">
          Add connection
        </Button>
        <Button
          disabled={!canConfigure || isChanging}
          loading={isChanging}
          onClick={() => onSetEnabled(connection.pluginConnectionId, !connection.isEnabled)}
          variant={connection.isEnabled ? "secondary" : "primary"}
        >
          {connection.isEnabled ? "Disable" : "Enable service"}
        </Button>
        {!canTest ? (
          <Text tone="secondary" variant="meta">
            Owner access is required.
          </Text>
        ) : null}
      </div>
      {enablementState === "request-failed" ? (
        <Text as="p" className={styles.setupError} role="alert" variant="body">
          Control Center could not change this service. Refresh and try again.
        </Text>
      ) : null}
    </Surface>
  )
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
    const requestValues = catalog.configurationFields.map((field) =>
      serviceSetupValue(field, values.get(field.key) ?? "")
    )
    void onSubmit(displayName, requestValues).then((didCreate) => {
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

  const updateValue = (key: string, value: string): void => {
    setValues((current) => new Map(current).set(key, value))
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
              onChange={(event) => updateValue(field.key, event.currentTarget.value)}
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
          Enable and test
        </Button>
      </div>
    </form>
  )
}

const CatalogCard = ({
  awsProfiles,
  awsProfilesState,
  canConfigure,
  catalog,
  catalogs,
  isOpen,
  isRecovery,
  isSubmitting,
  onCancel,
  onOpen,
  onSubmit,
  onSubmitAws
}: {
  readonly awsProfiles: AwsProfileDiscoveryResponse
  readonly awsProfilesState: AwsProfilesState["_tag"]
  readonly canConfigure: boolean
  readonly catalog: PluginServiceCatalogEntry
  readonly catalogs: ReadonlyArray<PluginServiceCatalogEntry>
  readonly isOpen: boolean
  readonly isSubmitting: boolean
  readonly isRecovery: boolean
  readonly onCancel: () => void
  readonly onOpen: () => void
  readonly onSubmit: (displayName: string, values: ReadonlyArray<CreatePluginConnectionValue>) => Promise<boolean>
  readonly onSubmitAws: (drafts: ReadonlyArray<ServiceConnectionDraft>) => Promise<boolean>
}): ReactElement => {
  const isAws = catalog.providerId === "codecommit" || catalog.providerId === "codepipeline"
  return (
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
        isAws ? (
          <AwsAccountSetupForm
            awsProfiles={awsProfiles}
            awsProfilesState={awsProfilesState}
            catalogs={catalogs}
            isSubmitting={isSubmitting}
            onCancel={onCancel}
            onSubmit={onSubmitAws}
          />
        ) : (
          <SetupForm catalog={catalog} isSubmitting={isSubmitting} onCancel={onCancel} onSubmit={onSubmit} />
        )
      ) : (
        <div className={styles.cardAction}>
          <Button disabled={!canConfigure} onClick={onOpen} variant="secondary">
            {isAws ? "Configure AWS account" : "Enable service"}
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
}

const ServicePreviewCard = ({
  actionLabel = "Pair to enable",
  isActionDisabled = false,
  onEnable,
  service,
  statusLabel = "Available",
  statusTone = "positive"
}: {
  readonly actionLabel?: string
  readonly isActionDisabled?: boolean
  readonly onEnable: () => void
  readonly service: FirstPartyServiceIdentity
  readonly statusLabel?: string
  readonly statusTone?: "critical" | "neutral" | "positive" | "progress"
}): ReactElement => (
  <Surface as="article" className={styles.card} padding="default" shape="grouped">
    <div className={styles.cardHeading}>
      <div className={styles.connectionIdentity}>
        <ServiceMark service={service.providerId} size="compact" />
        <Text as="h2" variant="card-title">
          {service.displayName}
        </Text>
      </div>
      <StateLabel label={statusLabel} size="compact" tone={statusTone} />
    </div>
    <Text tone="secondary" variant="body">
      {service.description}
    </Text>
    <div className={styles.cardAction}>
      <Button disabled={isActionDisabled} onClick={onEnable} variant="primary">
        {actionLabel}
      </Button>
    </div>
  </Surface>
)

/** Manage fixed first-party providers and prove configured identities with owner-only live checks. */
export const ServicesPage = ({
  transport = browserConnectionTestTransport
}: {
  readonly transport?: ConnectionTestTransport
} = {}): ReactElement => {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { invalidateSession, state: sessionState } = useBrowserSession()
  const sessionKey = browserReadableSessionKey(sessionState)
  const [requestRevision, setRequestRevision] = useState(0)
  const [connectionsState, setConnectionsState] = useState<ConnectionsState>({ _tag: "idle" })
  const [awsProfilesState, setAwsProfilesState] = useState<AwsProfilesState>({ _tag: "idle" })
  const [testStates, setTestStates] = useState<ReadonlyMap<PluginConnectionId, ConnectionTestState>>(new Map())
  const [enablementStates, setEnablementStates] = useState<ReadonlyMap<PluginConnectionId, ConnectionEnablementState>>(
    new Map()
  )
  const [openProvider, setOpenProvider] = useState<ProviderId | null>(null)
  const [submittingProvider, setSubmittingProvider] = useState<ProviderId | null>(null)
  const testRequests = useRef(new Map<PluginConnectionId, AbortController>())
  const createRequest = useRef<AbortController | null>(null)
  const enablementRequests = useRef(new Map<PluginConnectionId, AbortController>())
  const awsProfileRequest = useRef<AbortController | null>(null)

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
    if (sessionKey === null || (openProvider !== "codecommit" && openProvider !== "codepipeline")) return
    awsProfileRequest.current?.abort()
    const request = new AbortController()
    awsProfileRequest.current = request
    setAwsProfilesState({ _tag: "loading" })
    const discoverAwsProfiles = transport.discoverAwsProfiles
    if (discoverAwsProfiles === undefined) {
      setAwsProfilesState({ _tag: "failed" })
      return () => request.abort()
    }
    discoverAwsProfiles(request.signal).then(
      (profiles) => {
        if (!request.signal.aborted) setAwsProfilesState({ _tag: "ready", profiles })
      },
      (failure) => {
        if (request.signal.aborted) return
        if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
        setAwsProfilesState({ _tag: "failed" })
      }
    )
    return () => request.abort()
  }, [invalidateSession, openProvider, sessionKey, transport])

  useEffect(() => {
    setTestStates(new Map())
    setEnablementStates(new Map())
    setOpenProvider(null)
    setSubmittingProvider(null)
    setAwsProfilesState({ _tag: "idle" })
    return () => {
      for (const request of testRequests.current.values()) request.abort()
      testRequests.current.clear()
      createRequest.current?.abort()
      createRequest.current = null
      awsProfileRequest.current?.abort()
      awsProfileRequest.current = null
      for (const request of enablementRequests.current.values()) request.abort()
      enablementRequests.current.clear()
    }
  }, [sessionKey])

  useEffect(() => {
    if (
      connectionsState._tag !== "ready" ||
      sessionState._tag !== "authenticated" ||
      sessionState.session.permission !== "workspace-owner"
    ) {
      return
    }
    const requestedProvider = selectedServiceProvider(searchParams, "enable")
    if (requestedProvider === null) return
    if (!connectionsState.overview.catalog.some(({ providerId }) => providerId === requestedProvider)) return
    setOpenProvider(requestedProvider)
    const nextSearchParams = new URLSearchParams(searchParams)
    nextSearchParams.delete("enable")
    setSearchParams(nextSearchParams, { replace: true })
  }, [connectionsState, searchParams, sessionState, setSearchParams])

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

  const createConnections = useCallback(
    async (drafts: ReadonlyArray<ServiceConnectionDraft>, originProvider: ProviderId): Promise<boolean> => {
      if (sessionKey === null) return false
      createRequest.current?.abort()
      const request = new AbortController()
      createRequest.current = request
      setSubmittingProvider(originProvider)
      let hasFailedTest = false
      try {
        for (const draft of drafts) {
          const pluginConnectionId = await transport.makeConnectionId()
          const response = await transport.create(
            {
              pluginConnectionId,
              providerId: draft.catalog.providerId,
              displayName: draft.displayName,
              values: draft.values
            },
            request.signal
          )
          if (request.signal.aborted) return false
          hasFailedTest = hasFailedTest || response.test._tag !== "healthy"
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
        }
        createRequest.current = null
        setOpenProvider(hasFailedTest ? originProvider : null)
        setSubmittingProvider(null)
        return true
      } catch (failure: unknown) {
        if (request.signal.aborted) return false
        createRequest.current = null
        if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
        setSubmittingProvider(null)
        return false
      }
    },
    [invalidateSession, sessionKey, transport]
  )

  const createConnection = useCallback(
    (
      catalog: PluginServiceCatalogEntry,
      displayName: string,
      values: ReadonlyArray<CreatePluginConnectionValue>
    ): Promise<boolean> => createConnections([{ catalog, displayName, values }], catalog.providerId),
    [createConnections]
  )

  const setConnectionEnabled = useCallback(
    (pluginConnectionId: PluginConnectionId, isEnabled: boolean): void => {
      if (sessionKey === null) return
      if (!isEnabled) {
        testRequests.current.get(pluginConnectionId)?.abort()
        testRequests.current.delete(pluginConnectionId)
        setTestStates((current) => {
          const next = new Map(current)
          next.delete(pluginConnectionId)
          return next
        })
      }
      enablementRequests.current.get(pluginConnectionId)?.abort()
      const request = new AbortController()
      enablementRequests.current.set(pluginConnectionId, request)
      setEnablementStates((current) => new Map(current).set(pluginConnectionId, "changing"))
      transport.setEnabled(pluginConnectionId, isEnabled, request.signal).then(
        (connection) => {
          if (request.signal.aborted) return
          enablementRequests.current.delete(pluginConnectionId)
          setConnectionsState((current) =>
            current._tag === "ready"
              ? {
                  _tag: "ready",
                  overview: {
                    ...current.overview,
                    connections: current.overview.connections.map((candidate) =>
                      candidate.pluginConnectionId === pluginConnectionId ? connection : candidate
                    )
                  }
                }
              : current
          )
          setEnablementStates((current) => {
            const next = new Map(current)
            next.delete(pluginConnectionId)
            return next
          })
          if (isEnabled) {
            testConnection(pluginConnectionId)
          } else {
            setTestStates((current) => {
              const next = new Map(current)
              next.delete(pluginConnectionId)
              return next
            })
          }
        },
        (failure) => {
          if (request.signal.aborted) return
          enablementRequests.current.delete(pluginConnectionId)
          if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
          setEnablementStates((current) => new Map(current).set(pluginConnectionId, "request-failed"))
        }
      )
    },
    [invalidateSession, sessionKey, testConnection, transport]
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
          {session === null || (connectionsState._tag === "ready" && connectionsState.overview.connections.length === 0)
            ? "Choose a service below. Control Center will enable it and verify the exact account before using it."
            : "Configure first-party providers and verify the exact account each connection represents."}
        </Text>
      </header>
      {session === null && sessionState._tag !== "checking" ? (
        <div className={styles.grid}>
          {firstPartyServiceIdentities.map((service) => (
            <ServicePreviewCard
              key={service.providerId}
              onEnable={() => navigate(servicePairingPath(service.providerId))}
              service={service}
            />
          ))}
        </div>
      ) : connectionsState._tag === "loading" || connectionsState._tag === "idle" ? (
        <div className={styles.grid}>
          {firstPartyServiceIdentities.map((service) => (
            <ServicePreviewCard
              actionLabel="Loading connections"
              isActionDisabled
              key={service.providerId}
              onEnable={() => undefined}
              service={service}
              statusLabel="Loading"
              statusTone="progress"
            />
          ))}
        </div>
      ) : connectionsState._tag === "failed" ? (
        <>
          <StatePanel
            action={<Button onClick={() => setRequestRevision((revision) => revision + 1)}>Try again</Button>}
            description="Control Center could not load connection details. The installed services remain visible below."
            title="Connections unavailable"
          />
          <div className={styles.grid}>
            {firstPartyServiceIdentities.map((service) => (
              <ServicePreviewCard
                actionLabel="Retry connections"
                key={service.providerId}
                onEnable={() => setRequestRevision((revision) => revision + 1)}
                service={service}
                statusLabel="Installed"
                statusTone="neutral"
              />
            ))}
          </div>
        </>
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
                enablementState={enablementStates.get(connection.pluginConnectionId)}
                key={connection.pluginConnectionId}
                onConfigure={() => setOpenProvider(catalog.providerId)}
                onSetEnabled={setConnectionEnabled}
                onTest={testConnection}
                testState={testStates.get(connection.pluginConnectionId)}
              />
            ))
            if (configured.length > 0 && openProvider !== catalog.providerId) return cards
            return [
              ...cards,
              <CatalogCard
                awsProfiles={awsProfilesState._tag === "ready" ? awsProfilesState.profiles : []}
                awsProfilesState={awsProfilesState._tag}
                canConfigure={canConfigure}
                catalog={catalog}
                catalogs={connectionsState.overview.catalog}
                isOpen={openProvider === catalog.providerId}
                isRecovery={configured.length > 0}
                isSubmitting={submittingProvider === catalog.providerId}
                key={`${catalog.providerId}-catalog`}
                onCancel={() => setOpenProvider(null)}
                onOpen={() => setOpenProvider(catalog.providerId)}
                onSubmit={(displayName, values) => createConnection(catalog, displayName, values)}
                onSubmitAws={(drafts) => createConnections(drafts, catalog.providerId)}
              />
            ]
          })}
        </div>
      )}
    </section>
  )
}

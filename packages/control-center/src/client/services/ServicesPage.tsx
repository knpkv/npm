import { ServiceMark } from "@knpkv/rly/patterns"
import { Button, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import * as Predicate from "effect/Predicate"
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router"

import type { PluginConnectionSummary, PluginConnectionTestResult } from "../../api/plugins.js"
import type { PluginConnectionId } from "../../domain/identifiers.js"
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
  | { readonly _tag: "ready"; readonly connections: ReadonlyArray<PluginConnectionSummary> }

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
  canTest,
  connection,
  onTest,
  testState
}: {
  readonly canTest: boolean
  readonly connection: PluginConnectionSummary
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
        {!canTest ? (
          <Text tone="secondary" variant="meta">
            Owner access is required.
          </Text>
        ) : null}
      </div>
    </Surface>
  )
}

/** Manage connected providers and prove their current identity with a live, owner-only check. */
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
  const testRequests = useRef(new Map<PluginConnectionId, AbortController>())

  useEffect(() => {
    if (sessionKey === null) {
      setConnectionsState({ _tag: "idle" })
      return
    }
    const request = new AbortController()
    setConnectionsState({ _tag: "loading" })
    transport.list(request.signal).then(
      (connections) => {
        if (!request.signal.aborted) setConnectionsState({ _tag: "ready", connections })
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
    return () => {
      for (const request of testRequests.current.values()) request.abort()
      testRequests.current.clear()
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

  const session =
    sessionState._tag === "authenticated" || sessionState._tag === "storage-unavailable" ? sessionState.session : null
  const canTest = sessionState._tag === "authenticated" && sessionState.session.permission === "workspace-owner"

  return (
    <section aria-labelledby="services-title" className={styles.page}>
      <header className={styles.heading}>
        <Text as="h1" id="services-title" variant="page-title">
          Services
        </Text>
        <Text tone="secondary" variant="body-large">
          Verify provider access and the exact account each connection represents.
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
        <StatePanel description="Reading the connections available to this workspace." title="Loading services" />
      ) : connectionsState._tag === "failed" ? (
        <StatePanel
          action={<Button onClick={() => setRequestRevision((revision) => revision + 1)}>Try again</Button>}
          description="Control Center could not load the connection list."
          title="Services unavailable"
        />
      ) : connectionsState.connections.length === 0 ? (
        <StatePanel
          description="Add a provider connection to verify its credentials and account identity here."
          title="No services connected"
        />
      ) : (
        <div className={styles.grid}>
          {connectionsState.connections.map((connection) => (
            <ConnectionCard
              canTest={canTest}
              connection={connection}
              key={connection.pluginConnectionId}
              onTest={testConnection}
              testState={testStates.get(connection.pluginConnectionId)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

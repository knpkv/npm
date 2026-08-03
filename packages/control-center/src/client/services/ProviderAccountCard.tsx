import { ServiceMark } from "@knpkv/rly/patterns"
import { Button, Field, StateLabel, Surface, Text } from "@knpkv/rly/primitives"
import { type FormEvent, type ReactElement, useEffect, useRef, useState } from "react"

import type {
  AtlassianOAuthProviderIntent,
  PluginConnectionSummary,
  PluginCredentialReplacement,
  ProviderAccountSummary
} from "../../api/plugins.js"
import type { PluginConnectionId } from "../../domain/identifiers.js"
import type { ProviderId } from "../../domain/sourceRevision.js"
import { ConnectionTestEvidence } from "./ConnectionTestEvidence.js"
import { ConnectionAdministration, type ConnectionAdministrationViewState } from "./ConnectionAdministration.js"
import { ConnectionSynchronization, type ConnectionSynchronizationViewState } from "./ConnectionSynchronization.js"
import type { ConnectionTestTransport } from "./connectionTestTransport.js"
import { type ConnectionEnablementState, type ConnectionTestState, connectionStatus } from "./connectionState.js"
import styles from "./ServicesPage.module.css"

const resourceKind = (providerId: ProviderId): string => {
  switch (providerId) {
    case "codecommit":
      return "Repository"
    case "codepipeline":
      return "Pipeline"
    case "jira":
      return "Project"
    case "confluence":
      return "Space"
    case "clockify":
      return "Workspace"
  }
}

const atlassianProvidersForAccount = (account: ProviderAccountSummary): AtlassianOAuthProviderIntent => {
  const providers: Array<"jira" | "confluence"> = []
  if (account.resources.some(({ providerId }) => providerId === "jira")) providers.push("jira")
  if (account.resources.some(({ providerId }) => providerId === "confluence")) providers.push("confluence")
  return providers
}

const resourceSummaryContent = (
  resource: ProviderAccountSummary["resources"][number],
  status: ReturnType<typeof connectionStatus>,
  hasControls: boolean
): ReactElement => (
  <>
    <div className={styles.connectionIdentity}>
      <ServiceMark service={resource.providerId} size="compact" />
      <div className={styles.identity}>
        <Text as="h3" variant="card-title">
          {resource.displayName}
        </Text>
        <Text className={styles.identifier} tone="secondary" variant="meta">
          {resourceKind(resource.providerId)} · {resource.providerImmutableId}
        </Text>
      </div>
    </div>
    <div className={styles.resourceStatus}>
      <StateLabel label={status.label} size="compact" tone={status.tone} />
      {hasControls ? (
        <span className={styles.disclosure}>
          Controls <span aria-hidden="true">›</span>
        </span>
      ) : null}
    </div>
  </>
)

const ConnectedProviderResource = ({
  administrationState,
  atlassianOAuthProviders,
  canConfigure,
  connection,
  enablementState,
  onReauthorize,
  onRefreshSynchronization,
  onRevoke,
  onSetEnabled,
  onStartAtlassianOAuth,
  onSynchronize,
  onTest,
  resource,
  synchronizationState,
  testState
}: {
  readonly atlassianOAuthProviders: AtlassianOAuthProviderIntent
  readonly canConfigure: boolean
  readonly connection: PluginConnectionSummary
  readonly enablementState: ConnectionEnablementState | undefined
  readonly onRefreshSynchronization: (pluginConnectionId: PluginConnectionId) => void
  readonly onReauthorize: (
    pluginConnectionId: PluginConnectionId,
    credentials: ReadonlyArray<PluginCredentialReplacement>
  ) => Promise<boolean>
  readonly onRevoke: (pluginConnectionId: PluginConnectionId) => Promise<boolean>
  readonly onStartAtlassianOAuth: ConnectionTestTransport["startAtlassianOAuthGrant"]
  readonly onSetEnabled: (pluginConnectionId: PluginConnectionId, isEnabled: boolean) => void
  readonly onSynchronize: (pluginConnectionId: PluginConnectionId) => void
  readonly onTest: (pluginConnectionId: PluginConnectionId) => void
  readonly resource: ProviderAccountSummary["resources"][number]
  readonly synchronizationState: ConnectionSynchronizationViewState | undefined
  readonly testState: ConnectionTestState | undefined
  readonly administrationState: ConnectionAdministrationViewState | undefined
}): ReactElement => {
  const status = connectionStatus(connection, testState)
  const isTesting = testState?._tag === "testing"
  const isChanging = enablementState === "changing"
  const needsAttention = status.tone === "caution" || status.tone === "critical" || status.tone === "progress"
  const disclosure = useRef<HTMLDetailsElement>(null)
  const previouslyNeededAttention = useRef(false)

  useEffect(() => {
    if (needsAttention && !previouslyNeededAttention.current && disclosure.current !== null) {
      disclosure.current.open = true
    }
    previouslyNeededAttention.current = needsAttention
  }, [needsAttention])

  return (
    <details className={styles.resource} data-status-tone={status.tone} ref={disclosure}>
      <summary className={styles.resourceSummary}>{resourceSummaryContent(resource, status, true)}</summary>
      <div className={styles.resourceBody}>
        <ConnectionTestEvidence state={testState} />
        <ConnectionSynchronization
          canSynchronize={canConfigure && connection.isEnabled}
          onRefresh={() => onRefreshSynchronization(connection.pluginConnectionId)}
          onSynchronize={() => onSynchronize(connection.pluginConnectionId)}
          state={synchronizationState}
        />
        <ConnectionAdministration
          atlassianOAuthProviders={atlassianOAuthProviders}
          canConfigure={canConfigure}
          onReauthorize={(credentials) => onReauthorize(connection.pluginConnectionId, credentials)}
          onRevoke={() => onRevoke(connection.pluginConnectionId)}
          onStartAtlassianOAuth={onStartAtlassianOAuth}
          state={administrationState}
        />
        <div className={styles.resourceActions}>
          <Button
            disabled={!canConfigure || isChanging || isTesting || !connection.isEnabled}
            loading={isTesting}
            onClick={() => onTest(connection.pluginConnectionId)}
            variant="secondary"
          >
            Test
          </Button>
          <Button
            disabled={!canConfigure || isChanging}
            loading={isChanging}
            onClick={() => onSetEnabled(connection.pluginConnectionId, !connection.isEnabled)}
            variant="quiet"
          >
            {connection.isEnabled ? "Disable" : "Enable"}
          </Button>
        </div>
        {enablementState === "request-failed" ? (
          <Text as="p" className={styles.setupError} role="alert" variant="body">
            Control Center could not change this service. Refresh and try again.
          </Text>
        ) : null}
      </div>
    </details>
  )
}

/** Compact account-level view of independently actionable provider resources. */
export const ProviderAccountCard = ({
  account,
  administrationStates,
  canConfigure,
  connections,
  enablementStates,
  onAdd,
  onReauthorize,
  onRefreshSynchronization,
  onRename,
  onRevoke,
  onSetEnabled,
  onStartAtlassianOAuth,
  onSynchronize,
  onTest,
  synchronizationStates,
  testStates
}: {
  readonly account: ProviderAccountSummary
  readonly canConfigure: boolean
  readonly connections: ReadonlyArray<PluginConnectionSummary>
  readonly administrationStates: ReadonlyMap<PluginConnectionId, ConnectionAdministrationViewState>
  readonly enablementStates: ReadonlyMap<PluginConnectionId, ConnectionEnablementState>
  readonly onAdd: (providerId: ProviderId, providerImmutableId: string) => void
  readonly onSetEnabled: (pluginConnectionId: PluginConnectionId, isEnabled: boolean) => void
  readonly onRefreshSynchronization: (pluginConnectionId: PluginConnectionId) => void
  readonly onReauthorize: (
    pluginConnectionId: PluginConnectionId,
    credentials: ReadonlyArray<PluginCredentialReplacement>
  ) => Promise<boolean>
  readonly onRename: (displayName: string) => Promise<boolean>
  readonly onRevoke: (pluginConnectionId: PluginConnectionId) => Promise<boolean>
  readonly onStartAtlassianOAuth: ConnectionTestTransport["startAtlassianOAuthGrant"]
  readonly onSynchronize: (pluginConnectionId: PluginConnectionId) => void
  readonly synchronizationStates: ReadonlyMap<PluginConnectionId, ConnectionSynchronizationViewState>
  readonly onTest: (pluginConnectionId: PluginConnectionId) => void
  readonly testStates: ReadonlyMap<PluginConnectionId, ConnectionTestState>
}): ReactElement => {
  const [isEditing, setIsEditing] = useState(false)
  const [displayName, setDisplayName] = useState(account.displayName)
  const [renameState, setRenameState] = useState<"idle" | "saving" | "failed">("idle")

  useEffect(() => setDisplayName(account.displayName), [account.displayName])

  const rename = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setRenameState("saving")
    void onRename(displayName.trim()).then((succeeded) => {
      setRenameState(succeeded ? "idle" : "failed")
      if (succeeded) setIsEditing(false)
    })
  }

  return (
    <Surface as="article" className={styles.accountCard} padding="default" shape="grouped">
      <div className={styles.accountHeading}>
        <div className={styles.accountIdentity}>
          <Text as="h2" variant="section-title">
            {account.providerFamily === "aws"
              ? "AWS account"
              : account.providerFamily === "atlassian"
                ? "Atlassian site"
                : "Provider account"}{" "}
            {account.displayName}
          </Text>
          <Text className={styles.identifier} tone="secondary" variant="meta">
            Verified identity · {account.providerImmutableId}
          </Text>
        </div>
        <StateLabel
          label={`${account.resources.length} ${account.resources.length === 1 ? "resource" : "resources"}`}
          size="compact"
          tone="positive"
        />
      </div>
      {canConfigure ? (
        isEditing ? (
          <form className={styles.accountEdit} onSubmit={rename}>
            <Field label="Account display name" required size="compact">
              {(controlProps) => (
                <input
                  {...controlProps}
                  maxLength={200}
                  onChange={(event) => setDisplayName(event.currentTarget.value)}
                  value={displayName}
                />
              )}
            </Field>
            <div className={styles.resourceActions}>
              <Button loading={renameState === "saving"} type="submit" variant="secondary">
                Save account name
              </Button>
              <Button
                disabled={renameState === "saving"}
                onClick={() => {
                  setDisplayName(account.displayName)
                  setIsEditing(false)
                  setRenameState("idle")
                }}
                type="button"
                variant="quiet"
              >
                Cancel
              </Button>
            </div>
            {renameState === "failed" ? (
              <Text className={styles.setupError} role="alert" variant="body">
                The account changed elsewhere. Refresh and try again.
              </Text>
            ) : null}
          </form>
        ) : (
          <div className={styles.accountEditAction}>
            <Button onClick={() => setIsEditing(true)} variant="quiet">
              Edit account name
            </Button>
          </div>
        )
      ) : null}
      <div className={styles.resourceList}>
        {account.resources.map((resource) => {
          const connection = connections.find(
            (candidate) => candidate.followedResourceId === resource.followedResourceId
          )
          const testState = connection === undefined ? undefined : testStates.get(connection.pluginConnectionId)
          const enablementState =
            connection === undefined ? undefined : enablementStates.get(connection.pluginConnectionId)
          const status: ReturnType<typeof connectionStatus> =
            connection === undefined ? { label: "Followed", tone: "neutral" } : connectionStatus(connection, testState)
          if (connection === undefined) {
            return (
              <div className={styles.resource} data-status-tone={status.tone} key={resource.followedResourceId}>
                <div className={styles.resourceSummary}>{resourceSummaryContent(resource, status, false)}</div>
              </div>
            )
          }
          return (
            <ConnectedProviderResource
              atlassianOAuthProviders={atlassianProvidersForAccount(account)}
              canConfigure={canConfigure}
              connection={connection}
              administrationState={administrationStates.get(connection.pluginConnectionId)}
              enablementState={enablementState}
              key={resource.followedResourceId}
              onRefreshSynchronization={onRefreshSynchronization}
              onReauthorize={onReauthorize}
              onRevoke={onRevoke}
              onStartAtlassianOAuth={onStartAtlassianOAuth}
              onSetEnabled={onSetEnabled}
              onSynchronize={onSynchronize}
              onTest={onTest}
              resource={resource}
              synchronizationState={synchronizationStates.get(connection.pluginConnectionId)}
              testState={testState}
            />
          )
        })}
      </div>
      {account.providerFamily === "aws" ? (
        <div className={styles.accountActions}>
          <Button
            disabled={!canConfigure}
            onClick={() => onAdd("codecommit", account.providerImmutableId)}
            variant="secondary"
          >
            Add repository
          </Button>
          <Button
            disabled={!canConfigure}
            onClick={() => onAdd("codepipeline", account.providerImmutableId)}
            variant="secondary"
          >
            Add pipeline
          </Button>
        </div>
      ) : account.providerFamily === "atlassian" ? (
        <div className={styles.accountActions}>
          <Button
            disabled={!canConfigure}
            onClick={() => onAdd("jira", account.providerImmutableId)}
            variant="secondary"
          >
            Add Jira project
          </Button>
          <Button
            disabled={!canConfigure}
            onClick={() => onAdd("confluence", account.providerImmutableId)}
            variant="secondary"
          >
            Add Confluence space
          </Button>
        </div>
      ) : null}
    </Surface>
  )
}

import { ServiceMark } from "@knpkv/rly/patterns"
import { Button, StateLabel, Surface, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"

import type { PluginConnectionSummary, ProviderAccountSummary } from "../../api/plugins.js"
import type { PluginConnectionId } from "../../domain/identifiers.js"
import type { ProviderId } from "../../domain/sourceRevision.js"
import { ConnectionTestEvidence } from "./ConnectionTestEvidence.js"
import { type ConnectionEnablementState, type ConnectionTestState, connectionStatus } from "./connectionState.js"
import styles from "./ServicesPage.module.css"

const resourceKind = (providerId: ProviderId): string => {
  switch (providerId) {
    case "codecommit":
      return "Repository"
    case "codepipeline":
      return "Pipeline"
    case "jira":
      return "Jira site"
    case "confluence":
      return "Space"
    case "clockify":
      return "Workspace"
  }
}

/** Compact account-level view of independently actionable provider resources. */
export const ProviderAccountCard = ({
  account,
  canConfigure,
  connections,
  enablementStates,
  onAdd,
  onSetEnabled,
  onTest,
  testStates
}: {
  readonly account: ProviderAccountSummary
  readonly canConfigure: boolean
  readonly connections: ReadonlyArray<PluginConnectionSummary>
  readonly enablementStates: ReadonlyMap<PluginConnectionId, ConnectionEnablementState>
  readonly onAdd: (providerId: ProviderId) => void
  readonly onSetEnabled: (pluginConnectionId: PluginConnectionId, isEnabled: boolean) => void
  readonly onTest: (pluginConnectionId: PluginConnectionId) => void
  readonly testStates: ReadonlyMap<PluginConnectionId, ConnectionTestState>
}): ReactElement => (
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
    <div className={styles.resourceList}>
      {account.resources.map((resource) => {
        const connection = connections.find((candidate) => candidate.followedResourceId === resource.followedResourceId)
        const testState = connection === undefined ? undefined : testStates.get(connection.pluginConnectionId)
        const enablementState =
          connection === undefined ? undefined : enablementStates.get(connection.pluginConnectionId)
        const status: ReturnType<typeof connectionStatus> =
          connection === undefined ? { label: "Followed", tone: "neutral" } : connectionStatus(connection, testState)
        const isTesting = testState?._tag === "testing"
        const isChanging = enablementState === "changing"
        return (
          <div className={styles.resource} key={resource.followedResourceId}>
            <div className={styles.resourceHeading}>
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
              <StateLabel label={status.label} size="compact" tone={status.tone} />
            </div>
            {connection === undefined ? null : (
              <>
                <ConnectionTestEvidence state={testState} />
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
              </>
            )}
          </div>
        )
      })}
    </div>
    {account.providerFamily === "aws" ? (
      <div className={styles.accountActions}>
        <Button disabled={!canConfigure} onClick={() => onAdd("codecommit")} variant="secondary">
          Add repository
        </Button>
        <Button disabled={!canConfigure} onClick={() => onAdd("codepipeline")} variant="secondary">
          Add pipeline
        </Button>
      </div>
    ) : account.providerFamily === "atlassian" ? (
      <div className={styles.accountActions}>
        {account.resources.some(({ providerId }) => providerId === "jira") ? null : (
          <Button disabled={!canConfigure} onClick={() => onAdd("jira")} variant="secondary">
            Add Jira
          </Button>
        )}
        <Button disabled={!canConfigure} onClick={() => onAdd("confluence")} variant="secondary">
          Add Confluence space
        </Button>
      </div>
    ) : null}
  </Surface>
)

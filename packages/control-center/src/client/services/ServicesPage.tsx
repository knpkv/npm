import { ServiceMark } from "@knpkv/rly/patterns"
import { Button, Field, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { RateLimitedApiError } from "../../api/errors.js"
import { type FormEvent, type ReactElement, useCallback, useEffect, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router"

import type {
  AtlassianOAuthClientConfiguration,
  AtlassianOAuthGrantStartResponse,
  AtlassianOAuthProviderIntent,
  AtlassianProfileDiscoveryResponse,
  AwsProfileDiscoveryResponse,
  AwsRegionDiscoveryResponse,
  AwsResourceDiscoveryRequest,
  AwsResourceDiscoveryResponse,
  CreatePluginConnectionRequest,
  CreatePluginConnectionResponse,
  CreatePluginConnectionValue,
  PluginConnectionSummary,
  PluginCredentialReplacement,
  PluginOverviewResponse,
  PluginServiceCatalogEntry
} from "../../api/plugins.js"
import type { PluginConnectionId, ProviderAccountId } from "../../domain/identifiers.js"
import { firstPartyServiceIdentities, type FirstPartyServiceIdentity } from "../../domain/firstPartyServices.js"
import type { ProviderId } from "../../domain/sourceRevision.js"
import { browserReadableSessionKey, useBrowserSession } from "../BrowserSession.js"
import { AtlassianAccountSetupForm, type AtlassianSetupIntent } from "./AtlassianAccountSetupForm.js"
import { AwsAccountSetupForm } from "./AwsAccountSetupForm.js"
import { ConnectionTestEvidence } from "./ConnectionTestEvidence.js"
import { ConnectionAdministration, type ConnectionAdministrationViewState } from "./ConnectionAdministration.js"
import { ConnectionSynchronization, type ConnectionSynchronizationViewState } from "./ConnectionSynchronization.js"
import { browserConnectionTestTransport, type ConnectionTestTransport } from "./connectionTestTransport.js"
import { type ConnectionEnablementState, type ConnectionTestState, connectionStatus } from "./connectionState.js"
import { ProviderAccountCard } from "./ProviderAccountCard.js"
import { type ServiceConnectionDraft, serviceSetupValue } from "./serviceSetupValues.js"
import {
  selectedAtlassianOAuthProfileId,
  selectedAtlassianOAuthProviders,
  selectedAtlassianOAuthSiteId,
  selectedAtlassianRecoveryConnectionId,
  selectedAtlassianRecoveryProfileId,
  selectedServiceProvider,
  servicePairingPath
} from "./serviceOnboarding.js"
import { makeOverviewRefresh } from "./overviewRefresh.js"
import { makeConnectionDetailTracker } from "./connectionDetailReads.js"
import styles from "./ServicesPage.module.css"

type AwsProfilesState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly profiles: AwsProfileDiscoveryResponse }

type AtlassianProfilesState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly profiles: AtlassianProfileDiscoveryResponse }

type ConnectionsState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | {
      readonly _tag: "ready"
      readonly overview: PluginOverviewResponse
      readonly sessionKey: string
      readonly refresh: "idle" | "pending" | "failed"
    }

/** Create and live reads can complete in either order; keep one row per id and the newest server timestamp. */
const mergeConnections = (
  current: ReadonlyArray<PluginConnectionSummary>,
  incoming: ReadonlyArray<PluginConnectionSummary>
): ReadonlyArray<PluginConnectionSummary> => {
  const rows = new Map<PluginConnectionId, PluginConnectionSummary>()
  for (const connection of [...current, ...incoming]) {
    const existing = rows.get(connection.pluginConnectionId)
    if (
      existing === undefined ||
      DateTime.Order(existing.updatedAt, connection.updatedAt) < 0 ||
      (DateTime.Order(existing.updatedAt, connection.updatedAt) === 0 &&
        (existing.runtimeRevision ?? 0) <= (connection.runtimeRevision ?? 0))
    ) {
      rows.set(connection.pluginConnectionId, connection)
    }
  }
  return [...rows.values()]
}

/** Retain only this session's concurrent mutations when a live overview read completes. */
const receiveOverview = (
  current: ConnectionsState,
  incoming: PluginOverviewResponse,
  sessionKey: string
): ConnectionsState => ({
  _tag: "ready",
  sessionKey,
  refresh: "idle",
  overview: {
    ...incoming,
    connections: mergeConnections(
      current._tag === "ready" && current.sessionKey === sessionKey ? current.overview.connections : [],
      incoming.connections
    )
  }
})

/** A failed refresh preserves the last read, but cannot conceal that the current read failed. */
const overviewRefreshFailed = (current: ConnectionsState, sessionKey: string): ConnectionsState =>
  current._tag === "ready" && current.sessionKey === sessionKey ? { ...current, refresh: "failed" } : { _tag: "failed" }

const setupDraftKey = (draft: ServiceConnectionDraft): string => `${draft.catalog.providerId}\0${draft.displayName}`

const allAtlassianProducts: AtlassianOAuthProviderIntent = ["jira", "confluence"]

const allAtlassianProductsIntent: AtlassianSetupIntent = {
  preferredProfileId: null,
  preferredSiteId: null,
  providers: allAtlassianProducts,
  requestedOAuthProviders: allAtlassianProducts
}

const missingAtlassianProducts = (
  connections: ReadonlyArray<PluginConnectionSummary>
): AtlassianOAuthProviderIntent => {
  const providers = allAtlassianProducts.filter(
    (providerId) => !connections.some((connection) => connection.providerId === providerId)
  )
  return providers.length === 0 ? allAtlassianProducts : providers
}

const hasCanonicalProfileForConnectedProduct = (
  connections: ReadonlyArray<PluginConnectionSummary>,
  profiles: AtlassianProfileDiscoveryResponse,
  setupProviders: AtlassianOAuthProviderIntent
): boolean =>
  setupProviders.length === 1 &&
  allAtlassianProducts.some(
    (providerId) =>
      !setupProviders.includes(providerId) &&
      connections.some((connection) => connection.providerId === providerId) &&
      profiles.some((profile) => !profile.profileId.startsWith("legacy:") && profile.providers.includes(providerId))
  )

const hasConnectedProductOutsideSetup = (
  connections: ReadonlyArray<PluginConnectionSummary>,
  setupProviders: AtlassianOAuthProviderIntent
): boolean =>
  setupProviders.length === 1 &&
  allAtlassianProducts.some(
    (providerId) =>
      !setupProviders.includes(providerId) && connections.some((connection) => connection.providerId === providerId)
  )

const missingAtlassianProductsIntent = (
  connections: ReadonlyArray<PluginConnectionSummary>,
  requestedProvider?: "jira" | "confluence"
): AtlassianSetupIntent => {
  const providers =
    requestedProvider !== undefined && connections.some(({ providerId }) => providerId === requestedProvider)
      ? [requestedProvider]
      : missingAtlassianProducts(connections)
  return {
    preferredProfileId: null,
    preferredSiteId: null,
    providers,
    requestedOAuthProviders: null
  }
}

const resolvedAtlassianSetupIntent = (
  intent: AtlassianSetupIntent,
  connections: ReadonlyArray<PluginConnectionSummary>,
  profilesState: AtlassianProfilesState
): AtlassianSetupIntent => {
  if (intent.requestedOAuthProviders !== null) return intent
  const hasOutsideConnection = hasConnectedProductOutsideSetup(connections, intent.providers)
  if (hasOutsideConnection && (profilesState._tag === "idle" || profilesState._tag === "loading")) {
    return intent
  }
  const profiles = profilesState._tag === "ready" ? profilesState.profiles : []
  return {
    ...intent,
    requestedOAuthProviders:
      (hasOutsideConnection && profilesState._tag === "failed") ||
      hasCanonicalProfileForConnectedProduct(connections, profiles, intent.providers)
        ? allAtlassianProducts
        : intent.providers
  }
}

const ConnectionCard = ({
  administrationState,
  canConfigure,
  canTest,
  connection,
  enablementState,
  onConfigure,
  onReauthorize,
  onRefreshSynchronization,
  onRevoke,
  onSetEnabled,
  onStartAtlassianOAuth,
  onSynchronize,
  onTest,
  providerName,
  synchronizationState,
  testState
}: {
  readonly canConfigure: boolean
  readonly canTest: boolean
  readonly connection: PluginConnectionSummary
  /** The provider's catalog name; the mark prints it only when the connection's own name differs. */
  readonly providerName: string | undefined
  readonly administrationState: ConnectionAdministrationViewState | undefined
  readonly enablementState: ConnectionEnablementState | undefined
  readonly onConfigure: () => void
  readonly onSetEnabled: (pluginConnectionId: PluginConnectionId, isEnabled: boolean) => void
  readonly onRefreshSynchronization: (pluginConnectionId: PluginConnectionId) => void
  readonly onReauthorize: (
    pluginConnectionId: PluginConnectionId,
    credentials: ReadonlyArray<PluginCredentialReplacement>
  ) => Promise<boolean>
  readonly onRevoke: (pluginConnectionId: PluginConnectionId) => Promise<boolean>
  readonly onStartAtlassianOAuth: ConnectionTestTransport["startAtlassianOAuthGrant"]
  readonly onSynchronize: (pluginConnectionId: PluginConnectionId) => void
  readonly synchronizationState: ConnectionSynchronizationViewState | undefined
  readonly onTest: (pluginConnectionId: PluginConnectionId) => void
  readonly testState: ConnectionTestState | undefined
}): ReactElement => {
  const isTesting = testState?._tag === "testing"
  const hasTested = testState !== undefined && testState._tag !== "testing"
  const isChanging = enablementState === "changing"
  const status = connectionStatus(connection, testState, synchronizationState)
  return (
    <Surface as="article" className={styles.card} padding="default" form="grouped">
      <div className={styles.cardHeading}>
        <div className={styles.connectionIdentity}>
          <ServiceMark
            name={connection.displayName === providerName ? "hidden" : "visible"}
            service={connection.providerId}
            size="compact"
          />
          <Text as="h2" variant="card-title">
            {connection.displayName}
          </Text>
        </div>
        <StateLabel className={styles.status} label={status.label} size="compact" tone={status.tone} />
      </div>
      <ConnectionTestEvidence state={testState} />
      <ConnectionSynchronization
        canSynchronize={canConfigure && connection.isEnabled}
        onRefresh={() => onRefreshSynchronization(connection.pluginConnectionId)}
        onSynchronize={() => onSynchronize(connection.pluginConnectionId)}
        state={synchronizationState}
      />
      <ConnectionAdministration
        {...(connection.providerId === "jira"
          ? { atlassianOAuthProviders: ["jira"] }
          : connection.providerId === "confluence"
            ? { atlassianOAuthProviders: ["confluence"] }
            : {})}
        canConfigure={canConfigure}
        onReauthorize={(credentials) => onReauthorize(connection.pluginConnectionId, credentials)}
        onRevoke={() => onRevoke(connection.pluginConnectionId)}
        onStartAtlassianOAuth={onStartAtlassianOAuth}
        state={administrationState}
      />
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
      <Field label="Connection name" required>
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
        <Field description={field.description} key={field.key} label={field.label} required={field.required}>
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

/**
 * The open AWS form: one account across CodeCommit and CodePipeline, so it takes the setup panel's own header
 * and the whole card row. Opening it scrolls it into view and moves focus to its heading, so a phone user lands
 * on the form rather than the card that opened it.
 */
const AwsSetupPanel = ({
  isRecovery,
  ...props
}: Parameters<typeof AwsAccountSetupForm>[0] & { readonly isRecovery: boolean }): ReactElement => {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const element = heading.current
    if (element === null) return
    element.focus({ preventScroll: true })
    element.closest("article")?.scrollIntoView({ block: "start" })
  }, [])
  return (
    <Surface
      aria-labelledby="aws-setup-title"
      as="article"
      className={`${styles.card} ${styles.setupPanel}`}
      form="grouped"
      padding="default"
    >
      <header className={styles.setupHeader}>
        <div className={styles.setupTitleRow}>
          <div className={styles.setupTitle}>
            <ServiceMark service="codecommit" size="compact" />
            <ServiceMark service="codepipeline" size="compact" />
            <Text as="h2" id="aws-setup-title" ref={heading} tabIndex={-1} variant="card-title">
              Connect AWS account
            </Text>
          </div>
          {isRecovery ? <StateLabel label="Needs correction" tone="critical" /> : null}
        </div>
        <Text tone="secondary" variant="body">
          One account. Many delivery streams.
        </Text>
      </header>
      <AwsAccountSetupForm {...props} />
    </Surface>
  )
}

const CatalogCard = ({
  atlassianProfiles,
  atlassianProfilesState,
  atlassianSetupIntent,
  awsProfiles,
  awsProfilesState,
  canConfigure,
  catalog,
  catalogs,
  isAdditional,
  isOpen,
  isRecovery,
  isSubmitting,
  onCancel,
  onDiscoverAws,
  onDiscoverAwsRegions,
  onOpen,
  onReloadAwsProfiles,
  onStartAtlassianOAuth,
  onSubmit,
  onSubmitAtlassian,
  onSubmitAws
}: {
  readonly atlassianProfiles: AtlassianProfileDiscoveryResponse
  readonly atlassianProfilesState: AtlassianProfilesState["_tag"]
  readonly atlassianSetupIntent: AtlassianSetupIntent
  readonly awsProfiles: AwsProfileDiscoveryResponse
  readonly awsProfilesState: AwsProfilesState["_tag"]
  readonly canConfigure: boolean
  readonly catalog: PluginServiceCatalogEntry
  readonly catalogs: ReadonlyArray<PluginServiceCatalogEntry>
  readonly isAdditional: boolean
  readonly isOpen: boolean
  readonly isSubmitting: boolean
  readonly isRecovery: boolean
  readonly onCancel: () => void
  readonly onDiscoverAws: (
    request: AwsResourceDiscoveryRequest,
    signal: AbortSignal
  ) => Promise<AwsResourceDiscoveryResponse>
  readonly onDiscoverAwsRegions: (profile: string, signal: AbortSignal) => Promise<AwsRegionDiscoveryResponse>
  readonly onOpen: () => void
  readonly onReloadAwsProfiles: (signal: AbortSignal) => Promise<AwsProfileDiscoveryResponse>
  readonly onStartAtlassianOAuth: (
    providers: AtlassianOAuthProviderIntent,
    signal: AbortSignal,
    configuration?: AtlassianOAuthClientConfiguration
  ) => Promise<AtlassianOAuthGrantStartResponse>
  readonly onSubmit: (displayName: string, values: ReadonlyArray<CreatePluginConnectionValue>) => Promise<boolean>
  readonly onSubmitAtlassian: (drafts: ReadonlyArray<ServiceConnectionDraft>) => Promise<boolean>
  readonly onSubmitAws: (drafts: ReadonlyArray<ServiceConnectionDraft>) => Promise<boolean>
}): ReactElement => {
  const isAws = catalog.providerId === "codecommit" || catalog.providerId === "codepipeline"
  const isAtlassian = catalog.providerId === "jira" || catalog.providerId === "confluence"
  if (isOpen && isAws) {
    return (
      <AwsSetupPanel
        isRecovery={isRecovery}
        awsProfiles={awsProfiles}
        awsProfilesState={awsProfilesState}
        catalogs={catalogs}
        isSubmitting={isSubmitting}
        onCancel={onCancel}
        onDiscover={onDiscoverAws}
        onDiscoverRegions={onDiscoverAwsRegions}
        onReloadAwsProfiles={onReloadAwsProfiles}
        onSubmit={onSubmitAws}
      />
    )
  }
  return (
    <Surface as="article" className={styles.card} padding="default" form="grouped">
      <div className={styles.cardHeading}>
        <div className={styles.connectionIdentity}>
          <ServiceMark name="hidden" service={catalog.providerId} size="compact" />
          <Text as="h2" variant="card-title">
            {catalog.displayName}
          </Text>
        </div>
        <StateLabel
          className={styles.status}
          label={isRecovery ? "Needs correction" : isAdditional ? "Add another" : "Not configured"}
          size="compact"
          tone={isRecovery ? "critical" : "neutral"}
        />
      </div>
      <Text tone="secondary" variant="body">
        {catalog.description}
      </Text>
      {isOpen ? (
        isAtlassian ? (
          <AtlassianAccountSetupForm
            catalogs={catalogs}
            isSubmitting={isSubmitting}
            onCancel={onCancel}
            onStartOAuth={onStartAtlassianOAuth}
            onSubmit={onSubmitAtlassian}
            profiles={atlassianProfiles}
            profilesState={atlassianProfilesState}
            setupIntent={atlassianSetupIntent}
          />
        ) : (
          <SetupForm catalog={catalog} isSubmitting={isSubmitting} onCancel={onCancel} onSubmit={onSubmit} />
        )
      ) : (
        <div className={styles.cardAction}>
          <Button disabled={!canConfigure} onClick={onOpen} variant="secondary">
            {isAws
              ? "Configure AWS account"
              : isAdditional && catalog.providerId === "jira"
                ? "Add Jira project"
                : isAdditional && catalog.providerId === "confluence"
                  ? "Add Confluence space"
                  : isAtlassian
                    ? "Configure Atlassian"
                    : "Enable service"}
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

/**
 * One installed service before its connections load. `onEnable` adds the card's own action; while
 * connections are loading or failed everywhere, the page shows one action, so cards carry none.
 */
const ServicePreviewCard = ({
  actionLabel = "Pair to enable",
  onEnable,
  service,
  statusLabel = "Available",
  statusTone = "positive"
}: {
  readonly actionLabel?: string
  readonly onEnable?: () => void
  readonly service: FirstPartyServiceIdentity
  readonly statusLabel?: string
  readonly statusTone?: "critical" | "neutral" | "positive" | "progress"
}): ReactElement => (
  <Surface as="article" className={`${styles.card} ${styles.previewCard}`} padding="default" form="grouped">
    <div className={styles.cardHeading}>
      <div className={styles.connectionIdentity}>
        <ServiceMark name="hidden" service={service.providerId} size="compact" />
        <Text as="h2" variant="card-title">
          {service.displayName}
        </Text>
      </div>
      <StateLabel className={styles.status} label={statusLabel} size="compact" tone={statusTone} />
    </div>
    <Text tone="secondary" variant="body">
      {service.description}
    </Text>
    {onEnable === undefined ? null : (
      <div className={styles.cardAction}>
        <Button onClick={onEnable} variant="primary">
          {actionLabel}
        </Button>
      </div>
    )}
  </Surface>
)

/** Manage fixed first-party providers and prove configured identities with owner-only live checks. */
/** One empty list for "not detected yet", so the setup form doesn't see a new list on every render. */
const NO_AWS_PROFILES: AwsProfileDiscoveryResponse = []

export const ServicesPage = ({
  transport = browserConnectionTestTransport
}: {
  readonly transport?: ConnectionTestTransport
} = {}): ReactElement => {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { invalidateSession, state: sessionState } = useBrowserSession()
  const sessionKey = browserReadableSessionKey(sessionState)
  const overviewRefresh = useRef<ReturnType<typeof makeOverviewRefresh<PluginOverviewResponse>> | null>(null)
  const detailTracker = useRef(makeConnectionDetailTracker())
  const refreshOverview = useCallback(() => overviewRefresh.current?.refresh(), [])
  const [connectionsState, setConnectionsState] = useState<ConnectionsState>({ _tag: "idle" })
  const [awsProfilesState, setAwsProfilesState] = useState<AwsProfilesState>({ _tag: "idle" })
  const awsProfiles = awsProfilesState._tag === "ready" ? awsProfilesState.profiles : NO_AWS_PROFILES
  // Stable across renders: the setup form re-asks for regions whenever this identity changes.
  const discoverAwsRegions = useCallback(
    (profile: string, signal: AbortSignal): Promise<AwsRegionDiscoveryResponse> => {
      const discoverRegions = transport.discoverAwsRegions
      if (discoverRegions === undefined) return Promise.resolve({ _tag: "denied" })
      return discoverRegions(profile, signal).catch(<UnparsedInput,>(failure: UnparsedInput) => {
        if (sessionKey !== null && Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
        return Promise.reject(failure)
      })
    },
    [invalidateSession, sessionKey, transport]
  )
  const [atlassianProfilesState, setAtlassianProfilesState] = useState<AtlassianProfilesState>({ _tag: "idle" })
  const [testStates, setTestStates] = useState<ReadonlyMap<PluginConnectionId, ConnectionTestState>>(new Map())
  const [enablementStates, setEnablementStates] = useState<ReadonlyMap<PluginConnectionId, ConnectionEnablementState>>(
    new Map()
  )
  const [synchronizationStates, setSynchronizationStates] = useState<
    ReadonlyMap<PluginConnectionId, ConnectionSynchronizationViewState>
  >(new Map())
  const [administrationStates, setAdministrationStates] = useState<
    ReadonlyMap<PluginConnectionId, ConnectionAdministrationViewState>
  >(new Map())
  const [openProvider, setOpenProvider] = useState<ProviderId | null>(null)
  const [atlassianSetupIntent, setAtlassianSetupIntent] = useState<AtlassianSetupIntent | null>(null)
  const [submittingProvider, setSubmittingProvider] = useState<ProviderId | null>(null)
  const testRequests = useRef(new Map<PluginConnectionId, AbortController>())
  const createRequest = useRef<AbortController | null>(null)
  const completedBatchDrafts = useRef(new Map<ProviderId, Set<string>>())
  const enablementRequests = useRef(new Map<PluginConnectionId, AbortController>())
  const awsProfileRequest = useRef<AbortController | null>(null)
  const atlassianProfileRequest = useRef<AbortController | null>(null)
  const synchronizationRequests = useRef(new Map<PluginConnectionId, AbortController>())
  // Running syncs, kept apart from state reads: a page refresh re-reads state and must never abort a sync.
  const synchronizeRequests = useRef(new Map<PluginConnectionId, AbortController>())
  const administrationRequests = useRef(new Map<PluginConnectionId, AbortController>())
  const administrationMutations = useRef(new Map<PluginConnectionId, AbortController>())
  const accountMutations = useRef(new Map<ProviderAccountId, AbortController>())

  const refreshAdministration = useCallback(
    (pluginConnectionId: PluginConnectionId): void => {
      if (sessionKey === null || transport.administration === undefined) return
      administrationRequests.current.get(pluginConnectionId)?.abort()
      const request = new AbortController()
      administrationRequests.current.set(pluginConnectionId, request)
      setAdministrationStates((current) => new Map(current).set(pluginConnectionId, { _tag: "loading" }))
      transport.administration(pluginConnectionId, request.signal).then(
        (administration) => {
          if (request.signal.aborted) return
          administrationRequests.current.delete(pluginConnectionId)
          setAdministrationStates((current) =>
            new Map(current).set(pluginConnectionId, { _tag: "ready", administration })
          )
        },
        (failure) => {
          if (request.signal.aborted) return
          administrationRequests.current.delete(pluginConnectionId)
          detailTracker.current.failed(pluginConnectionId)
          if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
          setAdministrationStates((current) => new Map(current).set(pluginConnectionId, { _tag: "failed" }))
        }
      )
    },
    [invalidateSession, sessionKey, transport]
  )

  useEffect(() => {
    if (sessionKey === null || transport.observeInvalidations === undefined) return
    const request = new AbortController()
    transport
      .observeInvalidations({
        sessionKey,
        signal: request.signal,
        onSessionExpired: invalidateSession,
        onInvalidation: () => {
          if (!request.signal.aborted) refreshOverview()
        }
      })
      .catch(() => {
        if (!request.signal.aborted) setConnectionsState((current) => overviewRefreshFailed(current, sessionKey))
      })
    return () => request.abort()
  }, [invalidateSession, refreshOverview, sessionKey, transport])

  const refreshSynchronization = useCallback(
    (pluginConnectionId: PluginConnectionId): void => {
      if (sessionKey === null || transport.synchronization === undefined) return
      // A running sync answers with its own state when it settles.
      if (synchronizeRequests.current.has(pluginConnectionId)) return
      synchronizationRequests.current.get(pluginConnectionId)?.abort()
      const request = new AbortController()
      synchronizationRequests.current.set(pluginConnectionId, request)
      setSynchronizationStates((current) => new Map(current).set(pluginConnectionId, { _tag: "loading" }))
      transport.synchronization(pluginConnectionId, request.signal).then(
        (synchronization) => {
          if (request.signal.aborted) return
          synchronizationRequests.current.delete(pluginConnectionId)
          setSynchronizationStates((current) =>
            new Map(current).set(pluginConnectionId, { _tag: "ready", synchronization })
          )
        },
        (failure) => {
          if (request.signal.aborted) return
          synchronizationRequests.current.delete(pluginConnectionId)
          detailTracker.current.failed(pluginConnectionId)
          if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
          setSynchronizationStates((current) => new Map(current).set(pluginConnectionId, { _tag: "failed" }))
        }
      )
    },
    [invalidateSession, sessionKey, transport]
  )

  const synchronizeConnection = useCallback(
    (pluginConnectionId: PluginConnectionId): void => {
      if (sessionKey === null || transport.synchronize === undefined) return
      synchronizationRequests.current.get(pluginConnectionId)?.abort()
      synchronizationRequests.current.delete(pluginConnectionId)
      synchronizeRequests.current.get(pluginConnectionId)?.abort()
      const request = new AbortController()
      synchronizeRequests.current.set(pluginConnectionId, request)
      setSynchronizationStates((current) => {
        const existing = current.get(pluginConnectionId)
        const previous = existing?._tag === "ready" ? existing.synchronization : null
        return new Map(current).set(pluginConnectionId, { _tag: "syncing", previous })
      })
      transport.synchronize(pluginConnectionId, request.signal).then(
        (synchronization) => {
          if (request.signal.aborted) return
          synchronizeRequests.current.delete(pluginConnectionId)
          setSynchronizationStates((current) =>
            new Map(current).set(pluginConnectionId, { _tag: "ready", synchronization })
          )
        },
        (failure) => {
          if (request.signal.aborted) return
          synchronizeRequests.current.delete(pluginConnectionId)
          if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
          setSynchronizationStates((current) =>
            new Map(current).set(
              pluginConnectionId,
              Schema.is(RateLimitedApiError)(failure) ? { _tag: "failed", requestBudget: failure } : { _tag: "failed" }
            )
          )
        }
      )
    },
    [invalidateSession, sessionKey, transport]
  )

  useEffect(() => {
    if (sessionKey === null) {
      setConnectionsState({ _tag: "idle" })
      return
    }
    const pump = makeOverviewRefresh({
      load: transport.overview,
      onStarted: () =>
        setConnectionsState((current) =>
          current._tag === "ready" && current.sessionKey === sessionKey
            ? { ...current, refresh: "pending" }
            : { _tag: "loading" }
        ),
      onSuccess: (overview) => setConnectionsState((current) => receiveOverview(current, overview, sessionKey)),
      onFailure: (cause) => {
        if (Predicate.isTagged("UnauthorizedApiError")(cause)) {
          pump.dispose()
          invalidateSession(sessionKey)
          return
        }
        setConnectionsState((current) => overviewRefreshFailed(current, sessionKey))
      }
    })
    overviewRefresh.current = pump
    pump.refresh()
    return () => {
      pump.dispose()
      overviewRefresh.current = null
      detailTracker.current.reset()
    }
  }, [invalidateSession, sessionKey, transport])

  const connectionRows =
    connectionsState._tag === "ready" && connectionsState.sessionKey === sessionKey
      ? connectionsState.overview.connections
      : null

  useEffect(() => {
    if (connectionRows === null) return
    const { changed, removed } = detailTracker.current.reconcile(connectionRows)
    const synchronizableIds = new Set(
      connectionRows
        .filter(({ supportsSynchronization }) => supportsSynchronization)
        .map(({ pluginConnectionId }) => pluginConnectionId)
    )
    for (const [id, request] of synchronizationRequests.current) {
      if (synchronizableIds.has(id)) continue
      request.abort()
      synchronizationRequests.current.delete(id)
    }
    for (const [id, request] of synchronizeRequests.current) {
      if (synchronizableIds.has(id)) continue
      request.abort()
      synchronizeRequests.current.delete(id)
    }
    for (const id of removed) {
      administrationRequests.current.get(id)?.abort()
      administrationRequests.current.delete(id)
    }
    setSynchronizationStates((current) => new Map([...current].filter(([id]) => synchronizableIds.has(id))))
    setAdministrationStates((current) => new Map([...current].filter(([id]) => !removed.includes(id))))
    for (const connection of changed) {
      if (connection.supportsSynchronization) refreshSynchronization(connection.pluginConnectionId)
      refreshAdministration(connection.pluginConnectionId)
    }
  }, [connectionRows, refreshAdministration, refreshSynchronization])

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
    if (sessionKey === null || (openProvider !== "jira" && openProvider !== "confluence")) return
    atlassianProfileRequest.current?.abort()
    const request = new AbortController()
    atlassianProfileRequest.current = request
    setAtlassianProfilesState({ _tag: "loading" })
    const discoverAtlassianProfiles = transport.discoverAtlassianProfiles
    if (discoverAtlassianProfiles === undefined) {
      setAtlassianProfilesState({ _tag: "failed" })
      return () => request.abort()
    }
    discoverAtlassianProfiles(request.signal).then(
      (profiles) => {
        if (!request.signal.aborted) setAtlassianProfilesState({ _tag: "ready", profiles })
      },
      (failure) => {
        if (request.signal.aborted) return
        if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
        setAtlassianProfilesState({ _tag: "failed" })
      }
    )
    return () => request.abort()
  }, [invalidateSession, openProvider, sessionKey, transport])

  useEffect(() => {
    setTestStates(new Map())
    setEnablementStates(new Map())
    setSynchronizationStates(new Map())
    setAdministrationStates(new Map())
    setOpenProvider(null)
    setAtlassianSetupIntent(null)
    setSubmittingProvider(null)
    setAwsProfilesState({ _tag: "idle" })
    setAtlassianProfilesState({ _tag: "idle" })
    completedBatchDrafts.current.clear()
    return () => {
      for (const request of testRequests.current.values()) request.abort()
      testRequests.current.clear()
      createRequest.current?.abort()
      createRequest.current = null
      awsProfileRequest.current?.abort()
      awsProfileRequest.current = null
      atlassianProfileRequest.current?.abort()
      atlassianProfileRequest.current = null
      for (const request of synchronizationRequests.current.values()) request.abort()
      synchronizationRequests.current.clear()
      for (const request of synchronizeRequests.current.values()) request.abort()
      synchronizeRequests.current.clear()
      for (const request of enablementRequests.current.values()) request.abort()
      enablementRequests.current.clear()
      for (const request of administrationRequests.current.values()) request.abort()
      administrationRequests.current.clear()
      for (const request of administrationMutations.current.values()) request.abort()
      administrationMutations.current.clear()
      for (const request of accountMutations.current.values()) request.abort()
      accountMutations.current.clear()
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
    if (requestedProvider === "jira" || requestedProvider === "confluence") {
      const callbackProviders = selectedAtlassianOAuthProviders(searchParams)
      const hasAlignedCallbackIntent = callbackProviders?.includes(requestedProvider) === true
      setAtlassianSetupIntent(
        !hasAlignedCallbackIntent
          ? missingAtlassianProductsIntent(connectionsState.overview.connections, requestedProvider)
          : {
              preferredProfileId: selectedAtlassianOAuthProfileId(searchParams),
              preferredSiteId: selectedAtlassianOAuthSiteId(searchParams),
              providers: callbackProviders,
              requestedOAuthProviders: callbackProviders
            }
      )
    }
    setOpenProvider(requestedProvider)
    const nextSearchParams = new URLSearchParams(searchParams)
    nextSearchParams.delete("enable")
    nextSearchParams.delete("atlassianProfile")
    nextSearchParams.delete("atlassianProvider")
    nextSearchParams.delete("atlassianSite")
    setSearchParams(nextSearchParams, { replace: true })
  }, [connectionsState, searchParams, sessionState, setSearchParams])

  const testConnection = useCallback(
    (pluginConnectionId: PluginConnectionId, refreshOverviewAfterHealthy = false): void => {
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
          refreshAdministration(pluginConnectionId)
          if (result._tag === "healthy" && refreshOverviewAfterHealthy) {
            refreshOverview()
          }
        },
        (failure) => {
          if (request.signal.aborted) return
          testRequests.current.delete(pluginConnectionId)
          if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
          setTestStates((current) => new Map(current).set(pluginConnectionId, { _tag: "request-failed" }))
        }
      )
    },
    [invalidateSession, refreshAdministration, refreshOverview, sessionKey, transport]
  )

  const createConnections = useCallback(
    async (drafts: ReadonlyArray<ServiceConnectionDraft>, originProvider: ProviderId): Promise<boolean> => {
      if (sessionKey === null) return false
      createRequest.current?.abort()
      const request = new AbortController()
      createRequest.current = request
      setSubmittingProvider(originProvider)
      let hasFailedTest = false
      let hasSetupFailure = false
      let shouldRefreshOverview = false
      const completed = completedBatchDrafts.current.get(originProvider) ?? new Set<string>()
      completedBatchDrafts.current.set(originProvider, completed)
      const acceptResponse = (draftKey: string, response: CreatePluginConnectionResponse): void => {
        completed.add(draftKey)
        hasFailedTest = hasFailedTest || response.test._tag !== "healthy"
        shouldRefreshOverview = shouldRefreshOverview || response.connection.providerAccountId !== null
        setConnectionsState((current) =>
          current._tag === "ready"
            ? {
                ...current,
                overview: {
                  ...current.overview,
                  connections: mergeConnections(current.overview.connections, [response.connection])
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
      try {
        const pending = drafts.filter((draft) => !completed.has(setupDraftKey(draft)))
        if (transport.createBatch !== undefined && pending.length > 0) {
          const draftKeysByConnectionId = new Map<PluginConnectionId, string>()
          const connections: Array<CreatePluginConnectionRequest> = []
          for (const draft of pending) {
            const pluginConnectionId = await transport.makeConnectionId()
            draftKeysByConnectionId.set(pluginConnectionId, setupDraftKey(draft))
            connections.push({
              pluginConnectionId,
              providerId: draft.catalog.providerId,
              displayName: draft.displayName,
              values: draft.values
            })
          }
          const batch = await transport.createBatch({ connections }, request.signal)
          if (request.signal.aborted) return false
          const completedConnectionIds = new Set<PluginConnectionId>()
          for (const result of batch.results) {
            const pluginConnectionId =
              result._tag === "failed" ? result.pluginConnectionId : result.response.connection.pluginConnectionId
            if (!draftKeysByConnectionId.has(pluginConnectionId) || completedConnectionIds.has(pluginConnectionId)) {
              hasSetupFailure = true
              continue
            }
            completedConnectionIds.add(pluginConnectionId)
            if (result._tag === "failed") {
              hasSetupFailure = true
              continue
            }
            const draftKey = draftKeysByConnectionId.get(result.response.connection.pluginConnectionId)
            if (draftKey !== undefined) acceptResponse(draftKey, result.response)
          }
          hasSetupFailure = hasSetupFailure || completedConnectionIds.size !== connections.length
        } else
          for (const draft of pending) {
            const draftKey = setupDraftKey(draft)
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
            acceptResponse(draftKey, response)
          }
        if (shouldRefreshOverview) {
          try {
            const refreshedOverview = await transport.overview(request.signal)
            if (!request.signal.aborted) {
              setConnectionsState((current) => receiveOverview(current, refreshedOverview, sessionKey))
            }
          } catch (failure: unknown) {
            if (request.signal.aborted) return false
            if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
            setConnectionsState((current) => overviewRefreshFailed(current, sessionKey))
          }
        }
        if (hasSetupFailure) completedBatchDrafts.current.set(originProvider, completed)
        else completedBatchDrafts.current.delete(originProvider)
        createRequest.current = null
        setOpenProvider(hasFailedTest || hasSetupFailure ? originProvider : null)
        setSubmittingProvider(null)
        return !hasSetupFailure
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
                  ...current,
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

  const reauthorizeConnection = useCallback(
    async (
      pluginConnectionId: PluginConnectionId,
      credentials: ReadonlyArray<PluginCredentialReplacement>
    ): Promise<boolean> => {
      if (sessionKey === null || transport.reauthorize === undefined) return false
      const administrationState = administrationStates.get(pluginConnectionId)
      if (administrationState?._tag !== "ready") return false
      administrationMutations.current.get(pluginConnectionId)?.abort()
      const request = new AbortController()
      administrationMutations.current.set(pluginConnectionId, request)
      try {
        const response = await transport.reauthorize(
          pluginConnectionId,
          administrationState.administration.configuration.revision,
          credentials,
          request.signal
        )
        if (request.signal.aborted) return false
        administrationMutations.current.delete(pluginConnectionId)
        setConnectionsState((current) =>
          current._tag === "ready"
            ? {
                ...current,
                overview: {
                  ...current.overview,
                  connections: current.overview.connections.map((candidate) =>
                    candidate.pluginConnectionId === pluginConnectionId ? response.connection : candidate
                  )
                }
              }
            : current
        )
        setTestStates((current) => new Map(current).set(pluginConnectionId, { _tag: "result", result: response.test }))
        refreshAdministration(pluginConnectionId)
        return true
      } catch (failure: unknown) {
        if (request.signal.aborted) return false
        administrationMutations.current.delete(pluginConnectionId)
        if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
        refreshAdministration(pluginConnectionId)
        return false
      }
    },
    [administrationStates, invalidateSession, refreshAdministration, sessionKey, transport]
  )

  useEffect(() => {
    if (
      connectionsState._tag !== "ready" ||
      sessionState._tag !== "authenticated" ||
      sessionState.session.permission !== "workspace-owner"
    )
      return
    const pluginConnectionId = selectedAtlassianRecoveryConnectionId(searchParams)
    const profileId = selectedAtlassianRecoveryProfileId(searchParams)
    if (pluginConnectionId === null || profileId === null) return
    const connection = connectionsState.overview.connections.find(
      (candidate) => candidate.pluginConnectionId === pluginConnectionId
    )
    const administration = administrationStates.get(pluginConnectionId)
    const oauthProfileField =
      administration?._tag === "ready"
        ? administration.administration.credentialFields.find(({ key }) => key === "oauthProfileId")
        : undefined
    if (
      (connection?.providerId !== "jira" && connection?.providerId !== "confluence") ||
      administration?._tag !== "ready" ||
      oauthProfileField === undefined
    )
      return
    const nextSearchParams = new URLSearchParams(searchParams)
    nextSearchParams.delete("atlassianRecoveryConnection")
    nextSearchParams.delete("atlassianRecoveryProfile")
    setSearchParams(nextSearchParams, { replace: true })
    void reauthorizeConnection(pluginConnectionId, [{ key: oauthProfileField.key, value: profileId }])
  }, [administrationStates, connectionsState, reauthorizeConnection, searchParams, sessionState, setSearchParams])

  const revokeConnection = useCallback(
    async (pluginConnectionId: PluginConnectionId): Promise<boolean> => {
      if (sessionKey === null || transport.revoke === undefined) return false
      const administrationState = administrationStates.get(pluginConnectionId)
      if (administrationState?._tag !== "ready") return false
      administrationMutations.current.get(pluginConnectionId)?.abort()
      const request = new AbortController()
      administrationMutations.current.set(pluginConnectionId, request)
      try {
        const connection = await transport.revoke(
          pluginConnectionId,
          administrationState.administration.configuration.revision,
          request.signal
        )
        if (request.signal.aborted) return false
        administrationMutations.current.delete(pluginConnectionId)
        setConnectionsState((current) =>
          current._tag === "ready"
            ? {
                ...current,
                overview: {
                  ...current.overview,
                  connections: current.overview.connections.map((candidate) =>
                    candidate.pluginConnectionId === pluginConnectionId ? connection : candidate
                  )
                }
              }
            : current
        )
        setTestStates((current) => {
          const next = new Map(current)
          next.delete(pluginConnectionId)
          return next
        })
        refreshAdministration(pluginConnectionId)
        return true
      } catch (failure: unknown) {
        if (request.signal.aborted) return false
        administrationMutations.current.delete(pluginConnectionId)
        if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
        refreshAdministration(pluginConnectionId)
        return false
      }
    },
    [administrationStates, invalidateSession, refreshAdministration, sessionKey, transport]
  )

  const renameProviderAccount = useCallback(
    async (account: PluginOverviewResponse["accounts"][number], displayName: string): Promise<boolean> => {
      if (sessionKey === null || transport.patchAccount === undefined || displayName.length === 0) return false
      accountMutations.current.get(account.providerAccountId)?.abort()
      const request = new AbortController()
      accountMutations.current.set(account.providerAccountId, request)
      try {
        const updated = await transport.patchAccount(
          account.providerAccountId,
          { expectedRevision: account.revision, displayName },
          request.signal
        )
        if (request.signal.aborted) return false
        if (accountMutations.current.get(account.providerAccountId) === request) {
          accountMutations.current.delete(account.providerAccountId)
        }
        setConnectionsState((current) =>
          current._tag === "ready"
            ? {
                ...current,
                overview: {
                  ...current.overview,
                  accounts: current.overview.accounts.map((candidate) =>
                    candidate.providerAccountId === updated.providerAccountId ? updated : candidate
                  )
                }
              }
            : current
        )
        return true
      } catch (failure: unknown) {
        if (request.signal.aborted) return false
        if (accountMutations.current.get(account.providerAccountId) === request) {
          accountMutations.current.delete(account.providerAccountId)
        }
        if (Predicate.isTagged("UnauthorizedApiError")(failure)) invalidateSession(sessionKey)
        return false
      }
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
          {session === null || (connectionsState._tag === "ready" && connectionsState.overview.connections.length === 0)
            ? "Choose a service below. Control Center will enable it and verify the exact account before using it."
            : "Configure first-party providers and verify the exact account each connection represents."}
        </Text>
      </header>
      {connectionsState._tag !== "ready" || connectionsState.refresh === "idle" ? null : (
        <Text as="p" role="status" tone="secondary" variant="meta">
          {connectionsState.refresh === "pending"
            ? "Refreshing connections…"
            : "Could not refresh connections. Showing the last read."}
        </Text>
      )}
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
              key={service.providerId}
              service={service}
              statusLabel="Loading"
              statusTone="progress"
            />
          ))}
        </div>
      ) : connectionsState._tag === "failed" ? (
        <>
          <StatePanel
            action={<Button onClick={() => refreshOverview()}>Try again</Button>}
            description="Control Center could not load connection details. The installed services remain visible below."
            title="Connections unavailable"
          />
          <div className={styles.grid}>
            {firstPartyServiceIdentities.map((service) => (
              <ServicePreviewCard
                key={service.providerId}
                service={service}
                statusLabel="Installed"
                statusTone="neutral"
              />
            ))}
          </div>
        </>
      ) : (
        <>
          {connectionsState.overview.accounts.length === 0 ? null : (
            <section aria-labelledby="connected-accounts-title" className={styles.accounts}>
              <div className={styles.sectionHeading}>
                <Text as="h2" id="connected-accounts-title" variant="section-title">
                  Connected accounts
                </Text>
                <Text tone="secondary" variant="body">
                  One verified provider identity can own several followed resources.
                </Text>
              </div>
              <div className={styles.accountGrid}>
                {connectionsState.overview.accounts.map((account) => (
                  <ProviderAccountCard
                    account={account}
                    administrationStates={administrationStates}
                    canConfigure={canConfigure}
                    connections={connectionsState.overview.connections}
                    enablementStates={enablementStates}
                    key={account.providerAccountId}
                    onAdd={(providerId, providerImmutableId) => {
                      if (providerId === "jira" || providerId === "confluence") {
                        setAtlassianSetupIntent({
                          preferredProfileId: null,
                          preferredSiteId: providerImmutableId,
                          providers: [providerId],
                          requestedOAuthProviders: null
                        })
                      }
                      setOpenProvider(providerId)
                    }}
                    onSetEnabled={setConnectionEnabled}
                    onRefreshSynchronization={refreshSynchronization}
                    onReauthorize={reauthorizeConnection}
                    onRename={(displayName) => renameProviderAccount(account, displayName)}
                    onRevoke={revokeConnection}
                    onStartAtlassianOAuth={transport.startAtlassianOAuthGrant}
                    onSynchronize={synchronizeConnection}
                    synchronizationStates={synchronizationStates}
                    onTest={testConnection}
                    testStates={testStates}
                  />
                ))}
              </div>
            </section>
          )}
          <div className={styles.grid}>
            {connectionsState.overview.catalog.flatMap((catalog) => {
              const configured = connectionsState.overview.connections.filter(
                (connection) => connection.providerId === catalog.providerId
              )
              const groupedResourceIds = new Set(
                connectionsState.overview.accounts.flatMap(({ resources }) =>
                  resources.map(({ followedResourceId }) => followedResourceId)
                )
              )
              const hasGroupedResource = configured.some(
                ({ followedResourceId }) => followedResourceId !== null && groupedResourceIds.has(followedResourceId)
              )
              const standaloneConnections = configured.filter(
                ({ followedResourceId }) => followedResourceId === null || !groupedResourceIds.has(followedResourceId)
              )
              const missingAtlassianIntent = missingAtlassianProductsIntent(
                connectionsState.overview.connections,
                catalog.providerId === "jira" || catalog.providerId === "confluence" ? catalog.providerId : undefined
              )
              const setupIntent = resolvedAtlassianSetupIntent(
                atlassianSetupIntent ?? missingAtlassianIntent,
                connectionsState.overview.connections,
                atlassianProfilesState
              )
              const cards = standaloneConnections.map((connection) => (
                <ConnectionCard
                  providerName={
                    connectionsState.overview.catalog.find(({ providerId }) => providerId === connection.providerId)
                      ?.displayName
                  }
                  administrationState={administrationStates.get(connection.pluginConnectionId)}
                  canConfigure={canConfigure}
                  canTest={canConfigure}
                  connection={connection}
                  enablementState={enablementStates.get(connection.pluginConnectionId)}
                  key={connection.pluginConnectionId}
                  onConfigure={() => {
                    if (catalog.providerId === "jira" || catalog.providerId === "confluence") {
                      setAtlassianSetupIntent(allAtlassianProductsIntent)
                    }
                    setOpenProvider(catalog.providerId)
                  }}
                  onSetEnabled={setConnectionEnabled}
                  onRefreshSynchronization={refreshSynchronization}
                  onReauthorize={reauthorizeConnection}
                  onRevoke={revokeConnection}
                  onStartAtlassianOAuth={transport.startAtlassianOAuthGrant}
                  onSynchronize={synchronizeConnection}
                  onTest={(pluginConnectionId) => testConnection(pluginConnectionId, true)}
                  synchronizationState={synchronizationStates.get(connection.pluginConnectionId)}
                  testState={testStates.get(connection.pluginConnectionId)}
                />
              ))
              if (
                configured.length > 0 &&
                openProvider !== catalog.providerId &&
                (hasGroupedResource || (catalog.providerId !== "jira" && catalog.providerId !== "confluence"))
              )
                return cards
              return [
                ...cards,
                <CatalogCard
                  atlassianProfiles={atlassianProfilesState._tag === "ready" ? atlassianProfilesState.profiles : []}
                  atlassianProfilesState={atlassianProfilesState._tag}
                  atlassianSetupIntent={setupIntent}
                  awsProfiles={awsProfiles}
                  awsProfilesState={awsProfilesState._tag}
                  canConfigure={canConfigure}
                  catalog={catalog}
                  catalogs={connectionsState.overview.catalog}
                  isAdditional={
                    configured.length > 0 && (catalog.providerId === "jira" || catalog.providerId === "confluence")
                  }
                  isOpen={openProvider === catalog.providerId}
                  isRecovery={standaloneConnections.length > 0}
                  isSubmitting={submittingProvider === catalog.providerId}
                  key={`${catalog.providerId}-catalog`}
                  onCancel={() => {
                    completedBatchDrafts.current.delete(catalog.providerId)
                    setAtlassianSetupIntent(null)
                    setOpenProvider(null)
                  }}
                  onDiscoverAws={(request, signal) => {
                    const discover = transport.discoverAwsResources
                    if (discover === undefined)
                      return Promise.reject(new Error("AWS resource discovery is unavailable"))
                    return discover(request, signal).catch(<UnparsedInput,>(failure: UnparsedInput) => {
                      if (sessionKey !== null && Predicate.isTagged("UnauthorizedApiError")(failure)) {
                        invalidateSession(sessionKey)
                      }
                      return Promise.reject(failure)
                    })
                  }}
                  onDiscoverAwsRegions={discoverAwsRegions}
                  onOpen={() => {
                    if (openProvider !== catalog.providerId) {
                      completedBatchDrafts.current.delete(catalog.providerId)
                    }
                    if (catalog.providerId === "jira" || catalog.providerId === "confluence") {
                      setAtlassianSetupIntent(missingAtlassianIntent)
                    }
                    setOpenProvider(catalog.providerId)
                  }}
                  onReloadAwsProfiles={(signal) => {
                    const discoverProfiles = transport.discoverAwsProfiles
                    if (discoverProfiles === undefined) {
                      return Promise.resolve(awsProfiles)
                    }
                    return discoverProfiles(signal).then((profiles) => {
                      if (!signal.aborted) setAwsProfilesState({ _tag: "ready", profiles })
                      return profiles
                    })
                  }}
                  onStartAtlassianOAuth={(providers, signal, configuration) => {
                    const start = transport.startAtlassianOAuthGrant
                    if (start === undefined) return Promise.reject(new Error("Atlassian OAuth is unavailable"))
                    return start(providers, signal, configuration)
                  }}
                  onSubmit={(displayName, values) => createConnection(catalog, displayName, values)}
                  onSubmitAtlassian={(drafts) => createConnections(drafts, catalog.providerId)}
                  onSubmitAws={(drafts) => createConnections(drafts, catalog.providerId)}
                />
              ]
            })}
          </div>
        </>
      )}
    </section>
  )
}

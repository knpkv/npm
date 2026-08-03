import { Button, Field, StateLabel, Text } from "@knpkv/rly/primitives"
import { type FormEvent, type ReactElement, useEffect, useRef, useState } from "react"

import type {
  AtlassianOAuthClientConfiguration,
  AtlassianOAuthGrantStartResponse,
  AtlassianOAuthProviderIntent,
  PluginConnectionAdministration,
  PluginCredentialReplacement
} from "../../api/plugins.js"
import { rememberAtlassianOAuthSetupIntent } from "./atlassianOAuthSetupIntentStorage.js"

import styles from "./ServicesPage.module.css"

export type ConnectionAdministrationViewState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly administration: PluginConnectionAdministration }

const diagnosticTone = (
  severity: PluginConnectionAdministration["diagnostics"][number]["severity"]
): "critical" | "caution" | "neutral" =>
  severity === "critical" ? "critical" : severity === "warning" ? "caution" : "neutral"

/** Secret-safe connection recovery controls backed by the administration read model. */
export const ConnectionAdministration = ({
  atlassianOAuthProviders,
  canConfigure,
  onReauthorize,
  onRevoke,
  onStartAtlassianOAuth,
  state
}: {
  readonly atlassianOAuthProviders?: AtlassianOAuthProviderIntent
  readonly canConfigure: boolean
  readonly onReauthorize: (credentials: ReadonlyArray<PluginCredentialReplacement>) => Promise<boolean>
  readonly onRevoke: () => Promise<boolean>
  readonly onStartAtlassianOAuth:
    | ((
        providers: AtlassianOAuthProviderIntent,
        signal: AbortSignal,
        configuration?: AtlassianOAuthClientConfiguration
      ) => Promise<AtlassianOAuthGrantStartResponse>)
    | undefined
  readonly state: ConnectionAdministrationViewState | undefined
}): ReactElement | null => {
  const [credentialValues, setCredentialValues] = useState<ReadonlyMap<string, string>>(new Map())
  const [mutation, setMutation] = useState<"idle" | "reauthorizing" | "revoking" | "failed">("idle")
  const [oauthState, setOAuthState] = useState<"idle" | "starting" | "configuration-required" | "failed">("idle")
  const [oauthCallbackUrl, setOAuthCallbackUrl] = useState<string | null>(null)
  const [oauthClientId, setOAuthClientId] = useState("")
  const [oauthClientSecret, setOAuthClientSecret] = useState("")
  const oauthRequest = useRef<AbortController | null>(null)

  useEffect(() => {
    setCredentialValues(new Map())
    setMutation("idle")
    setOAuthState("idle")
    setOAuthCallbackUrl(null)
    oauthRequest.current?.abort()
    oauthRequest.current = null
  }, [state?._tag === "ready" ? state.administration.configuration.revision : state?._tag])

  useEffect(() => () => oauthRequest.current?.abort(), [])

  if (state === undefined) return null
  if (state._tag === "loading") {
    return (
      <Text tone="secondary" variant="meta">
        Loading permissions and diagnostics…
      </Text>
    )
  }
  if (state._tag === "failed") {
    return (
      <Text className={styles.setupError} role="alert" variant="body">
        Administration details are unavailable.
      </Text>
    )
  }

  const { administration } = state
  const manualCredentialFields = administration.credentialFields.filter(({ key }) => key !== "oauthProfileId")
  const supportsOAuthRecovery =
    administration.credentialFields.some(({ key }) => key === "oauthProfileId") &&
    (administration.connection.providerId === "jira" || administration.connection.providerId === "confluence") &&
    onStartAtlassianOAuth !== undefined
  const configuredSite = administration.configuration.values.find(({ key }) => key === "siteId")
  const preferredSiteId =
    configuredSite?._tag === "text" || configuredSite?._tag === "url" ? configuredSite.value : null
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const credentials = manualCredentialFields.flatMap((field) => {
      const entered = credentialValues.get(field.key) ?? ""
      if (entered.trim().length === 0) return []
      return [{ key: field.key, value: field.kind === "secret" ? entered : entered.trim() }]
    })
    if (credentials.length === 0) return
    setMutation("reauthorizing")
    void onReauthorize(credentials).then((succeeded) => {
      setMutation(succeeded ? "idle" : "failed")
      if (succeeded) setCredentialValues(new Map())
    })
  }

  const revoke = (): void => {
    setMutation("revoking")
    void onRevoke().then((succeeded) => setMutation(succeeded ? "idle" : "failed"))
  }

  const startOAuth = (configuration?: AtlassianOAuthClientConfiguration): void => {
    if (!supportsOAuthRecovery || onStartAtlassianOAuth === undefined) return
    const providers =
      atlassianOAuthProviders ?? (administration.connection.providerId === "jira" ? ["jira"] : ["confluence"])
    oauthRequest.current?.abort()
    const request = new AbortController()
    oauthRequest.current = request
    setOAuthState("starting")
    setOAuthCallbackUrl(null)
    void onStartAtlassianOAuth(providers, request.signal, configuration).then(
      (result) => {
        if (request.signal.aborted) return
        if (result._tag === "configuration-required") {
          setOAuthCallbackUrl(result.callbackUrl)
          setOAuthState("configuration-required")
          return
        }
        if (
          !rememberAtlassianOAuthSetupIntent(result.authorizationUrl, {
            preferredSiteId,
            providers,
            recoveryConnectionId: administration.connection.pluginConnectionId
          })
        ) {
          setOAuthState("failed")
          return
        }
        window.location.assign(result.authorizationUrl)
      },
      () => {
        if (!request.signal.aborted) setOAuthState("failed")
      }
    )
  }

  const configureOAuth = (): void => {
    const clientId = oauthClientId.trim()
    if (clientId.length === 0 || oauthClientSecret.length === 0) {
      setOAuthState("failed")
      return
    }
    startOAuth({ clientId, clientSecret: oauthClientSecret })
  }

  return (
    <section aria-label="Connection administration" className={styles.administration}>
      <div className={styles.administrationSection}>
        <Text as="h4" variant="label">
          Permissions
        </Text>
        <div className={styles.administrationLabels}>
          {administration.permissions.map((permission) => (
            <StateLabel
              key={`${permission.capabilityId}:${permission.version}`}
              label={`${permission.capabilityId} v${permission.version}`}
              size="compact"
              tone={permission.state === "available" ? "positive" : "neutral"}
            />
          ))}
          {administration.permissions.length === 0 ? (
            <Text tone="secondary" variant="meta">
              No provider operations were negotiated.
            </Text>
          ) : null}
        </div>
      </div>
      <div className={styles.administrationSection}>
        <Text as="h4" variant="label">
          Schedule and freshness
        </Text>
        <Text tone="secondary" variant="meta">
          {administration.schedule.mode === "manual"
            ? "Manual synchronization"
            : "This provider does not support synchronization"}
          {administration.synchronization?.lastSuccessAt === null ||
          administration.synchronization?.lastSuccessAt === undefined
            ? " · No successful sync recorded"
            : ` · Last successful sync ${administration.synchronization.lastSuccessAt}`}
        </Text>
      </div>
      <div className={styles.administrationSection}>
        <Text as="h4" variant="label">
          Diagnostics
        </Text>
        <div className={styles.diagnostics}>
          {administration.diagnostics.map((diagnostic) => (
            <div className={styles.diagnostic} key={diagnostic.code}>
              <StateLabel label={diagnostic.severity} size="compact" tone={diagnosticTone(diagnostic.severity)} />
              <Text variant="meta">{diagnostic.summary}</Text>
            </div>
          ))}
        </div>
      </div>
      {canConfigure && administration.credentialFields.length > 0 ? (
        <form className={styles.credentialRecovery} onSubmit={submit}>
          <Text as="h4" variant="label">
            Credential recovery
          </Text>
          <Text tone="secondary" variant="meta">
            Values are sent directly to the machine-local secret store and are never returned by this page.
          </Text>
          {manualCredentialFields.map((field) => (
            <Field description={field.description} key={field.key} label={field.label} size="compact">
              {(controlProps) => (
                <input
                  {...controlProps}
                  autoComplete="off"
                  maxLength={16_384}
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    setCredentialValues((current) => new Map(current).set(field.key, value))
                  }}
                  type="password"
                  value={credentialValues.get(field.key) ?? ""}
                />
              )}
            </Field>
          ))}
          {supportsOAuthRecovery ? (
            <div className={styles.administrationSection}>
              <Text variant="meta">
                Atlassian OAuth recovery creates a new machine-local profile and verifies this connection’s existing
                site and resource before applying it.
              </Text>
              <Button
                loading={oauthState === "starting"}
                onClick={() => startOAuth()}
                type="button"
                variant="secondary"
              >
                Sign in with Atlassian
              </Button>
              {oauthState === "configuration-required" ? (
                <>
                  <Text tone="secondary" variant="meta">
                    Configure the OAuth callback URL in Atlassian: {oauthCallbackUrl}
                  </Text>
                  <Field label="OAuth client ID" size="compact">
                    {(controlProps) => (
                      <input
                        {...controlProps}
                        onChange={(event) => setOAuthClientId(event.currentTarget.value)}
                        value={oauthClientId}
                      />
                    )}
                  </Field>
                  <Field label="OAuth client secret" size="compact">
                    {(controlProps) => (
                      <input
                        {...controlProps}
                        autoComplete="off"
                        onChange={(event) => setOAuthClientSecret(event.currentTarget.value)}
                        type="password"
                        value={oauthClientSecret}
                      />
                    )}
                  </Field>
                  <Button onClick={configureOAuth} type="button" variant="secondary">
                    Save client and sign in
                  </Button>
                </>
              ) : null}
              {oauthState === "failed" ? (
                <Text className={styles.setupError} role="alert" variant="body">
                  Atlassian sign-in could not start. Verify the local OAuth client and try again.
                </Text>
              ) : null}
            </div>
          ) : null}
          <div className={styles.resourceActions}>
            {manualCredentialFields.length > 0 ? (
              <Button
                disabled={mutation === "revoking"}
                loading={mutation === "reauthorizing"}
                type="submit"
                variant="secondary"
              >
                Replace credentials and test
              </Button>
            ) : null}
            <Button
              disabled={mutation === "reauthorizing"}
              loading={mutation === "revoking"}
              onClick={revoke}
              type="button"
              variant="quiet"
            >
              Revoke credentials
            </Button>
          </div>
          {mutation === "failed" ? (
            <Text className={styles.setupError} role="alert" variant="body">
              The credential change was not applied. Refresh the details and try again.
            </Text>
          ) : null}
        </form>
      ) : null}
    </section>
  )
}

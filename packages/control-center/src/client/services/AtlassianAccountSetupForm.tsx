import { Button, Field, Text } from "@knpkv/rly/primitives"
import { type FormEvent, type ReactElement, useEffect, useRef, useState } from "react"

import type {
  AtlassianOAuthGrantStartResponse,
  AtlassianProfileDiscoveryResponse,
  DiscoveredAtlassianProfile,
  PluginServiceCatalogEntry
} from "../../api/plugins.js"
import styles from "./AtlassianAccountSetupForm.module.css"
import { type ServiceConnectionDraft, serviceSetupValues } from "./serviceSetupValues.js"

type AuthenticationMode = "oauth" | "api-token"
type AtlassianProviderId = "confluence" | "jira"

export interface AtlassianSetupIntent {
  readonly providers: ReadonlyArray<AtlassianProviderId>
}

const selectedProfile = (
  profiles: AtlassianProfileDiscoveryResponse,
  profileId: string
): DiscoveredAtlassianProfile | undefined => profiles.find((profile) => profile.profileId === profileId)

const isUsableProfile = (profile: DiscoveredAtlassianProfile, intent: AtlassianSetupIntent): boolean =>
  profile.status === "valid" && intent.providers.every((providerId) => profile.providers.includes(providerId))

const profileAvailability = (profile: DiscoveredAtlassianProfile): string => {
  if (profile.status === "expired") return "expired"
  if (!profile.providers.includes("jira")) return "Confluence only"
  if (!profile.providers.includes("confluence")) return "Jira only"
  return "Jira + Confluence"
}

/** Configure Jira and Confluence beneath one shared Atlassian identity. */
export const AtlassianAccountSetupForm = ({
  catalogs,
  isSubmitting,
  onCancel,
  onStartOAuth,
  onSubmit,
  profiles,
  profilesState,
  setupIntent
}: {
  readonly catalogs: ReadonlyArray<PluginServiceCatalogEntry>
  readonly isSubmitting: boolean
  readonly onCancel: () => void
  readonly onStartOAuth: (signal: AbortSignal) => Promise<AtlassianOAuthGrantStartResponse>
  readonly onSubmit: (drafts: ReadonlyArray<ServiceConnectionDraft>) => Promise<boolean>
  readonly profiles: AtlassianProfileDiscoveryResponse
  readonly profilesState: "failed" | "idle" | "loading" | "ready"
  readonly setupIntent: AtlassianSetupIntent
}): ReactElement => {
  const jira = catalogs.find(({ providerId }) => providerId === "jira")
  const confluence = catalogs.find(({ providerId }) => providerId === "confluence")
  const setupJira = setupIntent.providers.includes("jira")
  const setupConfluence = setupIntent.providers.includes("confluence")
  const [accountName, setAccountName] = useState("Atlassian workspace")
  const [authenticationMode, setAuthenticationMode] = useState<AuthenticationMode>("oauth")
  const [profileId, setProfileId] = useState("")
  const [siteUrl, setSiteUrl] = useState("")
  const [siteId, setSiteId] = useState("")
  const [spaceId, setSpaceId] = useState("")
  const [probePageId, setProbePageId] = useState("")
  const [email, setEmail] = useState("")
  const [apiToken, setApiToken] = useState("")
  const [isStartingOAuth, setIsStartingOAuth] = useState(false)
  const [oauthCallbackUrl, setOAuthCallbackUrl] = useState<string | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const startRequest = useRef<AbortController | null>(null)

  useEffect(() => () => startRequest.current?.abort(), [])

  useEffect(() => {
    if (authenticationMode !== "oauth" || profileId.length > 0) return
    const firstUsableProfile = profiles.find((profile) => isUsableProfile(profile, setupIntent))
    if (firstUsableProfile !== undefined) setProfileId(firstUsableProfile.profileId)
  }, [authenticationMode, profileId, profiles, setupIntent])

  useEffect(() => {
    if (authenticationMode !== "oauth") return
    const profile = selectedProfile(profiles, profileId)
    if (profile === undefined) return
    setSiteUrl(profile.siteUrl)
    setSiteId(profile.cloudId)
  }, [authenticationMode, profileId, profiles])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setSetupError(null)
    if ((setupJira && jira === undefined) || (setupConfluence && confluence === undefined)) {
      setSetupError("The installed Atlassian adapters are unavailable.")
      return
    }
    const normalizedAccountName = accountName.trim()
    const normalizedSiteUrl = siteUrl.trim()
    const normalizedSiteId = siteId.trim()
    const normalizedSpaceId = spaceId.trim()
    const normalizedProbePageId = probePageId.trim()
    if (
      normalizedAccountName.length === 0 ||
      normalizedSiteUrl.length === 0 ||
      (setupConfluence &&
        (normalizedSiteId.length === 0 || normalizedSpaceId.length === 0 || normalizedProbePageId.length === 0))
    ) {
      setSetupError("Add the Atlassian site, Confluence space, and readable health page.")
      return
    }
    const authentication: ReadonlyArray<readonly [string, string]> =
      authenticationMode === "oauth"
        ? [
            ["authMode", "oauth"],
            ["oauthProfileId", profileId]
          ]
        : [
            ["authMode", "api-token"],
            ["email", email.trim()],
            ["apiToken", apiToken]
          ]
    const oauthProfile = selectedProfile(profiles, profileId)
    if (authenticationMode === "oauth" && (oauthProfile === undefined || !isUsableProfile(oauthProfile, setupIntent))) {
      setSetupError("Choose a valid profile for the products being connected, or use an API token instead.")
      return
    }
    if (authenticationMode === "api-token" && (email.trim().length === 0 || apiToken.length === 0)) {
      setSetupError("Add the Atlassian email and API token.")
      return
    }
    const sharedValues: ReadonlyArray<readonly [string, string]> = [
      ...authentication,
      ["webBaseUrl", normalizedSiteUrl],
      ["siteBaseUrl", normalizedSiteUrl],
      ["siteId", normalizedSiteId],
      ["spaceId", normalizedSpaceId],
      ["probePageId", normalizedProbePageId]
    ]
    const overrides = new Map<string, string>(sharedValues)
    const drafts: ReadonlyArray<ServiceConnectionDraft> = [
      ...(setupJira && jira !== undefined
        ? [
            {
              catalog: jira,
              displayName: `${normalizedAccountName} · Jira`,
              values: serviceSetupValues(jira, overrides)
            }
          ]
        : []),
      ...(setupConfluence && confluence !== undefined
        ? [
            {
              catalog: confluence,
              displayName: `${normalizedAccountName} · Confluence`,
              values: serviceSetupValues(confluence, overrides)
            }
          ]
        : [])
    ]
    void onSubmit(drafts).then((didCreate) => {
      if (!didCreate) setSetupError("Some Atlassian services could not be connected. Review the cards below and retry.")
    })
  }

  const startOAuth = (): void => {
    setSetupError(null)
    setOAuthCallbackUrl(null)
    setIsStartingOAuth(true)
    startRequest.current?.abort()
    const request = new AbortController()
    startRequest.current = request
    void onStartOAuth(request.signal).then(
      (result) => {
        if (request.signal.aborted) return
        if (result._tag === "configuration-required") {
          setOAuthCallbackUrl(result.callbackUrl)
          setSetupError("OAuth needs a one-time local client configuration before sign-in.")
          setIsStartingOAuth(false)
          return
        }
        window.location.assign(result.authorizationUrl)
      },
      () => {
        if (request.signal.aborted) return
        setSetupError("Control Center could not start Atlassian sign-in. Try again.")
        setIsStartingOAuth(false)
      }
    )
  }

  const useApiToken = (): void => {
    startRequest.current?.abort()
    startRequest.current = null
    setIsStartingOAuth(false)
    setAuthenticationMode("api-token")
  }

  const discoveryMessage =
    profilesState === "loading"
      ? "Finding local Atlassian OAuth profiles…"
      : profilesState === "failed"
        ? "OAuth profile discovery is unavailable. API token fallback remains available."
        : profilesState === "ready"
          ? `${profiles.filter((profile) => isUsableProfile(profile, setupIntent)).length} ${setupJira && setupConfluence ? "shared " : ""}OAuth ${profiles.filter((profile) => isUsableProfile(profile, setupIntent)).length === 1 ? "profile" : "profiles"} ready`
          : "OAuth profiles stay on this machine and are shared by Jira and Confluence."

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.intro}>
        <Text as="h3" variant="card-title">
          {setupJira && setupConfluence
            ? "One identity. Jira and Confluence together."
            : setupJira
              ? "Connect Jira with your Atlassian identity."
              : "Connect Confluence with your Atlassian identity."}
        </Text>
        <Text tone="secondary" variant="body">
          OAuth is preferred. Control Center reads the selected local profile only inside the server runtime.
        </Text>
        <Text tone="secondary" variant="meta">
          {discoveryMessage}
        </Text>
      </div>
      <Field label="Account name" required size="compact">
        {(controlProps) => (
          <input
            {...controlProps}
            maxLength={90}
            onChange={(event) => setAccountName(event.currentTarget.value)}
            value={accountName}
          />
        )}
      </Field>
      {authenticationMode === "oauth" ? (
        <>
          <Button loading={isStartingOAuth} onClick={startOAuth} type="button" variant="primary">
            Sign in with Atlassian
          </Button>
          {oauthCallbackUrl === null ? null : (
            <Text as="p" tone="secondary" variant="meta">
              Add <code>{oauthCallbackUrl}</code> as the callback URL, then run <code>jira auth configure</code> or
              <code> confluence auth configure</code> on this machine.
            </Text>
          )}
          <Field label="OAuth profile" required size="compact">
            {(controlProps) => (
              <select {...controlProps} onChange={(event) => setProfileId(event.currentTarget.value)} value={profileId}>
                <option value="">Choose a profile already on this machine</option>
                {profiles.map((profile) => (
                  <option
                    disabled={!isUsableProfile(profile, setupIntent)}
                    key={profile.profileId}
                    value={profile.profileId}
                  >
                    {profile.name} · {profileAvailability(profile)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Button onClick={useApiToken} type="button" variant="quiet">
            Use API token instead
          </Button>
        </>
      ) : (
        <div className={styles.fallback}>
          <Field label="Atlassian email" required size="compact">
            {(controlProps) => (
              <input
                {...controlProps}
                autoComplete="username"
                onChange={(event) => setEmail(event.currentTarget.value)}
                type="email"
                value={email}
              />
            )}
          </Field>
          <Field label="API token" required size="compact">
            {(controlProps) => (
              <input
                {...controlProps}
                autoComplete="off"
                maxLength={16_384}
                onChange={(event) => setApiToken(event.currentTarget.value)}
                type="password"
                value={apiToken}
              />
            )}
          </Field>
          <Button onClick={() => setAuthenticationMode("oauth")} type="button" variant="quiet">
            Use OAuth profile
          </Button>
        </div>
      )}
      <Field label="Atlassian site URL" required size="compact">
        {(controlProps) => (
          <input
            {...controlProps}
            disabled={authenticationMode === "oauth"}
            onChange={(event) => setSiteUrl(event.currentTarget.value)}
            placeholder="https://team.atlassian.net/"
            type="url"
            value={siteUrl}
          />
        )}
      </Field>
      {setupConfluence ? (
        <Field
          description="The stable Atlassian cloud ID; filled from OAuth when available."
          label="Site ID"
          required
          size="compact"
        >
          {(controlProps) => (
            <input
              {...controlProps}
              disabled={authenticationMode === "oauth"}
              onChange={(event) => setSiteId(event.currentTarget.value)}
              value={siteId}
            />
          )}
        </Field>
      ) : null}
      {setupConfluence ? (
        <div className={styles.resources}>
          <Field label="Confluence space ID" required size="compact">
            {(controlProps) => (
              <input {...controlProps} onChange={(event) => setSpaceId(event.currentTarget.value)} value={spaceId} />
            )}
          </Field>
          <Field
            description="A readable page used only for the connection check."
            label="Health page ID"
            required
            size="compact"
          >
            {(controlProps) => (
              <input
                {...controlProps}
                onChange={(event) => setProbePageId(event.currentTarget.value)}
                value={probePageId}
              />
            )}
          </Field>
        </div>
      ) : null}
      {setupError === null ? null : (
        <Text as="p" className={styles.error} role="alert" variant="body">
          {setupError}
        </Text>
      )}
      <div className={styles.actions}>
        <Button disabled={isSubmitting} onClick={onCancel} type="button" variant="secondary">
          Cancel
        </Button>
        <Button loading={isSubmitting} type="submit" variant="primary">
          Connect Atlassian
        </Button>
      </div>
    </form>
  )
}

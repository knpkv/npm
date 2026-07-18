import { Button, Field, Text } from "@knpkv/rly/primitives"
import { type FormEvent, type ReactElement, useEffect, useState } from "react"

import type {
  AtlassianProfileDiscoveryResponse,
  DiscoveredAtlassianProfile,
  PluginServiceCatalogEntry
} from "../../api/plugins.js"
import styles from "./AtlassianAccountSetupForm.module.css"
import { type ServiceConnectionDraft, serviceSetupValues } from "./serviceSetupValues.js"

type AuthenticationMode = "oauth" | "api-token"

const selectedProfile = (
  profiles: AtlassianProfileDiscoveryResponse,
  profileId: string
): DiscoveredAtlassianProfile | undefined => profiles.find((profile) => profile.profileId === profileId)

const isSharedUsableProfile = (profile: DiscoveredAtlassianProfile): boolean =>
  profile.status === "valid" && profile.providers.includes("jira") && profile.providers.includes("confluence")

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
  onSubmit,
  profiles,
  profilesState
}: {
  readonly catalogs: ReadonlyArray<PluginServiceCatalogEntry>
  readonly isSubmitting: boolean
  readonly onCancel: () => void
  readonly onSubmit: (drafts: ReadonlyArray<ServiceConnectionDraft>) => Promise<boolean>
  readonly profiles: AtlassianProfileDiscoveryResponse
  readonly profilesState: "failed" | "idle" | "loading" | "ready"
}): ReactElement => {
  const jira = catalogs.find(({ providerId }) => providerId === "jira")
  const confluence = catalogs.find(({ providerId }) => providerId === "confluence")
  const [accountName, setAccountName] = useState("Atlassian workspace")
  const [authenticationMode, setAuthenticationMode] = useState<AuthenticationMode>("oauth")
  const [profileId, setProfileId] = useState("")
  const [siteUrl, setSiteUrl] = useState("")
  const [siteId, setSiteId] = useState("")
  const [spaceId, setSpaceId] = useState("")
  const [probePageId, setProbePageId] = useState("")
  const [email, setEmail] = useState("")
  const [apiToken, setApiToken] = useState("")
  const [setupError, setSetupError] = useState<string | null>(null)

  useEffect(() => {
    if (authenticationMode !== "oauth" || profileId.length > 0) return
    const firstSharedProfile = profiles.find(isSharedUsableProfile)
    if (firstSharedProfile !== undefined) setProfileId(firstSharedProfile.profileId)
  }, [authenticationMode, profileId, profiles])

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
    if (jira === undefined || confluence === undefined) {
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
      normalizedSiteId.length === 0 ||
      normalizedSpaceId.length === 0 ||
      normalizedProbePageId.length === 0
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
    if (authenticationMode === "oauth" && (oauthProfile === undefined || !isSharedUsableProfile(oauthProfile))) {
      setSetupError("Choose a valid profile shared by Jira and Confluence, or use an API token instead.")
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
      {
        catalog: jira,
        displayName: `${normalizedAccountName} · Jira`,
        values: serviceSetupValues(jira, overrides)
      },
      {
        catalog: confluence,
        displayName: `${normalizedAccountName} · Confluence`,
        values: serviceSetupValues(confluence, overrides)
      }
    ]
    void onSubmit(drafts).then((didCreate) => {
      if (!didCreate) setSetupError("Some Atlassian services could not be connected. Review the cards below and retry.")
    })
  }

  const discoveryMessage =
    profilesState === "loading"
      ? "Finding local Atlassian OAuth profiles…"
      : profilesState === "failed"
        ? "OAuth profile discovery is unavailable. API token fallback remains available."
        : profilesState === "ready"
          ? `${profiles.filter(isSharedUsableProfile).length} shared OAuth ${profiles.filter(isSharedUsableProfile).length === 1 ? "profile" : "profiles"} ready`
          : "OAuth profiles stay on this machine and are shared by Jira and Confluence."

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.intro}>
        <Text as="h3" variant="card-title">
          One identity. Jira and Confluence together.
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
          <Field label="OAuth profile" required size="compact">
            {(controlProps) => (
              <select {...controlProps} onChange={(event) => setProfileId(event.currentTarget.value)} value={profileId}>
                <option value="">Choose a local profile</option>
                {profiles.map((profile) => (
                  <option disabled={!isSharedUsableProfile(profile)} key={profile.profileId} value={profile.profileId}>
                    {profile.name} · {profileAvailability(profile)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Button onClick={() => setAuthenticationMode("api-token")} type="button" variant="quiet">
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

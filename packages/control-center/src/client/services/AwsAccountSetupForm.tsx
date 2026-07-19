import { Button, Field, StateLabel, Text } from "@knpkv/rly/primitives"
import { type FormEvent, type ReactElement, useEffect, useRef, useState } from "react"

import type {
  AwsProfileDiscoveryResponse,
  AwsResourceDiscoveryRequest,
  AwsResourceDiscoveryResponse,
  AwsServiceResourceDiscovery,
  PluginServiceCatalogEntry
} from "../../api/plugins.js"
import styles from "./AwsAccountSetupForm.module.css"
import { type ServiceConnectionDraft, serviceSetupValues } from "./serviceSetupValues.js"

const MAXIMUM_FOLLOWED_RESOURCES = 20

type ResourceDiscoveryState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly response: AwsResourceDiscoveryResponse }

const parseResourceNames = (input: string): ReadonlyArray<string> => [
  ...new Set(
    input
      .split(/[\n,]/u)
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
  )
]

const mergeResourceNames = (selected: ReadonlySet<string>, manual: string): ReadonlyArray<string> => [
  ...new Set([...selected, ...parseResourceNames(manual)])
]

/** Preserve explicit choices across refreshes, including temporarily undiscoverable names. */
export const refreshedAwsResourceChoices = (
  discovered: ReadonlyArray<string>,
  selected: ReadonlySet<string>
): ReadonlyArray<string> => [...new Set([...discovered, ...selected])].sort((left, right) => left.localeCompare(right))

/** Case-insensitive resource search used by both AWS service lists. */
export const searchAwsResourceNames = (names: ReadonlyArray<string>, query: string): ReadonlyArray<string> => {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return normalizedQuery.length === 0
    ? names
    : names.filter((name) => name.toLocaleLowerCase().includes(normalizedQuery))
}

const connectionDrafts = ({
  accountName,
  codeCommit,
  codePipeline,
  pipelineNames,
  profile,
  region,
  repositoryNames
}: {
  readonly accountName: string
  readonly codeCommit: PluginServiceCatalogEntry
  readonly codePipeline: PluginServiceCatalogEntry
  readonly pipelineNames: ReadonlyArray<string>
  readonly profile: string
  readonly region: string
  readonly repositoryNames: ReadonlyArray<string>
}): ReadonlyArray<ServiceConnectionDraft> => [
  ...repositoryNames.map((repositoryName) => ({
    catalog: codeCommit,
    displayName: `${accountName} · ${repositoryName}`,
    values: serviceSetupValues(
      codeCommit,
      new Map([
        ["profile", profile],
        ["region", region],
        ["repositoryName", repositoryName]
      ])
    )
  })),
  ...pipelineNames.map((pipelineName) => ({
    catalog: codePipeline,
    displayName: `${accountName} · ${pipelineName}`,
    values: serviceSetupValues(
      codePipeline,
      new Map([
        ["profile", profile],
        ["region", region],
        ["pipelineName", pipelineName]
      ])
    )
  }))
]

const profileDiscoveryMessage = (profileCount: number, state: "failed" | "idle" | "loading" | "ready"): string => {
  switch (state) {
    case "loading":
      return "Discovering local AWS profiles…"
    case "ready":
      return `${profileCount} local AWS ${profileCount === 1 ? "profile" : "profiles"} detected`
    case "failed":
      return "Profile discovery unavailable. Enter a profile manually."
    case "idle":
      return "AWS profiles are discovered locally by the Control Center server."
  }
}

const failureMessage = (service: "CodeCommit" | "CodePipeline", failureClass: string): string =>
  failureClass === "authorization"
    ? `${service} access was denied. Select names manually or update this profile's permissions.`
    : `${service} discovery is unavailable (${failureClass}). Select names manually or refresh.`

const ResourcePicker = ({
  label,
  query,
  selected,
  service,
  setQuery,
  setSelected
}: {
  readonly label: string
  readonly query: string
  readonly selected: ReadonlySet<string>
  readonly service: AwsServiceResourceDiscovery
  readonly setQuery: (query: string) => void
  readonly setSelected: (selected: ReadonlySet<string>) => void
}): ReactElement => {
  if (service._tag === "failed") {
    const preservedNames = [...selected].sort((left, right) => left.localeCompare(right))
    return (
      <div className={styles.resourcePanel}>
        <div className={styles.resourcePanelHeading}>
          <Text as="h4" variant="card-title">
            {label}
          </Text>
          <StateLabel label={`${selected.size} selected`} size="compact" tone="neutral" />
        </div>
        <Text as="p" className={styles.error} role="status" variant="body">
          {failureMessage(label === "Repositories" ? "CodeCommit" : "CodePipeline", service.failureClass)}
        </Text>
        {preservedNames.length === 0 ? null : (
          <>
            <Text tone="secondary" variant="meta">
              Preserved from the previous discovery. Clear any resource you no longer want to connect.
            </Text>
            <div className={styles.choiceList}>
              {preservedNames.map((name) => (
                <label className={styles.choice} key={name}>
                  <input
                    checked
                    onChange={() => {
                      const next = new Set(selected)
                      next.delete(name)
                      setSelected(next)
                    }}
                    type="checkbox"
                  />
                  <span>{name}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </div>
    )
  }
  const names = refreshedAwsResourceChoices(service.names, selected)
  const visibleNames = searchAwsResourceNames(names, query)
  return (
    <div className={styles.resourcePanel}>
      <div className={styles.resourcePanelHeading}>
        <Text as="h4" variant="card-title">
          {label}
        </Text>
        <StateLabel label={`${selected.size} selected`} size="compact" tone="neutral" />
      </div>
      {names.length === 0 ? (
        <Text tone="secondary" variant="body">
          No {label.toLocaleLowerCase()} were found in this region.
        </Text>
      ) : (
        <>
          <Field label={`Search ${label.toLocaleLowerCase()}`} size="compact">
            {(controlProps) => (
              <input
                {...controlProps}
                onChange={(event) => setQuery(event.currentTarget.value)}
                type="search"
                value={query}
              />
            )}
          </Field>
          <div className={styles.choiceList}>
            {visibleNames.map((name) => (
              <label className={styles.choice} key={name}>
                <input
                  checked={selected.has(name)}
                  onChange={(event) => {
                    const next = new Set(selected)
                    if (event.currentTarget.checked) next.add(name)
                    else next.delete(name)
                    setSelected(next)
                  }}
                  type="checkbox"
                />
                <span>{name}</span>
              </label>
            ))}
          </div>
          {visibleNames.length === 0 ? (
            <Text tone="secondary" variant="body">
              No matching resources.
            </Text>
          ) : null}
          {service.truncated ? (
            <Text tone="secondary" variant="meta">
              Showing the first 20 names. Use manual entry for another name.
            </Text>
          ) : null}
        </>
      )}
    </div>
  )
}

/** Configure one AWS account and the repositories and pipelines followed beneath it. */
export const AwsAccountSetupForm = ({
  awsProfiles,
  awsProfilesState,
  catalogs,
  isSubmitting,
  onCancel,
  onDiscover,
  onSubmit
}: {
  readonly awsProfiles: AwsProfileDiscoveryResponse
  readonly awsProfilesState: "failed" | "idle" | "loading" | "ready"
  readonly catalogs: ReadonlyArray<PluginServiceCatalogEntry>
  readonly isSubmitting: boolean
  readonly onCancel: () => void
  readonly onDiscover: (
    request: AwsResourceDiscoveryRequest,
    signal: AbortSignal
  ) => Promise<AwsResourceDiscoveryResponse>
  readonly onSubmit: (drafts: ReadonlyArray<ServiceConnectionDraft>) => Promise<boolean>
}): ReactElement => {
  const codeCommit = catalogs.find(({ providerId }) => providerId === "codecommit")
  const codePipeline = catalogs.find(({ providerId }) => providerId === "codepipeline")
  const [accountName, setAccountName] = useState("AWS account")
  const [profile, setProfile] = useState("default")
  const [region, setRegion] = useState("")
  const [repositoryNames, setRepositoryNames] = useState("")
  const [pipelineNames, setPipelineNames] = useState("")
  const [selectedRepositories, setSelectedRepositories] = useState<ReadonlySet<string>>(new Set())
  const [selectedPipelines, setSelectedPipelines] = useState<ReadonlySet<string>>(new Set())
  const [repositoryQuery, setRepositoryQuery] = useState("")
  const [pipelineQuery, setPipelineQuery] = useState("")
  const [isManualEntryOpen, setIsManualEntryOpen] = useState(true)
  const [discoveryState, setDiscoveryState] = useState<ResourceDiscoveryState>({ _tag: "idle" })
  const [setupError, setSetupError] = useState<string | null>(null)
  const discoveryRequest = useRef<AbortController | null>(null)

  useEffect(() => () => discoveryRequest.current?.abort(), [])

  useEffect(() => {
    const detectedRegion = awsProfiles.find((candidate) => candidate.profile === profile)?.region
    if (detectedRegion !== null && detectedRegion !== undefined) {
      setRegion((current) => (current.trim().length === 0 ? detectedRegion : current))
    }
  }, [awsProfiles, profile])

  const resetDiscovery = (): void => {
    discoveryRequest.current?.abort()
    discoveryRequest.current = null
    setDiscoveryState({ _tag: "idle" })
    setSelectedRepositories(new Set())
    setSelectedPipelines(new Set())
  }

  const discover = (): void => {
    setSetupError(null)
    const request = { profile: profile.trim(), region: region.trim() }
    if (request.profile.length === 0 || request.region.length === 0) {
      setSetupError("Add an AWS profile and region before testing discovery.")
      return
    }
    discoveryRequest.current?.abort()
    const controller = new AbortController()
    discoveryRequest.current = controller
    setDiscoveryState({ _tag: "loading" })
    onDiscover(request, controller.signal).then(
      (response) => {
        if (controller.signal.aborted) return
        discoveryRequest.current = null
        setDiscoveryState({ _tag: "ready", response })
      },
      () => {
        if (controller.signal.aborted) return
        discoveryRequest.current = null
        setDiscoveryState({ _tag: "failed" })
      }
    )
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setSetupError(null)
    if (codeCommit === undefined || codePipeline === undefined) {
      setSetupError("The installed AWS adapters are unavailable.")
      return
    }
    const normalizedAccountName = accountName.trim()
    const normalizedProfile = profile.trim()
    const normalizedRegion = region.trim()
    if (normalizedAccountName.length === 0 || normalizedProfile.length === 0 || normalizedRegion.length === 0) {
      setSetupError("Add an account name, AWS profile, and region.")
      return
    }
    const repositories = mergeResourceNames(selectedRepositories, isManualEntryOpen ? repositoryNames : "")
    const pipelines = mergeResourceNames(selectedPipelines, isManualEntryOpen ? pipelineNames : "")
    if (repositories.length === 0 && pipelines.length === 0) {
      setSetupError("Select or manually add at least one repository or pipeline to follow.")
      return
    }
    if (repositories.length > MAXIMUM_FOLLOWED_RESOURCES || pipelines.length > MAXIMUM_FOLLOWED_RESOURCES) {
      setSetupError(`Follow at most ${MAXIMUM_FOLLOWED_RESOURCES} repositories and pipelines per account.`)
      return
    }
    if ([...repositories, ...pipelines].some((name) => name.length > 100)) {
      setSetupError("Repository and pipeline names must be 100 characters or fewer.")
      return
    }
    const drafts = connectionDrafts({
      accountName: normalizedAccountName,
      codeCommit,
      codePipeline,
      pipelineNames: pipelines,
      profile: normalizedProfile,
      region: normalizedRegion,
      repositoryNames: repositories
    })
    void onSubmit(drafts).then((didCreate) => {
      if (!didCreate) setSetupError("Some AWS resources could not be connected. Review the cards below and retry.")
    })
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.intro}>
        <Text as="h3" variant="card-title">
          One account. Many delivery streams.
        </Text>
        <Text tone="secondary" variant="body">
          Choose one local AWS profile and region, verify its account, then select CodeCommit repositories and
          CodePipeline pipelines.
        </Text>
        <Text tone="secondary" variant="meta">
          {profileDiscoveryMessage(awsProfiles.length, awsProfilesState)}
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
      <Field label="AWS profile" required size="compact">
        {(controlProps) => (
          <input
            {...controlProps}
            list={awsProfiles.length > 0 ? "aws-account-profiles" : undefined}
            maxLength={200}
            onChange={(event) => {
              const nextProfile = event.currentTarget.value
              const detectedRegion = awsProfiles.find((candidate) => candidate.profile === nextProfile)?.region
              setProfile(nextProfile)
              setRegion(detectedRegion ?? "")
              resetDiscovery()
            }}
            value={profile}
          />
        )}
      </Field>
      <Field label="AWS region" required size="compact">
        {(controlProps) => (
          <input
            {...controlProps}
            maxLength={100}
            onChange={(event) => {
              setRegion(event.currentTarget.value)
              resetDiscovery()
            }}
            value={region}
          />
        )}
      </Field>
      <div className={styles.discoveryActions}>
        <Button loading={discoveryState._tag === "loading"} onClick={discover} type="button" variant="secondary">
          {discoveryState._tag === "ready" ? "Refresh discovery" : "Test & discover"}
        </Button>
        {discoveryState._tag === "ready" ? (
          <Text tone="secondary" variant="body">
            Verified AWS account {discoveryState.response.accountId}
          </Text>
        ) : discoveryState._tag === "failed" ? (
          <Text as="p" className={styles.error} role="alert" variant="body">
            Account verification failed. Check the profile and region, or enter resource names manually.
          </Text>
        ) : null}
      </div>
      {discoveryState._tag === "ready" ? (
        <div className={styles.resources}>
          <ResourcePicker
            label="Repositories"
            query={repositoryQuery}
            selected={selectedRepositories}
            service={discoveryState.response.codeCommit}
            setQuery={setRepositoryQuery}
            setSelected={setSelectedRepositories}
          />
          <ResourcePicker
            label="Pipelines"
            query={pipelineQuery}
            selected={selectedPipelines}
            service={discoveryState.response.codePipeline}
            setQuery={setPipelineQuery}
            setSelected={setSelectedPipelines}
          />
        </div>
      ) : null}
      <div>
        <Button onClick={() => setIsManualEntryOpen((current) => !current)} type="button" variant="quiet">
          {isManualEntryOpen ? "Hide manual name entry" : "Enter resource names manually"}
        </Button>
      </div>
      {isManualEntryOpen ? (
        <div className={styles.resources}>
          <Field
            description="Comma or line separated. Maximum 20 including selected names."
            label="Repository names"
            size="compact"
          >
            {(controlProps) => (
              <textarea
                {...controlProps}
                maxLength={4_096}
                onChange={(event) => setRepositoryNames(event.currentTarget.value)}
                placeholder="payments-api\nrisk-engine"
                value={repositoryNames}
              />
            )}
          </Field>
          <Field
            description="Comma or line separated. Maximum 20 including selected names."
            label="Pipeline names"
            size="compact"
          >
            {(controlProps) => (
              <textarea
                {...controlProps}
                maxLength={4_096}
                onChange={(event) => setPipelineNames(event.currentTarget.value)}
                placeholder="payments-production\nrisk-production"
                value={pipelineNames}
              />
            )}
          </Field>
        </div>
      ) : null}
      {awsProfiles.length > 0 ? (
        <datalist id="aws-account-profiles">
          {awsProfiles.map((candidate) => (
            <option
              key={candidate.profile}
              label={candidate.region ?? "Region not configured"}
              value={candidate.profile}
            />
          ))}
        </datalist>
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
          Connect AWS account
        </Button>
      </div>
    </form>
  )
}

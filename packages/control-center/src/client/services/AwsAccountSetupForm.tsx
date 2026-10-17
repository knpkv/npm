import { Button, Notice, StateLabel, Text } from "@knpkv/rly/primitives"
import type { RlyStateTone } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import * as Predicate from "effect/Predicate"
import { type FormEvent, type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from "react"

import type {
  AwsProfileDiscoveryResponse,
  AwsRegionDiscoveryResponse,
  AwsResourceDiscoveryRequest,
  AwsResourceDiscoveryResponse,
  AwsServiceResourceDiscovery,
  PluginServiceCatalogEntry
} from "../../api/plugins.js"
import { COMPACT_VIEWPORT_QUERY, useMediaQuery } from "../useMediaQuery.js"
import styles from "./AwsAccountSetupForm.module.css"
import { type ServiceConnectionDraft, serviceSetupValues } from "./serviceSetupValues.js"

const MAXIMUM_FOLLOWED_RESOURCES = 20

type ResourceDiscoveryState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly reason: "sign-in-required" | "no-answer"; readonly profile: string }
  | { readonly _tag: "profile-not-found"; readonly profile: string }
  | {
      readonly _tag: "ready"
      readonly checkedAt: DateTime.Utc
      readonly profile: string
      readonly region: string
      readonly response: AwsResourceDiscoveryResponse
    }

/**
 * Where the region comes from. `list` offers the account's enabled regions; `typed` is the fallback when the
 * profile can't list them (denied, unreachable, or no detected profiles), so the region is entered by hand.
 */
type RegionSource =
  | { readonly _tag: "loading"; readonly profile: string }
  | { readonly _tag: "list"; readonly profile: string; readonly regions: ReadonlyArray<string> }
  | { readonly _tag: "typed" }

type FieldErrors = {
  readonly accountName?: string
  readonly profile?: string
  readonly region?: string
}

/** The account check's rejection, read only by tag: a profile whose sign-in expired, or anything else. */
const discoveryFailureReason = <Rejection,>(failure: Rejection): "sign-in-required" | "no-answer" =>
  Predicate.isTagged(failure, "AwsSignInRequiredApiError") ? "sign-in-required" : "no-answer"

const isEmptyDiscovery = ({ codeCommit, codePipeline }: AwsResourceDiscoveryResponse): boolean =>
  codeCommit._tag === "available" &&
  codeCommit.names.length === 0 &&
  codePipeline._tag === "available" &&
  codePipeline.names.length === 0

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

/**
 * The region the region select lands on once the enabled regions arrive: the region already chosen when the
 * account has it enabled (a typed and verified region never flips), otherwise the profile's configured region
 * when it is enabled, otherwise the first enabled region.
 */
export const initialAwsRegion = (
  regions: ReadonlyArray<string>,
  configured: string | null | undefined,
  current: string
): string =>
  regions.includes(current)
    ? current
    : configured !== null && configured !== undefined && regions.includes(configured)
      ? configured
      : (regions[0] ?? current)

/** The count beside a resource list: discovery returns at most 20 names and only says whether more exist. */
export const awsResourceListCount = (shown: number, truncated: boolean): string =>
  truncated ? `First ${shown} shown` : `${shown} of ${shown} shown`

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

type DiscoveryFailure = Extract<AwsServiceResourceDiscovery, { readonly _tag: "failed" }>

/** One sentence per failure: what went wrong for this service and profile, and what to do next. */
export const discoveryFailureMessage = (
  service: "CodeCommit" | "CodePipeline",
  profile: string,
  failure: DiscoveryFailure
): string => {
  switch (failure.failureClass) {
    case "authentication":
      return `Can’t sign in to ${service} with ${profile}. Check this profile’s credentials or sign-in session, then refresh.`
    case "authorization":
      return `${profile} isn’t allowed to list ${service} resources. Enter names manually or update the profile’s permissions.`
    case "rate-limit":
      return `AWS is limiting ${service} requests. Wait a minute, then refresh.`
    case "timeout":
      return `${service} didn’t answer in time. Refresh to try again.`
    case "malformed-response":
      return `${service} sent a response Control Center can’t read. Enter names manually.`
    case "unavailable":
      return `${service} couldn’t be reached. Refresh to try again, or enter names manually.`
  }
}

/** The word and tone that tag a failure row; the message carries the detail. */
interface DiscoveryFailureTag {
  readonly label: string
  readonly tone: RlyStateTone
}

const discoveryFailureTag = (failure: DiscoveryFailure): DiscoveryFailureTag => {
  switch (failure.failureClass) {
    case "authentication":
      return { label: "Sign-in failed", tone: "critical" }
    case "authorization":
      return { label: "Not allowed", tone: "critical" }
    case "rate-limit":
      return { label: "Rate-limited", tone: "caution" }
    case "timeout":
      return { label: "Timed out", tone: "caution" }
    case "malformed-response":
      return { label: "Unreadable", tone: "critical" }
    case "unavailable":
      return { label: "Unavailable", tone: "critical" }
  }
}

/** The organization-policy message, worded as a possible region cause, never a proven one. */
export const organizationPolicyDeniedMessage = (region: string): string =>
  `An organization policy blocks CodeCommit in ${region}, and CodePipeline was denied too. This region may not be allowed for this account; choose another.`

/**
 * One labelled control in the design's order: label, control, then the error (with an "Invalid" label), then
 * the hint. The control receives its id and description wiring through `children`.
 */
const SetupField = ({
  children,
  error,
  hint,
  label
}: {
  readonly children: (control: {
    readonly "aria-describedby": string | undefined
    readonly "aria-invalid": true | undefined
    readonly id: string
  }) => ReactNode
  readonly error?: string | undefined
  readonly hint?: string | undefined
  readonly label: string
}): ReactElement => {
  const id = useId()
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [error === undefined ? null : errorId, hint === undefined ? null : hintId]
    .filter((value): value is string => value !== null)
    .join(" ")
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      {children({
        "aria-describedby": describedBy.length === 0 ? undefined : describedBy,
        "aria-invalid": error === undefined ? undefined : true,
        id
      })}
      {error === undefined ? null : (
        <span className={styles.fieldError} id={errorId} role="alert">
          <StateLabel label="Invalid" size="compact" tone="critical" />
          <span>{error}</span>
        </span>
      )}
      {hint === undefined ? null : (
        <span className={styles.fieldHint} id={hintId}>
          {hint}
        </span>
      )}
    </div>
  )
}

const ResourceList = ({
  label,
  selected,
  service,
  setSelected
}: {
  readonly label: string
  readonly selected: ReadonlySet<string>
  /** This check's answer for the service; null when the check itself failed. */
  readonly service: AwsServiceResourceDiscovery | null
  readonly setSelected: (selected: ReadonlySet<string>) => void
}): ReactElement | null => {
  // A service (or a whole check) that failed this time still lists what was already selected, so every name
  // "Follow N" counts stays visible and can be cleared.
  const names = refreshedAwsResourceChoices(service?._tag === "available" ? service.names : [], selected)
  if (names.length === 0) return null
  return (
    <div className={styles.list}>
      <div className={styles.listHeading}>
        <Text as="h3" variant="label">
          {label}
        </Text>
        <span className={styles.listCount}>
          {service?._tag === "available"
            ? awsResourceListCount(service.names.length, service.truncated)
            : "Kept from the last check"}
        </span>
      </div>
      <ul className={styles.choices}>
        {names.map((name) => (
          <li key={name}>
            <label className={styles.choice}>
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
              {name}
            </label>
          </li>
        ))}
      </ul>
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
  onDiscoverRegions,
  onReloadAwsProfiles,
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
  /** Lists the chosen profile's enabled regions; any rejection falls back to a typed region. */
  readonly onDiscoverRegions: (profile: string, signal: AbortSignal) => Promise<AwsRegionDiscoveryResponse>
  /** Reads this machine's AWS profiles again and returns them; called before refusing a profile the list lacks. */
  readonly onReloadAwsProfiles: (signal: AbortSignal) => Promise<AwsProfileDiscoveryResponse>
  readonly onSubmit: (drafts: ReadonlyArray<ServiceConnectionDraft>) => Promise<boolean>
}): ReactElement => {
  const codeCommit = catalogs.find(({ providerId }) => providerId === "codecommit")
  const codePipeline = catalogs.find(({ providerId }) => providerId === "codepipeline")
  const profilesListed = awsProfilesState === "ready" && awsProfiles.length > 0
  // Phone gets touch-size buttons, as the field controls do.
  const buttonSize = useMediaQuery(COMPACT_VIEWPORT_QUERY, false) ? "default" : "dense"
  const [accountName, setAccountName] = useState("AWS account")
  const [profile, setProfile] = useState("default")
  const [region, setRegion] = useState("")
  const [regionSource, setRegionSource] = useState<RegionSource>({ _tag: "typed" })
  const [repositoryNames, setRepositoryNames] = useState("")
  const [pipelineNames, setPipelineNames] = useState("")
  const [selectedRepositories, setSelectedRepositories] = useState<ReadonlySet<string>>(new Set())
  const [selectedPipelines, setSelectedPipelines] = useState<ReadonlySet<string>>(new Set())
  const [isManualEntryOpen, setIsManualEntryOpen] = useState(false)
  const [discoveryState, setDiscoveryState] = useState<ResourceDiscoveryState>({ _tag: "idle" })
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [setupError, setSetupError] = useState<string | null>(null)
  const discoveryRequest = useRef<AbortController | null>(null)
  // The region the current discovery (in flight or done) checked; its results only hold for that region.
  const discoveredRegion = useRef<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  // Bumped when validation stops an action, so focus moves to the first invalid field after it renders.
  const [invalidFocus, setInvalidFocus] = useState(0)

  useEffect(() => () => discoveryRequest.current?.abort(), [])

  useEffect(() => {
    if (invalidFocus === 0) return
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [invalidFocus])

  // Once profiles are detected the select can only hold a detected one: keep the current profile when it is
  // listed, otherwise start on "default" when it exists, otherwise the first.
  useEffect(() => {
    if (!profilesListed) return
    setProfile((current) =>
      awsProfiles.some((candidate) => candidate.profile === current)
        ? current
        : ((awsProfiles.find((candidate) => candidate.profile === "default") ?? awsProfiles[0])?.profile ?? current)
    )
  }, [awsProfiles, profilesListed])

  // The chosen profile's enabled regions. Only a detected profile is asked; a typed one is never looked up per
  // keystroke, so its region is typed too.
  useEffect(() => {
    const configured = awsProfiles.find((candidate) => candidate.profile === profile)?.region
    if (!profilesListed || configured === undefined) {
      setRegionSource({ _tag: "typed" })
      if (configured !== undefined && configured !== null) {
        setRegion((current) => (current.trim().length === 0 ? configured : current))
      }
      return
    }
    const controller = new AbortController()
    setRegionSource({ _tag: "loading", profile })
    onDiscoverRegions(profile, controller.signal).then(
      (answer) => {
        if (controller.signal.aborted) return
        if (answer._tag === "available" && answer.regions.length > 0) {
          setRegionSource({ _tag: "list", profile, regions: answer.regions })
          setRegion((current) => initialAwsRegion(answer.regions, configured, current))
          return
        }
        setRegionSource({ _tag: "typed" })
        setRegion((current) => (current.trim().length > 0 ? current : (configured ?? "")))
      },
      () => {
        if (controller.signal.aborted) return
        setRegionSource({ _tag: "typed" })
        setRegion((current) => (current.trim().length > 0 ? current : (configured ?? "")))
      }
    )
    return () => controller.abort()
  }, [awsProfiles, onDiscoverRegions, profile, profilesListed])

  const resetDiscovery = (): void => {
    discoveryRequest.current?.abort()
    discoveryRequest.current = null
    discoveredRegion.current = null
    setDiscoveryState({ _tag: "idle" })
    setSelectedRepositories(new Set())
    setSelectedPipelines(new Set())
  }

  // However the region changed (the user, or the enabled-region lookup), a discovery for another region and its
  // selections no longer describe what Follow would connect.
  useEffect(() => {
    if (discoveredRegion.current !== null && discoveredRegion.current !== region.trim()) resetDiscovery()
  }, [region])

  const requiredFieldErrors = (): FieldErrors => ({
    ...(accountName.trim().length === 0 && { accountName: "Add an account name." }),
    ...(profile.trim().length === 0 && { profile: "Choose an AWS profile." }),
    ...(region.trim().length === 0 && { region: "Add an AWS region." })
  })

  const discover = (): void => {
    setSetupError(null)
    const errors = requiredFieldErrors()
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      setInvalidFocus((count) => count + 1)
      return
    }
    const request = { profile: profile.trim(), region: region.trim() }
    discoveredRegion.current = request.region
    discoveryRequest.current?.abort()
    const controller = new AbortController()
    discoveryRequest.current = controller
    setDiscoveryState({ _tag: "loading" })
    const hasProfile = (profiles: AwsProfileDiscoveryResponse): boolean =>
      profiles.some((candidate) => candidate.profile === request.profile)
    // The list was read when the form opened. Read it again before refusing, so a profile added since counts;
    // when that read fails, AWS decides.
    const profileExists =
      awsProfilesState !== "ready" || hasProfile(awsProfiles)
        ? Promise.resolve(true)
        : onReloadAwsProfiles(controller.signal).then(hasProfile, () => true)
    void profileExists.then((exists) => {
      if (controller.signal.aborted) return
      if (exists) return runDiscovery(request, controller)
      discoveryRequest.current = null
      setDiscoveryState({ _tag: "profile-not-found", profile: request.profile })
    })
  }

  const runDiscovery = (request: AwsResourceDiscoveryRequest, controller: AbortController): void => {
    onDiscover(request, controller.signal).then(
      (response) => {
        if (controller.signal.aborted) return
        discoveryRequest.current = null
        setDiscoveryState({
          _tag: "ready",
          checkedAt: DateTime.nowUnsafe(),
          profile: request.profile,
          region: request.region,
          response
        })
      },
      <Rejection,>(failure: Rejection) => {
        if (controller.signal.aborted) return
        discoveryRequest.current = null
        setDiscoveryState({ _tag: "failed", reason: discoveryFailureReason(failure), profile: request.profile })
      }
    )
  }

  const followed = {
    pipelines: mergeResourceNames(selectedPipelines, isManualEntryOpen ? pipelineNames : ""),
    repositories: mergeResourceNames(selectedRepositories, isManualEntryOpen ? repositoryNames : "")
  }
  const followedCount = followed.repositories.length + followed.pipelines.length

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setSetupError(null)
    if (codeCommit === undefined || codePipeline === undefined) {
      setSetupError("The installed AWS adapters are unavailable.")
      return
    }
    const errors = requiredFieldErrors()
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      setInvalidFocus((count) => count + 1)
      return
    }
    if (followedCount === 0) {
      setSetupError("Select or manually add at least one repository or pipeline to follow.")
      return
    }
    if (
      followed.repositories.length > MAXIMUM_FOLLOWED_RESOURCES ||
      followed.pipelines.length > MAXIMUM_FOLLOWED_RESOURCES
    ) {
      setSetupError(`Follow at most ${MAXIMUM_FOLLOWED_RESOURCES} repositories and pipelines per account.`)
      return
    }
    if ([...followed.repositories, ...followed.pipelines].some((name) => name.length > 100)) {
      setSetupError("Repository and pipeline names must be 100 characters or fewer.")
      return
    }
    const drafts = connectionDrafts({
      accountName: accountName.trim(),
      codeCommit,
      codePipeline,
      pipelineNames: followed.pipelines,
      profile: profile.trim(),
      region: region.trim(),
      repositoryNames: followed.repositories
    })
    void onSubmit(drafts).then((didCreate) => {
      if (!didCreate) setSetupError("Some AWS resources could not be connected. Review the cards below and retry.")
    })
  }

  const ready = discoveryState._tag === "ready" ? discoveryState : null
  const policyDenied = ready?.response.organizationPolicyDenied === true
  const services: ReadonlyArray<{
    readonly outcome: AwsServiceResourceDiscovery
    readonly service: "CodeCommit" | "CodePipeline"
  }> =
    ready === null || policyDenied
      ? []
      : [
          { outcome: ready.response.codeCommit, service: "CodeCommit" },
          { outcome: ready.response.codePipeline, service: "CodePipeline" }
        ]
  const failedServices = services.flatMap(({ outcome, service }) =>
    outcome._tag === "failed" ? [{ outcome, service }] : []
  )
  const checkFailed = discoveryState._tag === "failed" && discoveryState.reason === "no-answer"
  const discoveryLabel =
    checkFailed || policyDenied || failedServices.length > 0 ? "Refresh discovery" : "Test & discover"
  const errorTone = checkFailed || policyDenied || failedServices.length > 0
  const isLoadingProfiles = awsProfilesState === "loading"
  const regionError =
    fieldErrors.region ?? (policyDenied && ready !== null ? organizationPolicyDeniedMessage(ready.region) : undefined)
  const profileNotFound = discoveryState._tag === "profile-not-found" ? discoveryState : null
  const signInProfile =
    discoveryState._tag === "failed" && discoveryState.reason === "sign-in-required" ? discoveryState.profile : null

  // A detected profile brings its configured region; a typed one keeps the region already typed.
  const changeProfile = (nextProfile: string): void => {
    const configured = awsProfiles.find((candidate) => candidate.profile === nextProfile)?.region
    setProfile(nextProfile)
    if (configured !== undefined && configured !== null) setRegion(configured)
    setFieldErrors(({ profile: _profile, ...rest }) => rest)
    resetDiscovery()
  }

  const changeRegion = (nextRegion: string): void => {
    setRegion(nextRegion)
    setFieldErrors(({ region: _region, ...rest }) => rest)
    resetDiscovery()
  }

  // A policy denial is the outcome to act on, so the verified notice stays out of its way.
  const verifiedNotice =
    ready === null || policyDenied ? null : (
      <Notice tone="positive">
        {ready.profile} verified in {ready.region} at{" "}
        <time dateTime={DateTime.formatIso(ready.checkedAt)}>
          {DateTime.formatUtc(ready.checkedAt, {
            hour: "2-digit",
            hour12: false,
            locale: "en-GB",
            minute: "2-digit",
            timeZoneName: "short"
          })}
        </time>
        . Account details masked.
      </Notice>
    )

  return (
    <form className={styles.form} noValidate onSubmit={submit} ref={form}>
      <div className={styles.fields}>
        <SetupField
          error={fieldErrors.accountName}
          hint={fieldErrors.accountName === undefined ? "Shown in Control Center only." : undefined}
          label="Account name"
        >
          {(control) => (
            <input
              {...control}
              className={styles.control}
              maxLength={90}
              onChange={(event) => {
                setAccountName(event.currentTarget.value)
                setFieldErrors(({ accountName: _accountName, ...rest }) => rest)
              }}
              value={accountName}
            />
          )}
        </SetupField>
        {isLoadingProfiles ? (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>AWS profile</span>
            <div className={styles.fieldStatus} role="status">
              <StateLabel label="Discovering local AWS profiles…" size="compact" tone="progress" />
            </div>
          </div>
        ) : profilesListed && profileNotFound === null ? (
          <SetupField
            error={fieldErrors.profile}
            hint="From this computer’s AWS configuration. Credentials stay there."
            label="AWS profile"
          >
            {(control) => (
              <select
                {...control}
                className={`${styles.control} ${styles.mono}`}
                onChange={(event) => changeProfile(event.currentTarget.value)}
                value={profile}
              >
                {awsProfiles.map((candidate) => (
                  <option key={candidate.profile} value={candidate.profile}>
                    {candidate.profile}
                  </option>
                ))}
              </select>
            )}
          </SetupField>
        ) : (
          <SetupField
            error={
              profileNotFound === null
                ? fieldErrors.profile
                : `No AWS profile named ${profileNotFound.profile} on this machine. Choose a detected profile, or add it to your AWS config, then test again.`
            }
            hint={
              profileNotFound !== null && awsProfiles.length > 0
                ? `Detected on this machine: ${awsProfiles.map((candidate) => candidate.profile).join(", ")}.`
                : profileNotFound === null
                  ? "No AWS profiles found on this machine. Type a profile name from your AWS config."
                  : undefined
            }
            label="AWS profile"
          >
            {(control) => (
              <input
                {...control}
                autoComplete="off"
                className={`${styles.control} ${styles.mono}`}
                maxLength={200}
                onChange={(event) => changeProfile(event.currentTarget.value)}
                value={profile}
              />
            )}
          </SetupField>
        )}
        {regionSource._tag === "loading" ? (
          <SetupField hint="Regions this account has enabled." label="AWS region">
            {(control) => (
              <select {...control} className={`${styles.control} ${styles.mono}`} disabled value="loading">
                <option value="loading">Reading enabled regions…</option>
              </select>
            )}
          </SetupField>
        ) : regionSource._tag === "list" ? (
          <SetupField error={regionError} label="AWS region">
            {(control) => (
              <select
                {...control}
                className={`${styles.control} ${styles.mono}`}
                onChange={(event) => changeRegion(event.currentTarget.value)}
                value={region}
              >
                {regionSource.regions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </SetupField>
        ) : (
          <SetupField
            error={regionError}
            hint={
              profilesListed
                ? "This profile can’t list the account’s regions, so type one."
                : "Type the region to check."
            }
            label="AWS region"
          >
            {(control) => (
              <input
                {...control}
                autoComplete="off"
                className={`${styles.control} ${styles.mono}`}
                maxLength={100}
                onChange={(event) => changeRegion(event.currentTarget.value)}
                value={region}
              />
            )}
          </SetupField>
        )}
      </div>
      {isLoadingProfiles ? (
        <p className={styles.note}>
          Test & discover is offered once a profile is found. You can still enter resource names manually.
        </p>
      ) : null}
      {checkFailed ? (
        <Notice announce="assertive" tone="critical">
          AWS didn’t answer the account check. Test again; if it keeps failing, check this machine’s network.
        </Notice>
      ) : null}
      {failedServices.length === 0 ? null : (
        <ul className={styles.messages}>
          {failedServices.map(({ outcome, service }) => {
            const tag = discoveryFailureTag(outcome)
            return (
              <li key={service}>
                <StateLabel label={tag.label} size="compact" tone={tag.tone} />
                <span>{discoveryFailureMessage(service, ready?.profile ?? profile.trim(), outcome)}</span>
              </li>
            )
          })}
        </ul>
      )}
      <div className={styles.buttons}>
        {isLoadingProfiles ? null : (
          <Button
            size={buttonSize}
            disabled={regionSource._tag === "loading"}
            loading={discoveryState._tag === "loading"}
            onClick={discover}
            type="button"
            variant="primary"
          >
            {discoveryLabel}
          </Button>
        )}
        <Button
          size={buttonSize}
          aria-expanded={isManualEntryOpen}
          onClick={() => setIsManualEntryOpen((current) => !current)}
          type="button"
          variant={errorTone ? "secondary" : "quiet"}
        >
          {isManualEntryOpen ? "Hide manual name entry" : "Enter resource names manually"}
        </Button>
        {followedCount > 0 ? null : (
          <Button size={buttonSize} disabled={isSubmitting} onClick={onCancel} type="button" variant="quiet">
            Cancel
          </Button>
        )}
      </div>
      {signInProfile === null ? null : (
        <Notice announce="assertive" tone="critical">
          {awsProfiles.some((candidate) => candidate.profile === signInProfile && candidate.sso === true) ? (
            <span>
              Sign-in for {signInProfile} has expired. Run{" "}
              <code className={styles.command}>aws sso login --profile {signInProfile}</code> in a terminal on this
              machine, then test again.
            </span>
          ) : (
            `The credentials for ${signInProfile} were refused. Renew them in your AWS config, then test again.`
          )}
        </Notice>
      )}
      {verifiedNotice}
      {ready !== null && !policyDenied && isEmptyDiscovery(ready.response) ? (
        <p className={styles.note}>
          No CodeCommit repositories or CodePipeline pipelines in {ready.region} for this account. Try another region,
          or add names manually.
        </p>
      ) : null}
      {ready === null || policyDenied ? (
        <>
          <ResourceList
            label="Repository names"
            selected={selectedRepositories}
            service={null}
            setSelected={setSelectedRepositories}
          />
          <ResourceList
            label="Pipeline names"
            selected={selectedPipelines}
            service={null}
            setSelected={setSelectedPipelines}
          />
        </>
      ) : (
        <>
          <ResourceList
            label="Repository names"
            selected={selectedRepositories}
            service={ready.response.codeCommit}
            setSelected={setSelectedRepositories}
          />
          {ready.response.codeCommit._tag === "available" && ready.response.codeCommit.truncated ? (
            <p className={styles.note}>More repositories may exist. Enter their names manually to follow them.</p>
          ) : null}
          <ResourceList
            label="Pipeline names"
            selected={selectedPipelines}
            service={ready.response.codePipeline}
            setSelected={setSelectedPipelines}
          />
          {ready.response.codePipeline._tag === "available" && ready.response.codePipeline.truncated ? (
            <p className={styles.note}>More pipelines may exist. Enter their names manually to follow them.</p>
          ) : null}
        </>
      )}
      {isManualEntryOpen ? (
        <div className={styles.manual}>
          <SetupField hint="Comma or line separated. Up to 20 including selected names." label="Repository names">
            {(control) => (
              <textarea
                {...control}
                className={`${styles.control} ${styles.area} ${styles.mono}`}
                maxLength={4_096}
                onChange={(event) => setRepositoryNames(event.currentTarget.value)}
                rows={2}
                value={repositoryNames}
              />
            )}
          </SetupField>
          <SetupField hint="Comma or line separated. Up to 20 including selected names." label="Pipeline names">
            {(control) => (
              <textarea
                {...control}
                className={`${styles.control} ${styles.area} ${styles.mono}`}
                maxLength={4_096}
                onChange={(event) => setPipelineNames(event.currentTarget.value)}
                rows={2}
                value={pipelineNames}
              />
            )}
          </SetupField>
        </div>
      ) : null}
      {setupError === null ? null : (
        <Notice announce="assertive" tone="critical">
          {setupError}
        </Notice>
      )}
      {followedCount === 0 ? null : (
        <div className={styles.buttons}>
          <Button size={buttonSize} loading={isSubmitting} type="submit" variant="primary">
            {`Follow ${followedCount} ${followedCount === 1 ? "resource" : "resources"}`}
          </Button>
          <Button size={buttonSize} disabled={isSubmitting} onClick={onCancel} type="button" variant="quiet">
            Cancel
          </Button>
        </div>
      )}
    </form>
  )
}

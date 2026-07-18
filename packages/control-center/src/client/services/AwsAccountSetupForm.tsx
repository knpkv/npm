import { Button, Field, Text } from "@knpkv/rly/primitives"
import { type FormEvent, type ReactElement, useEffect, useState } from "react"

import type { AwsProfileDiscoveryResponse, PluginServiceCatalogEntry } from "../../api/plugins.js"
import styles from "./AwsAccountSetupForm.module.css"
import { type ServiceConnectionDraft, serviceSetupValues } from "./serviceSetupValues.js"

const MAXIMUM_FOLLOWED_RESOURCES = 20

const parseResourceNames = (input: string): ReadonlyArray<string> => [
  ...new Set(
    input
      .split(/[\n,]/u)
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
  )
]

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

const discoveryMessage = (profileCount: number, state: "failed" | "idle" | "loading" | "ready"): string => {
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

/** Configure one AWS account and the repositories and pipelines followed beneath it. */
export const AwsAccountSetupForm = ({
  awsProfiles,
  awsProfilesState,
  catalogs,
  isSubmitting,
  onCancel,
  onSubmit
}: {
  readonly awsProfiles: AwsProfileDiscoveryResponse
  readonly awsProfilesState: "failed" | "idle" | "loading" | "ready"
  readonly catalogs: ReadonlyArray<PluginServiceCatalogEntry>
  readonly isSubmitting: boolean
  readonly onCancel: () => void
  readonly onSubmit: (drafts: ReadonlyArray<ServiceConnectionDraft>) => Promise<boolean>
}): ReactElement => {
  const codeCommit = catalogs.find(({ providerId }) => providerId === "codecommit")
  const codePipeline = catalogs.find(({ providerId }) => providerId === "codepipeline")
  const [accountName, setAccountName] = useState("AWS account")
  const [profile, setProfile] = useState("default")
  const [region, setRegion] = useState("")
  const [repositoryNames, setRepositoryNames] = useState("")
  const [pipelineNames, setPipelineNames] = useState("")
  const [setupError, setSetupError] = useState<string | null>(null)

  useEffect(() => {
    const detectedRegion = awsProfiles.find((candidate) => candidate.profile === profile)?.region
    if (detectedRegion !== null && detectedRegion !== undefined) setRegion(detectedRegion)
  }, [awsProfiles, profile])

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
    const repositories = parseResourceNames(repositoryNames)
    const pipelines = parseResourceNames(pipelineNames)
    if (repositories.length === 0 && pipelines.length === 0) {
      setSetupError("Add at least one repository or pipeline to follow.")
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
          Choose one local AWS profile, then list every CodeCommit repository and CodePipeline pipeline this workspace
          follows.
        </Text>
        <Text tone="secondary" variant="meta">
          {discoveryMessage(awsProfiles.length, awsProfilesState)}
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
            onChange={(event) => setProfile(event.currentTarget.value)}
            value={profile}
          />
        )}
      </Field>
      <Field label="AWS region" required size="compact">
        {(controlProps) => (
          <input
            {...controlProps}
            maxLength={100}
            onChange={(event) => setRegion(event.currentTarget.value)}
            value={region}
          />
        )}
      </Field>
      <div className={styles.resources}>
        <Field description="Comma or line separated. Maximum 20." label="Repositories" size="compact">
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
        <Field description="Comma or line separated. Maximum 20." label="Pipelines" size="compact">
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

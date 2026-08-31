/** Controlled review controls and retained-result status. @module */
import { Field, StateLabel } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import type { ReviewExecutionProfile } from "./model.js"
import type { ReviewResultPresentation } from "./runtime.js"

export interface ReviewProfileControlProps {
  readonly accessibleName?: string
  readonly className?: string
  readonly describeProfile?: (profile: ReviewExecutionProfile) => string
  readonly disabled?: boolean
  readonly groupName?: string
  readonly label?: string
  readonly onProfileChange: (profile: ReviewExecutionProfile) => void
  readonly presentation?: "radios" | "select"
  readonly profiles: ReadonlyArray<ReviewExecutionProfile>
  readonly selectedProfileId: string | null
}

/** One profile owns kind, skills, provider, harness, and model; callers cannot create a mixed selection. */
export const ReviewProfileControl = ({
  accessibleName,
  className,
  describeProfile = (profile) => `${profile.provider} · ${profile.model}`,
  disabled = false,
  groupName = "review-profile",
  label = "Profile",
  onProfileChange,
  presentation = "select",
  profiles,
  selectedProfileId
}: ReviewProfileControlProps): ReactElement => {
  const selected = profiles.find(({ id }) => id === selectedProfileId)
  if (presentation === "radios") {
    return (
      <fieldset aria-label={accessibleName ?? label} className={className} disabled={disabled}>
        {profiles.map((profile) => (
          <label key={profile.id}>
            <input
              checked={profile.id === selectedProfileId}
              name={groupName}
              onChange={() => onProfileChange(profile)}
              type="radio"
              value={profile.id}
            />
            <span>
              <strong>{profile.name}</strong>
              <small>{describeProfile(profile)}</small>
            </span>
          </label>
        ))}
      </fieldset>
    )
  }
  return (
    <Field
      {...(className === undefined ? {} : { className })}
      {...(selected === undefined ? {} : { description: describeProfile(selected) })}
      label={label}
      size="compact"
    >
      {(controlProps) => (
        <select
          {...controlProps}
          disabled={disabled || profiles.length === 0}
          onChange={(event) => {
            const profile = profiles.find(({ id }) => id === event.currentTarget.value)
            if (profile !== undefined) onProfileChange(profile)
          }}
          value={selectedProfileId ?? ""}
        >
          {selectedProfileId === null ? <option value="">Select a profile</option> : null}
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}

export const ReviewResultStatus = <Result,>({
  presentation
}: {
  readonly presentation: ReviewResultPresentation<Result>
}): ReactElement | null => {
  switch (presentation._tag) {
    case "Empty":
      return null
    case "Current":
      return <StateLabel label={presentation.completed.profile.name} size="compact" tone="progress" />
    case "Previous":
      return <StateLabel label="Previous result" size="compact" tone="caution" />
    case "Stale":
      return <StateLabel label="Earlier revision" size="compact" tone="caution" />
  }
}

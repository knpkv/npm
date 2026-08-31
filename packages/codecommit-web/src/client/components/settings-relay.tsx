/** Relay review profiles and environment skill selection. @module */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  reviewHarnessOptions,
  reviewKindOptions,
  reviewModelOptions,
  reviewProviderOptions,
  type ReviewConfig as ReviewSettings,
  type ReviewProfileConfig,
  reviewProfileSkillLimit
} from "@knpkv/codecommit-core/ReviewProfile.js"
import { Exit, Option } from "effect"
import type * as Atom from "effect/unstable/reactivity/Atom"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { CheckIcon } from "lucide-react"
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"

import { configQueryAtom, configSaveAtom, reviewSkillsQueryAtom } from "../atoms/app.js"
import type { ReviewSkillResponse } from "../../server/Api.js"
import { Button } from "./ui/button.js"
import { Separator } from "./ui/separator.js"

export const updateReviewProfileSkills = (
  profile: ReviewProfileConfig,
  skillId: string,
  enabled: boolean
): ReviewProfileConfig => {
  const selected = profile.skillIds.includes(skillId)
  if (enabled) {
    if (selected || profile.skillIds.length >= reviewProfileSkillLimit) return profile
    return { ...profile, skillIds: [...profile.skillIds, skillId] }
  }
  return selected ? { ...profile, skillIds: profile.skillIds.filter((candidate) => candidate !== skillId) } : profile
}

export const isReviewProfileSkillSelectionDisabled = (profile: ReviewProfileConfig, skillId: string): boolean =>
  !profile.skillIds.includes(skillId) && profile.skillIds.length >= reviewProfileSkillLimit

interface ReviewProfileSkillOption extends ReviewSkillResponse {
  readonly available: boolean
}

/** Keep persisted selections visible when an environment skill disappears. */
export const reviewProfileSkillOptions = (
  profile: ReviewProfileConfig,
  skills: ReadonlyArray<ReviewSkillResponse>
): ReadonlyArray<ReviewProfileSkillOption> => {
  const availableIds = new Set(skills.map(({ id }) => id))
  return [
    ...skills.map((skill) => ({ ...skill, available: true })),
    ...profile.skillIds
      .filter((skillId) => !availableIds.has(skillId))
      .map((skillId) => ({
        id: skillId,
        name: skillId,
        description: "No longer available in this environment; deselect it to repair the profile",
        source: "unavailable",
        available: false
      }))
  ]
}

export function ReviewProfileSkillPicker({
  disabled = false,
  onSkillChange,
  profile,
  skills
}: {
  readonly disabled?: boolean
  readonly onSkillChange: (skillId: string, enabled: boolean) => void
  readonly profile: ReviewProfileConfig
  readonly skills: ReadonlyArray<ReviewSkillResponse>
}): ReactElement {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {reviewProfileSkillOptions(profile, skills).map((skill) => (
        <label className="flex items-start gap-2 rounded-md border p-3 text-sm" key={skill.id}>
          <input
            checked={profile.skillIds.includes(skill.id)}
            disabled={disabled || isReviewProfileSkillSelectionDisabled(profile, skill.id)}
            onChange={(event) => onSkillChange(skill.id, event.target.checked)}
            type="checkbox"
          />
          <span>
            <b>{skill.name}</b>
            <small className="block text-muted-foreground">
              {skill.description} · {skill.source}
            </small>
          </span>
        </label>
      ))}
    </div>
  )
}

export function SettingsRelay() {
  const config = useAtomValue(configQueryAtom)
  const skills = useAtomValue(reviewSkillsQueryAtom)
  const saveConfig = useAtomSet(configSaveAtom, { mode: "promiseExit" })
  const navigate = useNavigate()
  return <SettingsRelayView config={config} onReload={() => void navigate(0)} saveConfig={saveConfig} skills={skills} />
}

type ConfigState = Atom.Type<typeof configQueryAtom>
type ReviewSkillsState = Atom.Type<typeof reviewSkillsQueryAtom>
type ConfigSaveState = Atom.Type<typeof configSaveAtom>
type ConfigSaveInput = typeof configSaveAtom extends Atom.Writable<infer _Result, infer Input> ? Input : never
type ConfigSaveExit =
  ConfigSaveState extends AsyncResult.AsyncResult<infer Success, infer Failure> ? Exit.Exit<Success, Failure> : never

export interface SettingsRelayViewProps {
  readonly config: ConfigState
  readonly onReload?: () => void
  readonly saveConfig: (input: ConfigSaveInput) => Promise<ConfigSaveExit>
  readonly skills: ReviewSkillsState
}

const configSaveFailureMessage = (exit: ConfigSaveExit): string =>
  Option.match(Exit.findErrorOption(exit), {
    onNone: () => "Failed to save Relay profiles",
    onSome: (failure) => failure.message
  })

/** Relay profile editor with explicit query states for component-level verification. */
export function SettingsRelayView({ config, onReload = () => undefined, saveConfig, skills }: SettingsRelayViewProps) {
  type ConfigValue = Extract<typeof config, { readonly _tag: "Success" }>["value"]
  const configRef = useRef<ConfigValue | null>(null)
  const [review, setReview] = useState<ReviewSettings | null>(null)
  const [saved, setSaved] = useState<ReviewSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedNow, setSavedNow] = useState(false)

  useEffect(() => {
    if (!AsyncResult.isSuccess(config)) return
    configRef.current = config.value
    if (review === null) {
      setReview(config.value.review)
      setSaved(config.value.review)
    }
  }, [config, review])

  const updateProfileSkills = useCallback((profileId: string, skillId: string, enabled: boolean) => {
    setSavedNow(false)
    setReview((current) =>
      current === null
        ? null
        : {
            ...current,
            profiles: current.profiles.map((profile) =>
              profile.id !== profileId ? profile : updateReviewProfileSkills(profile, skillId, enabled)
            )
          }
    )
  }, [])

  const updateProfile = useCallback((profileId: string, patch: Partial<ReviewProfileConfig>) => {
    setSavedNow(false)
    setReview((current) =>
      current === null
        ? null
        : {
            ...current,
            profiles: current.profiles.map((profile) => (profile.id === profileId ? { ...profile, ...patch } : profile))
          }
    )
  }, [])

  const save = useCallback(async () => {
    const data = configRef.current
    if (data === null || review === null) return
    setSaving(true)
    setSaveError(null)
    setSavedNow(false)
    const basePayload = {
      accounts: data.accounts.map(({ enabled, profile, regions }) => ({ enabled, profile, regions: [...regions] })),
      autoDetect: data.autoDetect,
      autoRefresh: data.autoRefresh,
      refreshIntervalSeconds: data.refreshIntervalSeconds,
      review
    }
    const payload = data.sandbox === undefined ? basePayload : { ...basePayload, sandbox: data.sandbox }
    const exit = await saveConfig({ payload })
    if (Exit.isSuccess(exit)) {
      setSaved(review)
      setSavedNow(true)
    } else {
      setSaveError(configSaveFailureMessage(exit))
    }
    setSaving(false)
  }, [review, saveConfig])

  const dirty = review !== null && saved !== null && JSON.stringify(review) !== JSON.stringify(saved)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Relay review profiles</h2>
          <p className="text-sm text-muted-foreground">Default focus and prompt-only skills for Diff &amp; Relay</p>
        </div>
        {AsyncResult.isSuccess(config) && review !== null ? (
          <Button disabled={!dirty || saving} onClick={() => void save()} size="sm">
            {saving ? (
              "Saving…"
            ) : savedNow ? (
              <>
                <CheckIcon className="size-3.5" /> Saved
              </>
            ) : (
              "Save"
            )}
          </Button>
        ) : null}
      </div>
      {saveError === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {saveError}
        </p>
      )}
      <Separator />
      {AsyncResult.isFailure(config) ? (
        <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4" role="alert">
          <p className="text-sm font-medium text-destructive">Could not load Relay profiles</p>
          <p className="text-xs text-muted-foreground">Check the server connection, then reload this page to retry.</p>
          <Button onClick={onReload} size="sm" variant="outline">
            Reload
          </Button>
        </div>
      ) : !AsyncResult.isSuccess(config) || review === null ? (
        <p className="text-sm text-muted-foreground">Loading profiles…</p>
      ) : (
        <div className="space-y-5">
          <label className="grid gap-2 text-sm font-medium">
            Default profile
            <select
              className="h-9 rounded-md border bg-transparent px-3 text-sm"
              disabled={saving}
              onChange={(event) => {
                setSavedNow(false)
                setReview((current) => (current === null ? null : { ...current, defaultProfileId: event.target.value }))
              }}
              value={review.defaultProfileId}
            >
              {review.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          {AsyncResult.isFailure(skills) ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
              role="alert"
            >
              Environment skills could not be loaded. Reload this page to retry.
            </p>
          ) : null}
          {review.profiles.map((profile) => (
            <section className="space-y-3 rounded-lg border p-4" key={profile.id}>
              <div>
                <h3 className="text-sm font-semibold">{profile.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {profile.provider} · {profile.harness} · {profile.model}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-xs font-medium">
                  Review kind
                  <select
                    className="h-9 rounded-md border bg-transparent px-3 text-sm"
                    disabled={saving}
                    onChange={(event) => {
                      const kind = reviewKindOptions.find((candidate) => candidate === event.target.value)
                      if (kind !== undefined) updateProfile(profile.id, { kind })
                    }}
                    value={profile.kind}
                  >
                    <option value="review">Full review</option>
                    <option value="security">Security</option>
                    <option value="tests">Tests</option>
                    <option value="explain">Explain</option>
                  </select>
                </label>
                <label className="grid gap-1 text-xs font-medium">
                  Provider
                  <select
                    className="h-9 rounded-md border bg-transparent px-3 text-sm"
                    disabled={saving}
                    onChange={(event) => {
                      const provider = reviewProviderOptions.find((candidate) => candidate === event.target.value)
                      if (provider !== undefined) updateProfile(profile.id, { provider })
                    }}
                    value={profile.provider}
                  >
                    {reviewProviderOptions.map((provider) => (
                      <option key={provider}>{provider}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs font-medium">
                  Harness
                  <select
                    className="h-9 rounded-md border bg-transparent px-3 text-sm"
                    disabled={saving}
                    onChange={(event) => {
                      const harness = reviewHarnessOptions.find((candidate) => candidate === event.target.value)
                      if (harness !== undefined) updateProfile(profile.id, { harness })
                    }}
                    value={profile.harness}
                  >
                    {reviewHarnessOptions.map((harness) => (
                      <option key={harness}>{harness}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs font-medium">
                  Model
                  <select
                    className="h-9 rounded-md border bg-transparent px-3 text-sm"
                    disabled={saving}
                    onChange={(event) => {
                      const model = reviewModelOptions.find((candidate) => candidate === event.target.value)
                      if (model !== undefined) updateProfile(profile.id, { model })
                    }}
                    value={profile.model}
                  >
                    {reviewModelOptions.map((model) => (
                      <option key={model}>{model}</option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {profile.skillIds.length}/{reviewProfileSkillLimit} prompt-only methods selected
              </p>
              {AsyncResult.isSuccess(skills) ? (
                <ReviewProfileSkillPicker
                  disabled={saving}
                  onSkillChange={(skillId, enabled) => updateProfileSkills(profile.id, skillId, enabled)}
                  profile={profile}
                  skills={skills.value}
                />
              ) : AsyncResult.isFailure(skills) ? (
                <p className="text-xs text-muted-foreground">Skill selection unavailable.</p>
              ) : (
                <p className="text-xs text-muted-foreground">Loading environment skills…</p>
              )}
            </section>
          ))}
          <p className="text-xs text-muted-foreground">
            Skills are injected as prompt-only review methods. Relay cannot run their tools or open referenced files.
          </p>
        </div>
      )}
    </div>
  )
}

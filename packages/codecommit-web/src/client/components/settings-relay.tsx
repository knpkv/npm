/** Relay review profiles and environment skill selection. @module */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { ReviewConfig as ReviewSettings } from "@knpkv/codecommit-core/ConfigService.js"
import { Predicate } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { CheckIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { configQueryAtom, configSaveAtom, reviewSkillsQueryAtom } from "../atoms/app.js"
import { Button } from "./ui/button.js"
import { Separator } from "./ui/separator.js"

export function SettingsRelay() {
  const config = useAtomValue(configQueryAtom)
  const skills = useAtomValue(reviewSkillsQueryAtom)
  const saveConfig = useAtomSet(configSaveAtom, { mode: "promise" })
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
              profile.id !== profileId
                ? profile
                : {
                    ...profile,
                    skillIds: enabled
                      ? [...new Set([...profile.skillIds, skillId])]
                      : profile.skillIds.filter((candidate) => candidate !== skillId)
                  }
            )
          }
    )
  }, [])

  const save = useCallback(async () => {
    const data = configRef.current
    if (data === null || review === null) return
    setSaving(true)
    setSaveError(null)
    setSavedNow(false)
    try {
      const basePayload = {
        accounts: data.accounts.map(({ enabled, profile, regions }) => ({ enabled, profile, regions: [...regions] })),
        autoDetect: data.autoDetect,
        autoRefresh: data.autoRefresh,
        refreshIntervalSeconds: data.refreshIntervalSeconds,
        review
      }
      const payload = data.sandbox === undefined ? basePayload : { ...basePayload, sandbox: data.sandbox }
      await saveConfig({
        payload
      })
      setSaved(review)
      setSavedNow(true)
    } catch (cause) {
      setSaveError(Predicate.isError(cause) ? cause.message : "Failed to save Relay profiles")
    } finally {
      setSaving(false)
    }
  }, [review, saveConfig])

  const dirty = review !== null && saved !== null && JSON.stringify(review) !== JSON.stringify(saved)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Relay review profiles</h2>
          <p className="text-sm text-muted-foreground">Default focus and prompt-only skills for Diff &amp; Relay</p>
        </div>
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
      </div>
      {saveError === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {saveError}
        </p>
      )}
      <Separator />
      {!AsyncResult.isSuccess(config) || review === null ? (
        <p className="text-sm text-muted-foreground">Loading profiles…</p>
      ) : (
        <div className="space-y-5">
          <label className="grid gap-2 text-sm font-medium">
            Default profile
            <select
              className="h-9 rounded-md border bg-transparent px-3 text-sm"
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
          {review.profiles.map((profile) => (
            <section className="space-y-3 rounded-lg border p-4" key={profile.id}>
              <div>
                <h3 className="text-sm font-semibold">{profile.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {profile.kind} · {profile.skillIds.length} selected
                </p>
              </div>
              {AsyncResult.isSuccess(skills) ? (
                <div className="grid gap-2 md:grid-cols-2">
                  {skills.value.map((skill) => (
                    <label className="flex items-start gap-2 rounded-md border p-3 text-sm" key={skill.id}>
                      <input
                        checked={profile.skillIds.includes(skill.id)}
                        onChange={(event) => updateProfileSkills(profile.id, skill.id, event.target.checked)}
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

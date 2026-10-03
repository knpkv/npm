import { useEffect, useState } from "react"
import { Button, Field, StatePanel } from "@knpkv/rly/primitives"
import { Option, Predicate, Schema } from "effect"
import {
  agentEfforts,
  SessionAgentSettings,
  type SessionAgentSettings as Settings
} from "@knpkv/jira-clockify/agent/agentSettings.js"
import { readAgentSettings, saveAgentSettings } from "./api.js"

const decode = Schema.decodeUnknownOption(SessionAgentSettings)

/** Configures session matching and description suggestions. */
export default function AgentSettingsPanel(props: {
  readonly disabled: boolean
  readonly onSaved: () => void
  readonly onSaving: (saving: boolean) => void
}) {
  const [draft, setDraft] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void readAgentSettings(controller.signal).then(
      (settings) => {
        if (!controller.signal.aborted) setDraft(settings)
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setFailure(Predicate.isError(cause) ? cause.message : String(cause))
      }
    )
    return () => controller.abort()
  }, [])

  const change = (value: {
    readonly provider: string
    readonly model: string | null
    readonly effort: string | null
  }) => {
    const parsed = decode(value)
    if (Option.isSome(parsed)) {
      setDraft(parsed.value)
      setSaved(false)
    }
  }
  const save = async () => {
    if (draft === null || saving || props.disabled) return
    setSaving(true)
    props.onSaving(true)
    setFailure(null)
    try {
      setDraft(await saveAgentSettings(draft))
      setSaved(true)
      props.onSaved()
    } catch (cause) {
      setFailure(Predicate.isError(cause) ? cause.message : String(cause))
    } finally {
      setSaving(false)
      props.onSaving(false)
    }
  }

  return (
    <section className="jcf-agent-settings" aria-label="Session agent settings">
      <p>
        Used for Rescan sessions and suggested work descriptions. Blank model and default effort use the agent CLI
        settings.
      </p>
      {failure === null ? null : (
        <StatePanel title="Could not update agent settings" description={failure} tone="critical" />
      )}
      {draft === null ? (
        <p>{failure === null ? "Loading agent settings…" : "Close and reopen agent settings to retry."}</p>
      ) : (
        <>
          <div className="jcf-agent-settings-fields">
            <Field label="Agent">
              {(control) => (
                <select
                  {...control}
                  value={draft.provider}
                  disabled={saving || props.disabled}
                  onChange={(event) => {
                    change({ provider: event.target.value, model: null, effort: null })
                  }}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              )}
            </Field>
            <Field label="Model">
              {(control) => (
                <input
                  {...control}
                  value={draft.model ?? ""}
                  placeholder="CLI default"
                  maxLength={200}
                  disabled={saving || props.disabled}
                  onChange={(event) => {
                    change({ ...draft, model: event.target.value.trim() === "" ? null : event.target.value.trim() })
                  }}
                />
              )}
            </Field>
            <Field label="Effort">
              {(control) => (
                <select
                  {...control}
                  value={draft.effort ?? "default"}
                  disabled={saving || props.disabled}
                  onChange={(event) => {
                    change({ ...draft, effort: event.target.value === "default" ? null : event.target.value })
                  }}
                >
                  <option value="default">CLI default</option>
                  {agentEfforts(draft.provider).map((effort) => (
                    <option value={effort} key={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <Button size="compact" disabled={props.disabled || saving} loading={saving} onClick={() => void save()}>
            Save agent settings
          </Button>
          {saved ? <p role="status">Saved. Applies on the next Rescan sessions.</p> : null}
        </>
      )}
    </section>
  )
}

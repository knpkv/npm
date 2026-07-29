import { Button, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as Schema from "effect/Schema"
import { type ChangeEvent, type ReactElement, type ReactNode, useEffect, useId, useState } from "react"

import {
  changedWorkspaceSettingsSections,
  isGovernedWorkspaceSettingsSection,
  WorkspaceSettingsV1
} from "../../domain/workspaceSettings.js"
import { useAppTheme } from "../AppProviders.js"
import { browserReadableSessionKey, useBrowserSession } from "../BrowserSession.js"
import styles from "./WorkspaceSettingsPage.module.css"
import { useWorkspaceSettings } from "./useWorkspaceSettings.js"

const integerValue = (event: ChangeEvent<HTMLInputElement>): number => Number.parseInt(event.currentTarget.value, 10)

const SettingsSection = ({
  children,
  description,
  title
}: {
  readonly children: ReactNode
  readonly description: string
  readonly title: string
}): ReactElement => (
  <Surface className={styles.section} padding="default" shape="grouped">
    <div className={styles.sectionHeading}>
      <Text as="h2" variant="section-title">
        {title}
      </Text>
      <Text as="p" tone="secondary">
        {description}
      </Text>
    </div>
    <div className={styles.fields}>{children}</div>
  </Surface>
)

const Field = ({
  children,
  controlId,
  error,
  hint,
  label
}: {
  readonly children: ReactElement
  readonly controlId?: string
  readonly error?: string
  readonly hint?: string
  readonly label: string
}): ReactElement => (
  <label className={styles.field} htmlFor={controlId}>
    <span>{label}</span>
    {children}
    {hint === undefined ? null : <small>{hint}</small>}
    {error === undefined ? null : (
      <small id={controlId === undefined ? undefined : `${controlId}-error`} role="alert">
        {error}
      </small>
    )}
  </label>
)

const Checkbox = ({
  checked,
  disabled,
  label,
  onChange
}: {
  readonly checked: boolean
  readonly disabled: boolean
  readonly label: string
  readonly onChange: (checked: boolean) => void
}): ReactElement => (
  <label className={styles.checkbox}>
    <input
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
      type="checkbox"
    />
    <span>{label}</span>
  </label>
)

const SelectField = <Value extends string>({
  disabled,
  label,
  onChange,
  options,
  value
}: {
  readonly disabled: boolean
  readonly label: string
  readonly onChange: (value: Value) => void
  readonly options: ReadonlyArray<readonly [Value, string]>
  readonly value: Value
}): ReactElement => (
  <Field label={label}>
    <select
      className={styles.control}
      disabled={disabled}
      onChange={(event) => {
        const selected = options.find(([optionValue]) => optionValue === event.currentTarget.value)
        if (selected !== undefined) onChange(selected[0])
      }}
      value={value}
    >
      {options.map(([optionValue, optionLabel]) => (
        <option key={optionValue} value={optionValue}>
          {optionLabel}
        </option>
      ))}
    </select>
  </Field>
)

const retentionFields: ReadonlyArray<readonly [keyof WorkspaceSettingsV1["retention"], string, number]> = [
  ["evidenceDays", "Evidence (days)", 3_650],
  ["contentDays", "Content (days)", 3_650],
  ["auditDays", "Audit history (days)", 3_650],
  ["agentActivityDays", "Agent activity (days)", 365],
  ["sandboxArtifactDays", "Sandbox artifacts (days)", 30]
]

const NumberField = ({
  disabled,
  error,
  label,
  maximum,
  minimum,
  onChange,
  value
}: {
  readonly disabled: boolean
  readonly error?: string
  readonly label: string
  readonly maximum: number
  readonly minimum: number
  readonly onChange: (value: number) => void
  readonly value: number
}): ReactElement => {
  const controlId = useId()
  const validationError =
    error ??
    (!Number.isInteger(value) || value < minimum || value > maximum
      ? `${label} must be a whole number from ${String(minimum)} to ${String(maximum)}.`
      : undefined)
  return (
    <Field controlId={controlId} {...(validationError === undefined ? {} : { error: validationError })} label={label}>
      <input
        aria-describedby={validationError === undefined ? undefined : `${controlId}-error`}
        aria-invalid={validationError === undefined ? undefined : true}
        className={styles.control}
        disabled={disabled}
        id={controlId}
        max={maximum}
        min={minimum}
        onChange={(event) => onChange(integerValue(event))}
        type="number"
        value={value}
      />
    </Field>
  )
}

/** Settings fields exported for browser-backed validation acceptance tests. @internal */
export const SettingsForm = ({
  canEdit,
  draft,
  onChange
}: {
  readonly canEdit: boolean
  readonly draft: WorkspaceSettingsV1
  readonly onChange: (draft: WorkspaceSettingsV1) => void
}): ReactElement => {
  const disabled = !canEdit
  const update = <Key extends keyof WorkspaceSettingsV1>(key: Key, value: WorkspaceSettingsV1[Key]): void =>
    onChange({ ...draft, [key]: value })

  return (
    <div className={styles.sections}>
      <SettingsSection
        description="Controls whether inferred delivery relationships are proposed and the confidence floor."
        title="Inference"
      >
        <Checkbox
          checked={draft.inference.enabled}
          disabled={disabled}
          label="Enable relationship inference"
          onChange={(enabled) => update("inference", { ...draft.inference, enabled })}
        />
        <NumberField
          disabled={disabled}
          label="Minimum confidence (%)"
          maximum={100}
          minimum={0}
          onChange={(minimumConfidencePercent) => update("inference", { ...draft.inference, minimumConfidencePercent })}
          value={draft.inference.minimumConfidencePercent}
        />
      </SettingsSection>

      <SettingsSection
        description="Sets automatic synchronization cadence and the age at which source data is considered stale."
        title="Synchronization"
      >
        <SelectField
          disabled={disabled}
          label="Cadence"
          onChange={(cadence) =>
            update("synchronization", {
              ...draft.synchronization,
              cadence,
              intervalMinutes: cadence === "manual" ? null : (draft.synchronization.intervalMinutes ?? 60)
            })
          }
          options={[
            ["manual", "Manual"],
            ["interval", "Scheduled interval"]
          ]}
          value={draft.synchronization.cadence}
        />
        {draft.synchronization.intervalMinutes === null ? null : (
          <NumberField
            disabled={disabled}
            label="Interval (minutes)"
            maximum={10_080}
            minimum={5}
            onChange={(intervalMinutes) => update("synchronization", { ...draft.synchronization, intervalMinutes })}
            value={draft.synchronization.intervalMinutes}
          />
        )}
        <NumberField
          disabled={disabled}
          label="Stale after (minutes)"
          maximum={43_200}
          minimum={5}
          onChange={(staleAfterMinutes) => update("synchronization", { ...draft.synchronization, staleAfterMinutes })}
          value={draft.synchronization.staleAfterMinutes}
        />
      </SettingsSection>

      <SettingsSection
        description="Governed lifecycle limits. Audit retention cannot be shorter than evidence retention."
        title="Retention"
      >
        {retentionFields.map(([key, label, maximum]) => (
          <NumberField
            disabled={disabled}
            {...(() => {
              const error =
                (key === "evidenceDays" || key === "auditDays") &&
                draft.retention.auditDays < draft.retention.evidenceDays
                  ? "Audit retention must be at least as long as evidence retention."
                  : (key === "agentActivityDays" || key === "sandboxArtifactDays") &&
                      draft.retention.agentActivityDays < draft.retention.sandboxArtifactDays
                    ? "Agent activity retention must be at least as long as sandbox artifact retention."
                    : undefined
              return error === undefined ? {} : { error }
            })()}
            key={key}
            label={label}
            maximum={maximum}
            minimum={1}
            onChange={(value) => update("retention", { ...draft.retention, [key]: value })}
            value={draft.retention[key]}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        description="Controls when repeated failures should open an investigation."
        title="Investigation"
      >
        <SelectField
          disabled={disabled}
          label="Mode"
          onChange={(mode) =>
            update("investigation", {
              ...draft.investigation,
              mode
            })
          }
          options={[
            ["manual", "Manual"],
            ["automatic", "Automatic"]
          ]}
          value={draft.investigation.mode}
        />
        <NumberField
          disabled={disabled}
          label="Consecutive failure threshold"
          maximum={20}
          minimum={1}
          onChange={(consecutiveFailureThreshold) =>
            update("investigation", {
              ...draft.investigation,
              consecutiveFailureThreshold
            })
          }
          value={draft.investigation.consecutiveFailureThreshold}
        />
      </SettingsSection>

      <SettingsSection
        description="Governed publishing defaults. Credentials and tokens never belong in workspace settings."
        title="Jira"
      >
        <SelectField
          disabled={disabled}
          label="Comment publishing"
          onChange={(commentMode) =>
            update("jira", {
              ...draft.jira,
              commentMode
            })
          }
          options={[
            ["manual-only", "Manual only"],
            ["confirm-before-publish", "Confirm before publishing"]
          ]}
          value={draft.jira.commentMode}
        />
        <Checkbox
          checked={draft.jira.includeControlCenterAttribution}
          disabled={disabled}
          label="Include Control Center attribution"
          onChange={(includeControlCenterAttribution) =>
            update("jira", { ...draft.jira, includeControlCenterAttribution })
          }
        />
      </SettingsSection>

      <SettingsSection description="Governed retry defaults for pipeline operations." title="Pipeline">
        <SelectField
          disabled={disabled}
          label="Retry behavior"
          onChange={(retryMode) =>
            update("pipeline", {
              ...draft.pipeline,
              retryMode
            })
          }
          options={[
            ["manual-only", "Manual only"],
            ["confirm-before-retry", "Confirm before retry"]
          ]}
          value={draft.pipeline.retryMode}
        />
        <NumberField
          disabled={disabled}
          label="Maximum attempts"
          maximum={10}
          minimum={1}
          onChange={(maximumAttempts) => update("pipeline", { ...draft.pipeline, maximumAttempts })}
          value={draft.pipeline.maximumAttempts}
        />
      </SettingsSection>

      <SettingsSection
        description="Governed provider and sandbox policy. Provider identifiers are names only, never secrets."
        title="Agent"
      >
        <Field hint="Comma-separated lowercase identifiers; saved in canonical order." label="Allowed providers">
          <input
            className={styles.control}
            disabled={disabled}
            onChange={(event) => {
              const allowedProviders = [
                ...new Set(
                  event.currentTarget.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter((value) => value.length > 0)
                )
              ].sort()
              update("agent", {
                ...draft.agent,
                allowedProviders,
                defaultProvider:
                  draft.agent.defaultProvider !== null && allowedProviders.includes(draft.agent.defaultProvider)
                    ? draft.agent.defaultProvider
                    : null,
                defaultModel:
                  draft.agent.defaultProvider !== null && allowedProviders.includes(draft.agent.defaultProvider)
                    ? draft.agent.defaultModel
                    : null
              })
            }}
            type="text"
            value={draft.agent.allowedProviders.join(", ")}
          />
        </Field>
        <Field label="Default provider">
          <input
            className={styles.control}
            disabled={disabled}
            list="allowed-agent-providers"
            onChange={(event) => {
              const defaultProvider = event.currentTarget.value.trim() || null
              update("agent", {
                ...draft.agent,
                defaultProvider,
                defaultModel: defaultProvider === null ? null : draft.agent.defaultModel
              })
            }}
            type="text"
            value={draft.agent.defaultProvider ?? ""}
          />
        </Field>
        <datalist id="allowed-agent-providers">
          {draft.agent.allowedProviders.map((provider) => (
            <option key={provider} value={provider} />
          ))}
        </datalist>
        <Field label="Default model">
          <input
            className={styles.control}
            disabled={disabled || draft.agent.defaultProvider === null}
            onChange={(event) =>
              update("agent", {
                ...draft.agent,
                defaultModel: event.currentTarget.value.trim() || null
              })
            }
            type="text"
            value={draft.agent.defaultModel ?? ""}
          />
        </Field>
        <SelectField
          disabled={disabled}
          label="Tool policy"
          onChange={(toolPolicy) =>
            update("agent", {
              ...draft.agent,
              toolPolicy
            })
          }
          options={[
            ["read-only", "Read only"],
            ["review-sandbox", "Review sandbox"]
          ]}
          value={draft.agent.toolPolicy}
        />
        <SelectField
          disabled={disabled}
          label="Profile policy"
          onChange={(profilePolicy) =>
            update("agent", {
              ...draft.agent,
              profilePolicy
            })
          }
          options={[
            ["isolated", "Isolated"],
            ["local-profile", "Local profile"]
          ]}
          value={draft.agent.profilePolicy}
        />
      </SettingsSection>

      <SettingsSection description="Workspace presentation defaults shared by collaborators." title="Presentation">
        <SelectField
          disabled={disabled}
          label="Density"
          onChange={(density) =>
            update("presentation", {
              ...draft.presentation,
              density
            })
          }
          options={[
            ["comfortable", "Comfortable"],
            ["compact", "Compact"]
          ]}
          value={draft.presentation.density}
        />
        <SelectField
          disabled={disabled}
          label="Default landing"
          onChange={(defaultLanding) =>
            update("presentation", {
              ...draft.presentation,
              defaultLanding
            })
          }
          options={[
            ["overview", "Overview"],
            ["active-work", "Active work"]
          ]}
          value={draft.presentation.defaultLanding}
        />
      </SettingsSection>
    </div>
  )
}

/** Concurrency-safe workspace settings with explicit stale-write recovery. */
export const WorkspaceSettingsPage = (): ReactElement => {
  const browserSession = useBrowserSession()
  const sessionKey = browserReadableSessionKey(browserSession.state)
  const controller = useWorkspaceSettings(sessionKey, browserSession.invalidateSession)
  const theme = useAppTheme()
  const [governedChangeConfirmed, setGovernedChangeConfirmed] = useState(false)
  const confirmationRevision = controller.state._tag === "ready" ? controller.state.server.revision : null
  useEffect(() => {
    setGovernedChangeConfirmed(false)
  }, [confirmationRevision, controller.state._tag])
  const session =
    browserSession.state._tag === "authenticated" || browserSession.state._tag === "storage-unavailable"
      ? browserSession.state.session
      : null
  const canEdit = browserSession.state._tag === "authenticated" && session?.permission === "workspace-owner"

  if (controller.state._tag === "idle" || controller.state._tag === "loading") {
    return <StatePanel title="Loading workspace settings" />
  }
  if (controller.state._tag === "failed") {
    return (
      <StatePanel
        action={<Button onClick={controller.retry}>Retry</Button>}
        description="The current settings document could not be loaded."
        title="Settings unavailable"
        tone="critical"
      />
    )
  }
  if (controller.state._tag === "conflict-recovery-failed") {
    return (
      <StatePanel
        action={<Button onClick={controller.retryConflict}>Retry latest revision</Button>}
        description="Your unsaved draft is retained, but the latest server revision could not be loaded."
        title="Conflict recovery interrupted"
        tone="critical"
      />
    )
  }
  if (controller.state._tag === "conflict") {
    return (
      <div className={styles.page}>
        <StatePanel
          action={
            <div className={styles.actions}>
              <Button onClick={controller.discardConflict}>Use latest</Button>
              <Button onClick={controller.reapplyConflict} variant="primary">
                Reapply my changes
              </Button>
            </div>
          }
          description={`Another session saved revision ${String(
            controller.state.latest.revision
          )}. Choose the latest document or reapply only the fields you changed, then review and save.`}
          title="Settings changed in another session"
          tone="caution"
        />
      </div>
    )
  }

  const { draft, server, status } = controller.state
  const governedChanges = changedWorkspaceSettingsSections(server.settings, draft).filter(
    isGovernedWorkspaceSettingsSection
  )
  const requiresGovernedConfirmation = governedChanges.length > 0
  const draftIsValid = Schema.is(WorkspaceSettingsV1)(draft)
  const localProfileUnavailable = draft.agent.profilePolicy === "local-profile"
  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <div>
          <Text as="h1" variant="page-title">
            Workspace settings
          </Text>
          <Text as="p" tone="secondary">
            Revision {server.revision}. Changes are protected against stale writes and attributable to the current
            session.
          </Text>
        </div>
        <div className={styles.save}>
          <span aria-live="polite">
            {status === "saving"
              ? "Saving…"
              : status === "failed"
                ? "Save failed — retry when ready"
                : status === "dirty"
                  ? "Unsaved changes"
                  : "Saved"}
          </span>
          <Button
            disabled={
              !canEdit ||
              (status !== "dirty" && status !== "failed") ||
              !draftIsValid ||
              localProfileUnavailable ||
              (requiresGovernedConfirmation && !governedChangeConfirmed)
            }
            loading={status === "saving"}
            onClick={controller.save}
            variant="primary"
          >
            Save settings
          </Button>
        </div>
      </header>
      {!canEdit ? (
        <Text as="p" className={styles.notice} tone="secondary">
          {session?.permission === "workspace-approver"
            ? "Approvers can inspect settings. A workspace owner must save changes."
            : "A workspace-owner session with mutation storage is required to change settings."}
        </Text>
      ) : null}
      {canEdit && !draftIsValid ? (
        <Text as="p" className={styles.notice} tone="secondary">
          Correct the highlighted bounds and policy relationships before saving. Audit retention must cover evidence,
          sandbox artifacts must expire before agent activity, and default agent providers must be allowed.
        </Text>
      ) : null}
      {canEdit && localProfileUnavailable ? (
        <Text as="p" className={styles.notice} tone="secondary">
          Local profile is unavailable: no installed CLI capability generation proves that hooks, plugins, MCP servers,
          browser control, and extra writable roots are disabled. Compared with isolated mode, those surfaces would be
          added and must be verified before this governed policy can be saved.
        </Text>
      ) : null}
      {canEdit && requiresGovernedConfirmation ? (
        <Surface className={styles.governance} padding="default" shape="grouped">
          <Checkbox
            checked={governedChangeConfirmed}
            disabled={status === "saving"}
            label={`I reviewed the governed ${governedChanges.join(
              ", "
            )} policy change${governedChanges.length === 1 ? "" : "s"} and authorize this exact revision.`}
            onChange={setGovernedChangeConfirmed}
          />
        </Surface>
      ) : null}
      <Surface className={styles.theme} padding="default" shape="grouped">
        <div>
          <Text as="h2" variant="section-title">
            Theme
          </Text>
          <Text as="p" tone="secondary">
            This preference is browser-local and is never sent to the server.
          </Text>
        </div>
        <select
          aria-label="Theme"
          className={styles.control}
          onChange={(event) => {
            const value = event.currentTarget.value
            if (value === "dark" || value === "light" || value === "system") {
              theme.setTheme(value)
            }
          }}
          value={theme.theme}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Surface>
      <SettingsForm
        canEdit={canEdit && status !== "saving"}
        draft={draft}
        onChange={(nextDraft) => {
          setGovernedChangeConfirmed(false)
          controller.edit(nextDraft)
        }}
      />
    </div>
  )
}

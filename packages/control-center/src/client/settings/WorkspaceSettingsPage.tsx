import { Button, Dialog, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { type ReactElement, useEffect, useState } from "react"
import { useParams } from "react-router"

import {
  changedWorkspaceSettingsSections,
  type GovernedWorkspaceSettingsSection,
  isGovernedWorkspaceSettingsSection,
  WorkspaceSettingsV1
} from "../../domain/workspaceSettings.js"
import { useAppTheme } from "../AppProviders.js"
import { browserReadableSessionKey, useBrowserSession } from "../BrowserSession.js"
import { BrowserSessionsPanel } from "./BrowserSessionsPanel.js"
import type { BrowserSessionAdministrationTransport } from "./browserSessionTransport.js"
import styles from "./WorkspaceSettingsPage.module.css"
import { useWorkspaceSettings } from "./useWorkspaceSettings.js"
import { SettingsForm } from "./SettingsForm.js"
import {
  PipelineReleaseTargets,
  validateReleaseTargets,
  type ReleaseTargetCatalog
} from "../../domain/releaseTargets.js"
import { browserWorkspaceSettingsTransport, type WorkspaceSettingsTransport } from "./workspaceSettingsTransport.js"

export { SettingsForm } from "./SettingsForm.js"

const sameReleaseTargets = Schema.toEquivalence(PipelineReleaseTargets)

interface GovernedSettingChange {
  readonly after: string
  readonly before: string
  readonly label: string
}

const presentedValue = (value: boolean | number | string | null): string => {
  if (value === null) return "Not set"
  if (value === true) return "Enabled"
  if (value === false) return "Disabled"
  return String(value)
}

const governedChange = (
  label: string,
  before: boolean | number | string | null,
  after: boolean | number | string | null
): ReadonlyArray<GovernedSettingChange> =>
  before === after ? [] : [{ after: presentedValue(after), before: presentedValue(before), label }]

const presentReleaseTargets = (pipeline: WorkspaceSettingsV1["pipeline"]): string =>
  (pipeline.releaseTargets?.length ?? 0) === 0
    ? "No targets"
    : (pipeline.releaseTargets ?? [])
        .map(
          (mapping) =>
            `${mapping.pipelineName}: ${mapping.environments.map((range) => `${range.name} (${range.key}), ${range.firstStage} through ${range.lastStage}, manual gate ${range.requiresManualGate ? "required" : "optional"}`).join("; ")}`
        )
        .join("; ")

const governedChangeDetails = (
  section: GovernedWorkspaceSettingsSection,
  before: WorkspaceSettingsV1,
  after: WorkspaceSettingsV1
): ReadonlyArray<GovernedSettingChange> => {
  switch (section) {
    case "agent":
      return [
        ...governedChange(
          "Allowed providers",
          before.agent.allowedProviders.join(", "),
          after.agent.allowedProviders.join(", ")
        ),
        ...governedChange("Default provider", before.agent.defaultProvider, after.agent.defaultProvider),
        ...governedChange("Default model", before.agent.defaultModel, after.agent.defaultModel),
        ...governedChange("Tool access", before.agent.toolPolicy, after.agent.toolPolicy),
        ...governedChange("Runtime isolation", before.agent.profilePolicy, after.agent.profilePolicy)
      ]
    case "jira":
      return [
        ...governedChange("Comment publishing", before.jira.commentMode, after.jira.commentMode),
        ...governedChange(
          "Control Center attribution",
          before.jira.includeControlCenterAttribution,
          after.jira.includeControlCenterAttribution
        )
      ]
    case "pipeline":
      return [
        ...governedChange("Retry policy", before.pipeline.retryMode, after.pipeline.retryMode),
        ...governedChange("Maximum attempts", before.pipeline.maximumAttempts, after.pipeline.maximumAttempts),
        ...(sameReleaseTargets(before.pipeline.releaseTargets ?? [], after.pipeline.releaseTargets ?? [])
          ? []
          : [
              {
                label: "Release targets and reviewed pipeline topology",
                before: presentReleaseTargets(before.pipeline),
                after: presentReleaseTargets(after.pipeline)
              }
            ])
      ]
    case "retention":
      return [
        ...governedChange("Evidence (days)", before.retention.evidenceDays, after.retention.evidenceDays),
        ...governedChange("Content (days)", before.retention.contentDays, after.retention.contentDays),
        ...governedChange("Audit history (days)", before.retention.auditDays, after.retention.auditDays),
        ...governedChange(
          "Agent activity (days)",
          before.retention.agentActivityDays,
          after.retention.agentActivityDays
        ),
        ...governedChange(
          "Sandbox artifacts (days)",
          before.retention.sandboxArtifactDays,
          after.retention.sandboxArtifactDays
        )
      ]
  }
}

/** Concurrency-safe workspace settings with explicit stale-write recovery. */
export const WorkspaceSettingsPage = ({
  browserSessionTransport,
  transport = browserWorkspaceSettingsTransport
}: {
  /** Injectable browser boundary for component acceptance tests. @internal */
  readonly browserSessionTransport?: BrowserSessionAdministrationTransport
  /** Injectable browser boundary for component acceptance tests. @internal */
  readonly transport?: WorkspaceSettingsTransport
} = {}): ReactElement => {
  const browserSession = useBrowserSession()
  const routeWorkspaceId = useParams().workspaceId
  const session =
    browserSession.state._tag === "authenticated" || browserSession.state._tag === "storage-unavailable"
      ? browserSession.state.session
      : null
  const routeMatchesSession = session === null || routeWorkspaceId === session.workspaceId
  const sessionKey = routeMatchesSession ? browserReadableSessionKey(browserSession.state) : null
  const controller = useWorkspaceSettings(sessionKey, browserSession.invalidateSession, transport)
  const theme = useAppTheme()
  const [governedDialogOpen, setGovernedDialogOpen] = useState(false)
  const [targetCatalogue, setTargetCatalogue] = useState<ReleaseTargetCatalog | null>(null)
  const [targetCatalogueRevision, setTargetCatalogueRevision] = useState(0)
  useEffect(() => {
    setTargetCatalogue(null)
    if (sessionKey === null || transport.loadTargetCatalog === undefined) return
    const request = new AbortController()
    transport.loadTargetCatalog(request.signal).then(
      (catalogue) => {
        if (!request.signal.aborted) setTargetCatalogue(catalogue)
      },
      () => {
        if (!request.signal.aborted) setTargetCatalogue(null)
      }
    )
    return () => request.abort()
  }, [sessionKey, transport, targetCatalogueRevision])
  const canEdit = browserSession.state._tag === "authenticated" && session?.permission === "workspace-owner"

  if (!routeMatchesSession) {
    return (
      <StatePanel
        description="This route does not match the workspace authorized for the current browser session."
        title="Workspace not found"
        tone="critical"
      />
    )
  }
  if (sessionKey === null && browserSession.state._tag !== "checking") {
    const authenticationRequired = browserSession.state._tag === "anonymous"
    return (
      <StatePanel
        description={
          authenticationRequired
            ? "Sign in to inspect the settings authorized for this workspace."
            : "The current browser session cannot read workspace settings."
        }
        title={authenticationRequired ? "Authentication required" : "Settings unavailable"}
        tone={authenticationRequired ? "caution" : "critical"}
      />
    )
  }
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
  if (controller.state._tag === "conflict-recovery-loading") {
    return (
      <StatePanel
        description="Your unsaved draft is retained while the latest server revision is loaded."
        title="Retrying conflict recovery"
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
              {controller.state.reapplyFailed ? null : (
                <Button onClick={controller.reapplyConflict} variant="primary">
                  Reapply my changes
                </Button>
              )}
            </div>
          }
          description={
            controller.state.reapplyFailed
              ? "Your changed fields cannot be combined safely with the latest settings. Use the latest document, then re-enter and review your changes."
              : `Another session saved revision ${String(
                  controller.state.latest.revision
                )}. Choose the latest document or reapply only the fields you changed, then review and save.`
          }
          title={
            controller.state.reapplyFailed
              ? "Settings conflict needs manual recovery"
              : "Settings changed in another session"
          }
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
  const targetsChanged = !sameReleaseTargets(
    server.settings.pipeline.releaseTargets ?? [],
    draft.pipeline.releaseTargets ?? []
  )
  const targetValidation = targetsChanged
    ? Effect.runSync(
        Effect.result(
          validateReleaseTargets(
            draft.pipeline.releaseTargets ?? [],
            targetCatalogue ?? { complete: false, pipelines: [] },
            server.settings.pipeline.releaseTargets ?? []
          )
        )
      )
    : null
  const targetError =
    controller.state.targetError ??
    (targetValidation !== null && Result.isFailure(targetValidation) ? targetValidation.failure : null)
  const draftIsValid = Schema.is(WorkspaceSettingsV1)(draft) && targetError === null
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
            {status === "saving" ? (
              "Saving…"
            ) : status === "failed" ? (
              "Save failed. Retry when ready."
            ) : status === "dirty" ? (
              "Unsaved changes"
            ) : (
              <StateLabel label="Saved" tone="positive" />
            )}
          </span>
          {/* Nothing to save: the state alone, never a greyed-out primary button beside it. */}
          {status === "saved" ? null : (
            <Button
              disabled={
                !canEdit || (status !== "dirty" && status !== "failed") || !draftIsValid || localProfileUnavailable
              }
              loading={status === "saving"}
              onClick={() => (requiresGovernedConfirmation ? setGovernedDialogOpen(true) : controller.save())}
              variant="primary"
            >
              Save settings
            </Button>
          )}
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
      <Dialog.Root onOpenChange={setGovernedDialogOpen} open={governedDialogOpen}>
        <Dialog.Content
          description={`Revision ${String(server.revision)} changes policy enforced for every workspace collaborator.`}
          title="Review governed changes"
        >
          <div className={styles.governance}>
            <Text as="p">Confirm the exact policy changes:</Text>
            <ul>
              {governedChanges.map((section) => (
                <li key={section}>
                  <strong>
                    {section[0]?.toUpperCase()}
                    {section.slice(1)}
                  </strong>
                  <ul>
                    {governedChangeDetails(section, server.settings, draft).map((change) => (
                      <li key={change.label}>
                        {change.label}: {change.before} → {change.after}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <div className={styles.actions}>
              <Dialog.Close>Cancel</Dialog.Close>
              <Dialog.Close onClick={controller.save}>Save governed changes</Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Root>
      {session === null || sessionKey === null ? null : (
        <BrowserSessionsPanel
          canManage={canEdit}
          currentSession={session}
          onSessionExpired={browserSession.invalidateSession}
          sessionKey={sessionKey}
          {...(browserSessionTransport === undefined ? {} : { transport: browserSessionTransport })}
        />
      )}
      <Surface className={styles.theme} padding="default" form="grouped">
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
        targetCatalogue={targetCatalogue}
        targetError={targetError}
        onRefreshTargetCatalogue={() => setTargetCatalogueRevision((value) => value + 1)}
        onChange={(nextDraft) => {
          setGovernedDialogOpen(false)
          controller.edit(nextDraft)
        }}
      />
    </div>
  )
}

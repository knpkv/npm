import { Button, StateLabel, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"

import type { RateLimitedApiError } from "../../api/errors.js"
import type { PluginSynchronizationState } from "../../api/plugins.js"
import styles from "./ServicesPage.module.css"
import {
  isAccountSyncFailure,
  type SyncLine,
  syncFailureSentence,
  syncLine,
  syncRequestBudgetSentence
} from "./syncPresentation.js"

/** Browser lifecycle for one connection's durable manual synchronization state. */
export type ConnectionSynchronizationViewState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "syncing"; readonly previous: PluginSynchronizationState | null }
  | { readonly _tag: "failed"; readonly requestBudget?: RateLimitedApiError }
  | { readonly _tag: "ready"; readonly synchronization: PluginSynchronizationState }

const StateDetails = ({
  hideAccountFailure,
  isSyncing,
  now,
  synchronization
}: {
  readonly hideAccountFailure: boolean
  readonly isSyncing: boolean
  readonly now: Date
  readonly synchronization: PluginSynchronizationState
}): ReactElement => {
  // While an attempt is in flight, surface the in-progress state instead of the stale prior result.
  const line: SyncLine = isSyncing ? { label: "Syncing…", tone: "progress" } : syncLine(synchronization, now)
  const failureClass = synchronization.failure?.failureClass
  const sentence =
    isSyncing || (hideAccountFailure && failureClass !== undefined && isAccountSyncFailure(failureClass))
      ? null
      : syncFailureSentence(synchronization)
  return (
    <div className={styles.syncState}>
      <StateLabel label={line.label} size="compact" tone={line.tone} />
      {sentence === null ? null : (
        <Text as="p" tone="secondary" variant="meta">
          {sentence}
        </Text>
      )}
    </div>
  )
}

export interface ConnectionSynchronizationViewProps {
  readonly canSynchronize: boolean
  /** Reference time supplied by the host; the view does not sample or update a clock. */
  readonly now: Date
  /** On a resource inside an account: credential failures are stated once on the account instead. */
  readonly hideAccountFailure?: boolean
  readonly onRefresh: () => void
  readonly onSynchronize: () => void
  readonly state: ConnectionSynchronizationViewState | undefined
}

/** Compact read/action presentation for the shared manual-sync API. */
export const ConnectionSynchronizationView = ({
  canSynchronize,
  hideAccountFailure = false,
  now,
  onRefresh,
  onSynchronize,
  state
}: ConnectionSynchronizationViewProps): ReactElement | null => {
  if (state === undefined) return null
  const isSyncing = state._tag === "syncing"
  const synchronization =
    state._tag === "ready" ? state.synchronization : state._tag === "syncing" ? state.previous : null
  const isQueued = synchronization?.result === "queued"
  const isServerSyncing = synchronization?.result === "running"
  return (
    <div className={styles.synchronization}>
      {synchronization === null ? (
        isSyncing ? (
          <StateLabel label="Syncing…" size="compact" tone="progress" />
        ) : null
      ) : (
        <StateDetails
          hideAccountFailure={hideAccountFailure}
          isSyncing={isSyncing && !isQueued}
          now={now}
          synchronization={synchronization}
        />
      )}
      {state._tag === "loading" ? (
        <Text tone="secondary" variant="meta">
          Loading sync state…
        </Text>
      ) : null}
      {state._tag === "failed" ? (
        <Text as="p" className={styles.setupError} role="alert" variant="body">
          {state.requestBudget === undefined
            ? "Sync state is unavailable."
            : syncRequestBudgetSentence(state.requestBudget)}
        </Text>
      ) : null}
      <div className={styles.syncActions}>
        <Button
          disabled={!canSynchronize || state._tag === "loading" || isSyncing || isQueued || isServerSyncing}
          loading={(isSyncing || isServerSyncing) && !isQueued}
          onClick={onSynchronize}
          variant="secondary"
        >
          Sync now
        </Button>
        {state._tag === "failed" ? (
          <Button onClick={onRefresh} variant="quiet">
            Refresh state
          </Button>
        ) : null}
      </div>
    </div>
  )
}

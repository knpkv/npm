import { Button, StateLabel, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"

import type { PluginSynchronizationState } from "../../api/plugins.js"
import styles from "./ServicesPage.module.css"
import { isAccountSyncFailure, type SyncLine, syncFailureSentence, syncLine } from "./syncPresentation.js"

/** Browser lifecycle for one connection's durable manual synchronization state. */
export type ConnectionSynchronizationViewState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "syncing"; readonly previous: PluginSynchronizationState | null }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly synchronization: PluginSynchronizationState }

const StateDetails = ({
  hideAccountFailure,
  isSyncing,
  synchronization
}: {
  readonly hideAccountFailure: boolean
  readonly isSyncing: boolean
  readonly synchronization: PluginSynchronizationState
}): ReactElement => {
  // While an attempt is in flight, surface the in-progress state instead of the stale prior result.
  const line: SyncLine = isSyncing ? { label: "Syncing…", tone: "progress" } : syncLine(synchronization, new Date())
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

/** Compact read/action presentation for the shared manual-sync API. */
export const ConnectionSynchronization = ({
  canSynchronize,
  hideAccountFailure = false,
  onRefresh,
  onSynchronize,
  state
}: {
  readonly canSynchronize: boolean
  /** On a resource inside an account: credential failures are stated once on the account instead. */
  readonly hideAccountFailure?: boolean
  readonly onRefresh: () => void
  readonly onSynchronize: () => void
  readonly state: ConnectionSynchronizationViewState | undefined
}): ReactElement | null => {
  if (state === undefined) return null
  const isSyncing = state._tag === "syncing"
  const synchronization =
    state._tag === "ready" ? state.synchronization : state._tag === "syncing" ? state.previous : null
  return (
    <div className={styles.synchronization}>
      {synchronization === null ? (
        isSyncing ? (
          <StateLabel label="Syncing…" size="compact" tone="progress" />
        ) : null
      ) : (
        <StateDetails hideAccountFailure={hideAccountFailure} isSyncing={isSyncing} synchronization={synchronization} />
      )}
      {state._tag === "loading" ? (
        <Text tone="secondary" variant="meta">
          Loading sync state…
        </Text>
      ) : null}
      {state._tag === "failed" ? (
        <Text as="p" className={styles.setupError} role="alert" variant="body">
          Sync state is unavailable.
        </Text>
      ) : null}
      <div className={styles.syncActions}>
        <Button
          disabled={!canSynchronize || state._tag === "loading" || state._tag === "syncing"}
          loading={state._tag === "syncing"}
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

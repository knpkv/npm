import { Button, StateLabel, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"

import type { PluginSynchronizationState } from "../../api/plugins.js"
import styles from "./ServicesPage.module.css"

/** Browser lifecycle for one connection's durable manual synchronization state. */
export type ConnectionSynchronizationViewState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "syncing"; readonly previous: PluginSynchronizationState | null }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly synchronization: PluginSynchronizationState }

const resultPresentation = (
  result: PluginSynchronizationState["result"]
): { readonly label: string; readonly tone: "critical" | "neutral" | "positive" | "progress" } => {
  switch (result) {
    case "never":
      return { label: "Never synchronized", tone: "neutral" }
    case "running":
      return { label: "Synchronizing", tone: "progress" }
    case "synchronized":
      return { label: "Synchronized", tone: "positive" }
    case "source-unavailable":
      return { label: "Source unavailable", tone: "critical" }
    case "interrupted":
      return { label: "Interrupted", tone: "critical" }
  }
}

const StateDetails = ({ synchronization }: { readonly synchronization: PluginSynchronizationState }): ReactElement => {
  const presentation = resultPresentation(synchronization.result)
  return (
    <div className={styles.syncState}>
      <StateLabel label={presentation.label} size="compact" tone={presentation.tone} />
      <Text tone="secondary" variant="meta">
        Last attempt: {synchronization.lastAttemptAt === null ? "never" : String(synchronization.lastAttemptAt)} · Last
        success: {synchronization.lastSuccessAt === null ? "never" : String(synchronization.lastSuccessAt)}
        {` · ${synchronization.pagesCommitted} ${synchronization.pagesCommitted === 1 ? "page" : "pages"}`}
      </Text>
    </div>
  )
}

/** Compact read/action presentation for the shared manual-sync API. */
export const ConnectionSynchronization = ({
  canSynchronize,
  onRefresh,
  onSynchronize,
  state
}: {
  readonly canSynchronize: boolean
  readonly onRefresh: () => void
  readonly onSynchronize: () => void
  readonly state: ConnectionSynchronizationViewState | undefined
}): ReactElement | null => {
  if (state === undefined) return null
  const synchronization =
    state._tag === "ready" ? state.synchronization : state._tag === "syncing" ? state.previous : null
  return (
    <div className={styles.synchronization}>
      {synchronization === null ? null : <StateDetails synchronization={synchronization} />}
      {state._tag === "loading" ? (
        <Text tone="secondary" variant="meta">
          Loading synchronization state…
        </Text>
      ) : null}
      {state._tag === "failed" ? (
        <Text as="p" className={styles.setupError} role="alert" variant="body">
          Synchronization state is unavailable.
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

import { Button, StatePanel } from "@knpkv/rly/primitives"

/** A failed read with its cause in words and a button that reads it again. */
export function LoadFailed({
  description,
  onRetry,
  title
}: {
  readonly description: string
  readonly onRetry: () => void
  readonly title: string
}) {
  return (
    <StatePanel
      action={<Button onClick={onRetry}>Try again</Button>}
      announce="polite"
      description={description}
      title={title}
      tone="critical"
    />
  )
}

export interface ConfigUnavailableViewProps {
  readonly path: string | null
  /** Non-null when the owner session is unavailable; otherwise the panel offers a config retry. */
  readonly connectionDetail: string | null
  readonly onRetry: () => void
}

/** Config failure presentation; the caller supplies the authenticated path, session detail, and retry. */
export function ConfigUnavailableView({ connectionDetail, onRetry, path }: ConfigUnavailableViewProps) {
  if (connectionDetail !== null) {
    return (
      <StatePanel
        announce="polite"
        description={connectionDetail}
        title="This browser isn't signed in"
        tone="caution"
      />
    )
  }
  return (
    <LoadFailed
      description={`The CodeCommit server did not return its settings. If it is running, check ${path ?? "its config file"}, then try again.`}
      onRetry={onRetry}
      title="Settings unavailable"
    />
  )
}

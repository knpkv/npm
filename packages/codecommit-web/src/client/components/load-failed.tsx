/**
 * The in-page state for a read that failed: what could not be read, where to look, and a retry.
 * Settings tabs and Statistics render it instead of a bare error line, so the failure keeps the page
 * and still reads as an error when colour is unavailable.
 *
 * @module
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Button, StatePanel } from "@knpkv/rly/primitives"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { configPathQueryAtom, configQueryAtom } from "../atoms/app.js"

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

/** The settings tabs' state when the server's config could not be read; names the file when the server says which. */
export function ConfigUnavailable() {
  const retry = useAtomRefresh(configQueryAtom)
  const path = useAtomValue(configPathQueryAtom)
  const file = AsyncResult.isSuccess(path) ? path.value.path : "its config file"
  return (
    <LoadFailed
      description={`The CodeCommit server did not return its settings. If it is running, check ${file}, then try again.`}
      onRetry={retry}
      title="Settings unavailable"
    />
  )
}

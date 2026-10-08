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
import { connectionDetail, streamConnectionAtom } from "../connection.js"

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

/**
 * The settings tabs' state when the server's config could not be read; names the file when the server
 * says which. A browser without a session can't read anything, and its fix is a new sign-in link, not
 * the config file, so that case says so instead.
 */
export function ConfigUnavailable() {
  const retry = useAtomRefresh(configQueryAtom)
  const path = useAtomValue(configPathQueryAtom)
  const connection = useAtomValue(streamConnectionAtom)
  const file = AsyncResult.isSuccess(path) ? path.value.path : "its config file"
  if (connection._tag === "Unauthenticated") {
    return (
      <StatePanel
        announce="polite"
        description={connectionDetail(connection) ?? ""}
        title="This browser isn't signed in"
        tone="caution"
      />
    )
  }
  return (
    <LoadFailed
      description={`The CodeCommit server did not return its settings. If it is running, check ${file}, then try again.`}
      onRetry={retry}
      title="Settings unavailable"
    />
  )
}

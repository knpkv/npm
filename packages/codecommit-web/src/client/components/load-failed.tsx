/**
 * The in-page state for a read that failed: what could not be read, where to look, and a retry.
 * Settings tabs and Statistics render it instead of a bare error line, so the failure keeps the page
 * and still reads as an error when colour is unavailable.
 *
 * @module
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { configPathQueryAtom, configQueryAtom } from "../atoms/app.js"
import { connectionDetail, streamConnectionAtom } from "../connection.js"
import { ConfigUnavailableView } from "./config-unavailable-view.js"

/**
 * The settings tabs' state when the server's config could not be read; names the file when the server
 * says which. A browser without a session can't read anything, and its fix is a new sign-in link, not
 * the config file, so that case says so instead.
 */
export function ConfigUnavailable() {
  const retry = useAtomRefresh(configQueryAtom)
  const path = useAtomValue(configPathQueryAtom)
  const connection = useAtomValue(streamConnectionAtom)
  return (
    <ConfigUnavailableView
      connectionDetail={connection._tag === "Unauthenticated" ? (connectionDetail(connection) ?? "") : null}
      onRetry={retry}
      path={AsyncResult.isSuccess(path) ? path.value.path : null}
    />
  )
}

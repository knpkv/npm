/**
 * @title Read permission bar: answers a read prompt without blocking the page
 *
 * CodeCommit asks before every AWS call (zero-trust). A read prompt shows here, docked at the bottom edge,
 * so the reader can see what's waiting on it. "Allow every read" grants the whole read category once;
 * writes keep their per-call modal.
 *
 * @module
 */
import { useAtomSet } from "@effect/atom-react"
import { Button, Notice } from "@knpkv/rly/primitives"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Predicate from "effect/Predicate"
import { useState } from "react"
import type { AppState } from "../atoms/app.js"
import { permissionRespondAtom, permissionsCategoryUpdateAtom } from "../atoms/app.js"
import { usePublishedBlockSize } from "../hooks/usePublishedBlockSize.js"
import styles from "./permission-bar.module.css"

/**
 * "2 reads are waiting: Get identity for dev and List PRs for dev." Only reads queued now in the
 * server process are counted; at most three are named, then "and N more".
 */
export const waitingReadsText = (pending: NonNullable<AppState["pendingReads"]>): string | null => {
  if (pending.count < 2) return null
  const named = pending.contexts.slice(0, 3)
  const rest = pending.count - named.length
  const list =
    rest > 0
      ? `${named.join(", ")} and ${String(rest)} more`
      : named.length === 1
        ? named[0]
        : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`
  return `${String(pending.count)} reads are waiting: ${list}.`
}

export function PermissionBar({
  pendingReads,
  prompt
}: {
  readonly pendingReads?: AppState["pendingReads"]
  readonly prompt: NonNullable<AppState["permissionPrompt"]>
}) {
  const waiting = pendingReads === undefined ? null : waitingReadsText(pendingReads)
  // Shared with Relay's panel, which ends above the bar instead of on its actions.
  const publishBlockSize = usePublishedBlockSize<HTMLDivElement>("--app-bottom-inset")
  const respond = useAtomSet(permissionRespondAtom)
  const grantCategory = useAtomSet(permissionsCategoryUpdateAtom, { mode: "promiseExit" })
  const [failure, setFailure] = useState<string | null>(null)

  const allowEveryRead = () => {
    setFailure(null)
    void grantCategory({ payload: { category: "read", state: "always_allow" } }).then((exit) => {
      // Saving the grant releases this call and every other read already waiting on the server. A failed
      // save says so and leaves the calls waiting.
      if (Exit.isSuccess(exit)) return
      const error = Cause.squash(exit.cause)
      const reason = Predicate.isError(error) ? error.message : "the server didn't answer"
      setFailure(`Couldn't save the grant: ${reason}. This call still waits.`)
    })
  }

  return (
    // Docked to the bottom edge: a prompt arriving after the page has painted must not push it down.
    // Its height is published, and the page keeps that much room at its end so nothing hides under it.
    // Marked so a modal drawer steps aside for it: the page behind a modal is inert.
    <div className={styles.dock} data-needs-answer="" ref={publishBlockSize}>
      <Notice
        action={
          <div className={styles.actions}>
            <Button onClick={() => respond({ payload: { id: prompt.id, response: "allow_once" } })} size="compact">
              Allow once
            </Button>
            <Button onClick={allowEveryRead} size="compact" variant="secondary">
              Allow every read
            </Button>
            <Button
              onClick={() => respond({ payload: { id: prompt.id, response: "deny" } })}
              size="compact"
              variant="quiet"
            >
              Deny
            </Button>
          </div>
        }
        announce="polite"
        tone="caution"
      >
        {/* Short enough for a phone: what waits, then what "every read" means. */}
        {waiting === null ? <>Allow CodeCommit to read from AWS: {prompt.context}?</> : waiting} Every read covers pull
        requests, approvals and identity; changes still ask.
        {failure === null ? null : <span className={styles.failure}> {failure}</span>}
      </Notice>
    </div>
  )
}

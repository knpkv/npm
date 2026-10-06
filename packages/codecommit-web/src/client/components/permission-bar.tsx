/**
 * @title Read permission bar: answers a read prompt without blocking the page
 *
 * CodeCommit asks before every AWS call (zero-trust). A read prompt shows here, inline above the page,
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
import styles from "./permission-bar.module.css"

export function PermissionBar({ prompt }: { readonly prompt: NonNullable<AppState["permissionPrompt"]> }) {
  const respond = useAtomSet(permissionRespondAtom)
  const grantCategory = useAtomSet(permissionsCategoryUpdateAtom, { mode: "promiseExit" })
  const [failure, setFailure] = useState<string | null>(null)

  const allowEveryRead = () => {
    setFailure(null)
    void grantCategory({ payload: { category: "read", state: "always_allow" } }).then((exit) => {
      // The standing grant is saved; this call goes ahead under it. A failed save says so and leaves the call waiting.
      if (Exit.isSuccess(exit)) {
        respond({ payload: { id: prompt.id, response: "allow_once" } })
        return
      }
      const error = Cause.squash(exit.cause)
      const reason = Predicate.isError(error) ? error.message : "the server didn't answer"
      setFailure(`Couldn't save the grant: ${reason}. This call still waits.`)
    })
  }

  return (
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
      className={styles.bar}
      tone="caution"
    >
      CodeCommit asks before reading from AWS: {prompt.context}. Allowing every read covers pull requests, approval
      status and identity for all profiles; changes still ask each time.
      {failure === null ? null : <span className={styles.failure}> {failure}</span>}
    </Notice>
  )
}

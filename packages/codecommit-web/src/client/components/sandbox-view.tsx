import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { SandboxId } from "@knpkv/codecommit-core/Domain.js"
import { AsyncResult } from "effect/reactivity"
import { CopyIcon, EyeIcon, EyeOffIcon } from "lucide-react"
import { useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router"
import {
  appStateAtom,
  deleteSandboxAtom,
  restartSandboxAtom,
  sandboxCredentialsAtom,
  stopSandboxAtom
} from "../atoms/app.js"
import { SandboxViewContent } from "./sandbox-view-content.js"
import styles from "./sandbox.module.css"

const SandboxCredentialsBar = ({ sandboxId }: { readonly sandboxId: SandboxId }) => {
  const credentials = useAtomValue(sandboxCredentialsAtom(sandboxId))
  const [revealed, setRevealed] = useState(false)

  if (AsyncResult.isFailure(credentials)) {
    return (
      <div className={styles.credentialFailure} role="alert">
        Unable to load the code-server password. Reload the sandbox after checking the owner session.
      </div>
    )
  }

  const accessPassword = AsyncResult.isSuccess(credentials) ? credentials.value.password : null
  return (
    <div className={styles.credentialBar}>
      <span className={styles.credentialLabel}>Authenticated owner access</span>
      <code className={styles.credentialCode}>
        {accessPassword === null ? "Loading…" : revealed ? accessPassword : "••••••••••••"}
      </code>
      <div aria-label="Sandbox credential actions" className={styles.credentialActions} role="group">
        <button
          aria-label={revealed ? "Hide code-server password" : "Reveal code-server password"}
          className={styles.credentialButton}
          disabled={accessPassword === null}
          onClick={() => setRevealed((current) => !current)}
          type="button"
        >
          {revealed ? <EyeOffIcon aria-hidden="true" size={16} /> : <EyeIcon aria-hidden="true" size={16} />}
        </button>
        <button
          aria-label="Copy code-server password"
          className={styles.credentialButton}
          disabled={accessPassword === null}
          onClick={() => {
            if (accessPassword !== null) void navigator.clipboard.writeText(accessPassword)
          }}
          type="button"
        >
          <CopyIcon aria-hidden="true" size={16} />
        </button>
      </div>
    </div>
  )
}

/** Full-width authenticated sandbox route wired to atoms and router state. */
export function SandboxView() {
  const { sandboxId } = useParams<{ sandboxId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const state = useAtomValue(appStateAtom)
  const stopSandbox = useAtomSet(stopSandboxAtom)
  const restartSandbox = useAtomSet(restartSandboxAtom)
  const deleteSandbox = useAtomSet(deleteSandboxAtom)
  const navigate = useNavigate()
  return (
    <SandboxViewContent
      deleteSandbox={deleteSandbox}
      initialView={searchParams.get("view") === "logs" ? "logs" : "editor"}
      navigate={navigate}
      onViewChange={(view) =>
        setSearchParams(view === "logs" ? { view: "logs" } : {}, { preventScrollReset: true, replace: true })
      }
      renderCredentials={(id) => <SandboxCredentialsBar sandboxId={id} />}
      restartSandbox={restartSandbox}
      sandboxId={sandboxId}
      state={state}
      stopSandbox={stopSandbox}
    />
  )
}

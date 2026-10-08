import type { ReactElement } from "react"
import { useEffect, useId, useRef, useState } from "react"
import { Icon } from "../foundations/Icon.js"
import { cssClass, requireText } from "../internal/component.js"
import { Button } from "../primitives/Button.js"
import styles from "./RelaySetup.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Why a backend cannot run Relay; each has one repair, the host's `fix` text plus Check again. */
export type RlyRelayBackendCause = "NotInstalled" | "SignedOut" | "Misconfigured" | "NoCapability"

/**
 * A backend's status as the server reports it, plus the client's own Checking while it asks. Installed
 * (a version on PATH) is Unverified, never Ready: Ready follows a successful answer.
 */
export type RlyRelayBackendStatus =
  | { readonly _tag: "Checking" }
  | { readonly _tag: "Unverified"; readonly version?: string }
  | { readonly _tag: "Ready"; readonly detail?: string; readonly version?: string }
  | {
      readonly _tag: "Unavailable"
      readonly cause: RlyRelayBackendCause
      readonly fix: string
      readonly version?: string
    }

/** One agent backend Relay can run on (Codex, Claude), with its current status. */
export interface RlyRelayBackend {
  readonly id: string
  readonly label: string
  readonly status: RlyRelayBackendStatus
}

/** One thing to focus the review on ("Correctness", "Security"). */
export interface RlyRelaySetupFocus {
  readonly description?: string
  readonly label: string
  readonly value: string
}

/** Inputs for setup. */
export interface RelaySetupProps {
  readonly backends: ReadonlyArray<RlyRelayBackend>
  readonly focuses: ReadonlyArray<RlyRelaySetupFocus>
  /** Ask the server for this backend's status (Check now, Check again). */
  readonly onCheck: (backendId: string) => void
  readonly onSelectBackend: (backendId: string) => void
  readonly onSelectFocus: (value: string) => void
  readonly onStart: () => void
  readonly selectedBackend: string | undefined
  readonly selectedFocus: string | undefined
  /** The start button, "Review this pull request" unless the host names its first task. */
  readonly startLabel?: string
}

const causeWord = {
  Misconfigured: "Needs setup",
  NoCapability: "Can't review here",
  NotInstalled: "Not installed",
  SignedOut: "Signed out"
} satisfies Readonly<Record<RlyRelayBackendCause, string>>

const statusText = (status: RlyRelayBackendStatus): string => {
  switch (status._tag) {
    case "Checking":
      return "Checking…"
    case "Unverified":
      return "Not checked yet"
    case "Ready":
      return status.detail === undefined ? "Ready" : `Ready: ${status.detail}`
    case "Unavailable":
      return causeWord[status.cause]
  }
}

/**
 * Relay's in-panel setup (Relay UX decision): two steps, an agent then a focus, then start. Each backend
 * shows the server's status; only a Ready backend can be chosen, so an installed CLI is never taken
 * for a working one. A backend not checked yet offers Check now; an unavailable one names its cause,
 * the host's fix (run a login on this machine; rly never collects provider credentials) and Check
 * again. Status changes after a check are announced politely. Start stays reachable while unavailable
 * and says what is missing.
 */
export const RelaySetup = ({
  backends,
  focuses,
  onCheck,
  onSelectBackend,
  onSelectFocus,
  onStart,
  selectedBackend,
  selectedFocus,
  startLabel = "Review this pull request"
}: RelaySetupProps): ReactElement => {
  const name = useId()
  const reasonId = useId()
  const [announcement, setAnnouncement] = useState("")
  const previous = useRef(new Map(backends.map((backend) => [backend.id, backend.status._tag])))
  const chosen = backends.find((backend) => backend.id === selectedBackend)
  const reason =
    chosen === undefined || chosen.status._tag !== "Ready"
      ? "Choose an agent that is ready."
      : selectedFocus === undefined
        ? "Choose what to focus on."
        : undefined

  // A finished check is news: say the backend's new status once.
  useEffect(() => {
    for (const backend of backends) {
      const before = previous.current.get(backend.id)
      previous.current.set(backend.id, backend.status._tag)
      if (before === "Checking" && backend.status._tag !== "Checking") {
        setAnnouncement(`${backend.label}: ${statusText(backend.status)}`)
      }
    }
  }, [backends])

  return (
    <div className={style("root")}>
      <fieldset className={style("step")}>
        <legend className={style("legend")}>Agent</legend>
        <ul className={style("options")}>
          {backends.map((backend) => {
            const ready = backend.status._tag === "Ready"
            const statusId = `${name}-${backend.id}-status`
            return (
              <li className={style("option")} data-status={backend.status._tag} key={backend.id}>
                <label className={style("choice")}>
                  <input
                    aria-describedby={statusId}
                    checked={selectedBackend === backend.id}
                    disabled={!ready}
                    name={`${name}-backend`}
                    onChange={() => onSelectBackend(backend.id)}
                    type="radio"
                    value={backend.id}
                  />
                  <span className={style("label")}>{requireText(backend.label, "RelaySetup backend label")}</span>
                </label>
                <p className={style("status")} id={statusId}>
                  <Icon
                    decorative
                    name={
                      ready
                        ? "check"
                        : backend.status._tag === "Checking"
                          ? "loader"
                          : backend.status._tag === "Unavailable"
                            ? "alert"
                            : "clock"
                    }
                    size="small"
                  />
                  {statusText(backend.status)}
                  {"version" in backend.status && backend.status.version !== undefined
                    ? ` (${backend.status.version})`
                    : null}
                </p>
                {backend.status._tag === "Unavailable" ? (
                  <p className={style("fix")}>{requireText(backend.status.fix, "RelaySetup fix")}</p>
                ) : null}
                {backend.status._tag === "Unverified" || backend.status._tag === "Unavailable" ? (
                  <Button onClick={() => onCheck(backend.id)} type="button">
                    {backend.status._tag === "Unverified" ? "Check now" : "Check again"}
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      </fieldset>
      <fieldset className={style("step")}>
        <legend className={style("legend")}>Focus</legend>
        <ul className={style("options")}>
          {focuses.map((focus) => (
            <li className={style("option")} key={focus.value}>
              <label className={style("choice")}>
                <input
                  checked={selectedFocus === focus.value}
                  name={`${name}-focus`}
                  onChange={() => onSelectFocus(focus.value)}
                  type="radio"
                  value={focus.value}
                />
                <span className={style("label")}>{requireText(focus.label, "RelaySetup focus label")}</span>
              </label>
              {focus.description === undefined ? null : <p className={style("status")}>{focus.description}</p>}
            </li>
          ))}
        </ul>
      </fieldset>
      <div className={style("start")}>
        <Button
          aria-describedby={reason === undefined ? undefined : reasonId}
          aria-disabled={reason !== undefined}
          onClick={() => {
            if (reason === undefined) onStart()
          }}
          type="button"
          variant="primary"
        >
          {requireText(startLabel, "RelaySetup start label")}
        </Button>
        {reason === undefined ? null : (
          <p className={style("reason")} id={reasonId}>
            {reason}
          </p>
        )}
      </div>
      <p aria-live="polite" className={style("announcer")}>
        {announcement}
      </p>
    </div>
  )
}

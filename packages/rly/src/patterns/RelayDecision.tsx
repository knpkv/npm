import type { ReactElement } from "react"
import { useEffect, useId, useRef, useState } from "react"
import { Icon } from "../foundations/Icon.js"
import { RlyLink } from "../foundations/LinkProvider.js"
import { cssClass, requireText } from "../internal/component.js"
import { Button } from "../primitives/Button.js"
import styles from "./RelayDecision.module.css"

const style = (name: string): string => cssClass(styles, name)

/** The words for one write, written by the host for its action (no English conjugation in rly). */
export interface RlyRelayDecisionCopy {
  /** The question, future tense: "Post this comment on infra-core #12?" */
  readonly ask: string
  /** The confirm button: "Post comment". */
  readonly confirm: string
  /** The decline button: "Don't post". */
  readonly decline: string
  /** While the confirmed write runs: "Posting…". */
  readonly working: string
  /** Once the write finished with a receipt, past tense: "Posted". */
  readonly done: string
  /** What can be undone and where, only when the host knows it: "You can delete it in CodeCommit later." */
  readonly reversible?: string
}

/** One fact about where the write goes ("Pull request", "infra-core #12"); shown only as given. */
export interface RlyRelayDecisionTarget {
  readonly label: string
  readonly value: string
}

/** A write's display-safe receipt; the link, when present, opens what was written. */
export interface RlyRelayDecisionReceipt {
  readonly href?: string
  readonly summary: string
}

/**
 * Where the decision is. Confirmed means authorized and now writing, never that it was written; only
 * Done (the tool finished with a receipt) is past tense. Failed never claims nothing was written, and
 * carries a receipt when the host has one.
 */
export type RlyRelayDecisionState =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Confirmed" }
  | { readonly _tag: "Done"; readonly receipt: RlyRelayDecisionReceipt }
  | { readonly _tag: "Failed"; readonly cause: string; readonly receipt?: RlyRelayDecisionReceipt }
  | { readonly _tag: "Declined" }
  | { readonly _tag: "Expired" }

/** Inputs for one decision. */
export interface RelayDecisionProps {
  /** The exact text that would be written. */
  readonly body: string
  readonly copy: RlyRelayDecisionCopy
  /** The call this decision belongs to; a decision is announced once per id, across remounts. */
  readonly id: string
  readonly onConfirm: () => void
  readonly onDecline: () => void
  readonly state: RlyRelayDecisionState
  /**
   * Where it goes, at least one fact and only what the action really pins (a PR comment names the PR,
   * not a line). A write with no stated destination cannot be confirmed.
   */
  readonly target: readonly [RlyRelayDecisionTarget, ...ReadonlyArray<RlyRelayDecisionTarget>]
  /** "danger" for a destructive write (delete, force-merge), so it never looks like a comment. */
  readonly tone?: "default" | "danger"
}

/** Decisions already announced in this page, by call id and state, so reopening Relay stays quiet. */
const announced = new Set<string>()

const announcementFor = (state: RlyRelayDecisionState, ask: string): string | undefined => {
  switch (state._tag) {
    case "Pending":
      return ask
    case "Declined":
      return "Declined. Nothing was written."
    case "Expired":
      return "The run ended before you answered. Nothing was written."
    default:
      return undefined
  }
}

/**
 * Ask before one Relay write (Relay UX decision): the question, exactly where the write goes and the
 * exact text (in its own scroll when long), then Confirm or Don't, for this one call only, never
 * "allow all". The first press is latched until the host moves the state on, so a double click or a
 * held key cannot confirm twice. Pending, declined and expired are announced once per call, politely,
 * without moving focus; once the reader answers, focus moves to the outcome, where the receipt link is
 * the next stop. "Posting…" after confirming; past tense only with a receipt.
 */
export const RelayDecision = ({
  body,
  copy,
  id,
  onConfirm,
  onDecline,
  state,
  target,
  tone = "default"
}: RelayDecisionProps): ReactElement => {
  const askId = useId()
  const outcome = useRef<HTMLParagraphElement | null>(null)
  const root = useRef<HTMLElement | null>(null)
  const answered = useRef(false)
  const focusedOutcome = useRef(false)
  const pressed = useRef(false)
  const [announcement, setAnnouncement] = useState("")
  const ask = requireText(copy.ask, "RelayDecision ask")

  // A new call starts unanswered.
  useEffect(() => {
    answered.current = false
    focusedOutcome.current = false
  }, [id])

  // Only a different state (or call) releases the latch; a rerender with a fresh Pending object does not.
  useEffect(() => {
    pressed.current = false
  }, [id, state._tag])

  useEffect(() => {
    const words = announcementFor(state, ask)
    const key = `${id}:${state._tag}`
    if (words === undefined || announced.has(key)) return
    // A decline the reader just made here is heard through the focused outcome; don't say it twice.
    if (state._tag === "Declined" && answered.current) {
      announced.add(key)
      return
    }
    // Cleared, then filled a frame later, so the same question for the next call is still a change;
    // marked announced only when actually set, so a cancelled frame (StrictMode, a quick rerender)
    // does not swallow it.
    setAnnouncement("")
    const say = (): void => {
      announced.add(key)
      setAnnouncement(words)
    }
    const view = root.current?.ownerDocument.defaultView ?? null
    if (view === null) return say()
    const frame = view.requestAnimationFrame(say)
    return () => view.cancelAnimationFrame(frame)
    // The state's tag, not its object identity, decides what is said.
  }, [ask, id, state._tag])

  // After the reader answers, the buttons unmount: keep focus on the outcome instead of the page. Only
  // once, on leaving Pending: a later Confirmed → Done must not pull the reader back from the composer.
  useEffect(() => {
    if (state._tag === "Pending" || !answered.current || focusedOutcome.current) return
    focusedOutcome.current = true
    outcome.current?.focus()
  }, [state._tag])

  const answer = (choose: () => void) => () => {
    if (pressed.current) return
    pressed.current = true
    answered.current = true
    choose()
  }

  return (
    <section aria-labelledby={askId} className={style("root")} data-state={state._tag} ref={root} role="group">
      <p className={style("ask")} id={askId}>
        {ask}
      </p>
      {copy.reversible === undefined ? null : (
        <p className={style("meta")}>{requireText(copy.reversible, "RelayDecision reversible")}</p>
      )}
      <dl className={style("target")}>
        {target.map((row) => (
          <div className={style("row")} key={row.label}>
            <dt>{requireText(row.label, "RelayDecision target label")}</dt>
            <dd>{requireText(row.value, "RelayDecision target value")}</dd>
          </div>
        ))}
      </dl>
      {/* A named, focusable group (not a landmark, as a thread holds several), so a long body scrolls by keyboard without pushing the buttons away. */}
      <div aria-label="Exact text" className={style("body")} role="group" tabIndex={0}>
        <blockquote className={style("quote")}>{requireText(body, "RelayDecision body")}</blockquote>
      </div>
      {state._tag === "Pending" ? (
        <div className={style("actions")}>
          <Button
            className={tone === "danger" ? style("danger") : undefined}
            onClick={answer(onConfirm)}
            type="button"
            variant="primary"
          >
            {requireText(copy.confirm, "RelayDecision confirm")}
          </Button>
          <Button onClick={answer(onDecline)} type="button">
            {requireText(copy.decline, "RelayDecision decline")}
          </Button>
        </div>
      ) : (
        <p className={style("outcome")} ref={outcome} tabIndex={-1}>
          <Outcome copy={copy} state={state} />
        </p>
      )}
      <p aria-live="polite" className={style("announcer")}>
        {announcement}
      </p>
    </section>
  )
}

const Receipt = ({ receipt }: { readonly receipt: RlyRelayDecisionReceipt }): ReactElement => {
  const summary = requireText(receipt.summary, "RelayDecision receipt")
  return receipt.href === undefined ? <>{summary}</> : <RlyLink href={receipt.href}>{summary}</RlyLink>
}

const Outcome = ({ copy, state }: { readonly copy: RlyRelayDecisionCopy; readonly state: RlyRelayDecisionState }) => {
  switch (state._tag) {
    case "Pending":
      return null
    case "Confirmed":
      return (
        <>
          <Icon decorative name="loader" size="small" />
          {requireText(copy.working, "RelayDecision working")}
        </>
      )
    case "Done":
      return (
        <>
          <Icon decorative name="check" size="small" />
          {requireText(copy.done, "RelayDecision done")}. <Receipt receipt={state.receipt} />
        </>
      )
    case "Failed":
      return (
        <>
          <Icon decorative name="alert" size="small" />
          {requireText(state.cause, "RelayDecision failure")} It may or may not have gone through; check before trying
          again.
          {state.receipt === undefined ? null : (
            <>
              {" "}
              <Receipt receipt={state.receipt} />
            </>
          )}
        </>
      )
    case "Declined":
      return <>You declined. Nothing was written.</>
    case "Expired":
      return <>The run ended before you answered. Nothing was written.</>
  }
}

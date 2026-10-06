import { type ComponentPropsWithRef, type ReactElement, type ReactNode, useId } from "react"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import { Button } from "../primitives/Button.js"
import styles from "./DecisionBar.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Machine-readable placement choices for a DecisionBar. */
export const RLY_DECISION_BAR_VARIANTS = defineVariants({
  placement: {
    inline: {
      className: style("inline"),
      purpose: "In the flow of the detail it decides",
      tokens: ["color-text-1", "color-text-2"]
    },
    sticky: {
      className: style("sticky"),
      purpose: "Pinned to the bottom of a phone viewport while its target is open, at thumb reach",
      tokens: ["color-canvas", "color-border-1"]
    }
  }
})

/** Default DecisionBar placement. */
export const RLY_DECISION_BAR_DEFAULT_VARIANTS = defineVariants({ placement: "inline" })

/** Where the bar sits. */
export type RlyDecisionBarPlacement = keyof typeof RLY_DECISION_BAR_VARIANTS.placement

/**
 * What the bar can do right now. `ready` enables both actions; `off` keeps them focusable but
 * inert and points them at `reason`; `sending` waits for the server's answer, never assuming it.
 */
export type RlyDecisionBarState =
  | { readonly _tag: "ready" }
  | { readonly _tag: "off"; readonly reason: string }
  | { readonly _tag: "sending"; readonly action: "approve" | "reject" }

/** Presentation-only DecisionBar props. */
export type DecisionBarProps = Omit<ComponentPropsWithRef<"div">, "children" | "title"> & {
  /** Visible approve label. Defaults to "Approve". */
  readonly approveLabel?: string
  /** Time left on the decision, shown after the target ("4m 12s left"). */
  readonly clock?: ReactNode
  /** One line under the actions, such as what happens if the request expires first. */
  readonly note?: ReactNode
  readonly onApprove: () => void
  readonly onReject: () => void
  /** Defaults to `inline`. */
  readonly placement?: RlyDecisionBarPlacement
  /** Visible reject label. Defaults to "Reject". */
  readonly rejectLabel?: string
  readonly state: RlyDecisionBarState
  /**
   * The server's answer once a sent decision settles, such as "Approved on the hub." or
   * "Refused: the request expired before your approval arrived.". It is announced through the
   * bar's status region, the same one that says a decision is waiting for the server.
   */
  readonly status?: string
  /** What is being decided, named in full ("Reassign Rotate signing keys from arch to arch-b"). */
  readonly target: string
}

/**
 * Approve or reject one named target. The target and its clock stay visible above the actions,
 * and both buttons carry the target in their accessible names, so a tap never decides the wrong
 * thing. An `off` decision stays focusable with its reason linked; a sent decision waits for the
 * server, and the caller passes the server's answer (including a refusal) as `status`, never an
 * optimistic one. Both are announced through one status region that stays mounted.
 */
export const DecisionBar = ({
  approveLabel = "Approve",
  className,
  clock,
  note,
  onApprove,
  onReject,
  placement = RLY_DECISION_BAR_DEFAULT_VARIANTS.placement,
  rejectLabel = "Reject",
  state,
  status,
  target,
  ...props
}: DecisionBarProps): ReactElement => {
  const visibleTarget = requireText(target, "DecisionBar target")
  const id = useId()
  const reasonId = `rly-decision-bar-reason-${id}`
  const statusId = `rly-decision-bar-status-${id}`
  const inert = state._tag !== "ready"
  const reason = state._tag === "off" ? state.reason : undefined
  // Mounted in every state, so a screen reader announces what lands in it: the waiting line while
  // sending, then the caller's `status` with the server's answer.
  const statusText =
    state._tag === "sending"
      ? `${state.action === "approve" ? approveLabel : rejectLabel} sent; waiting for the server's answer.`
      : (status ?? "")
  const describedBy = reason !== undefined ? reasonId : state._tag === "sending" ? statusId : undefined
  const guarded = (action: () => void) => () => {
    if (!inert) action()
  }
  return (
    <div
      {...props}
      aria-busy={state._tag === "sending" ? "true" : undefined}
      className={classNames(style("root"), RLY_DECISION_BAR_VARIANTS.placement[placement].className, className)}
      data-rly-decision-bar=""
      data-state={state._tag}
    >
      <p className={style("target")}>
        {visibleTarget}
        {clock === undefined ? null : (
          <>
            {", "}
            <span className={style("clock")}>{clock}</span>
          </>
        )}
      </p>
      <div className={style("actions")}>
        <Button
          aria-describedby={describedBy}
          aria-disabled={inert ? true : undefined}
          aria-label={`${approveLabel}: ${visibleTarget}`}
          onClick={guarded(onApprove)}
          variant={inert ? "secondary" : "primary"}
        >
          {approveLabel}
        </Button>
        <Button
          aria-describedby={describedBy}
          aria-disabled={inert ? true : undefined}
          aria-label={`${rejectLabel}: ${visibleTarget}`}
          onClick={guarded(onReject)}
          variant="secondary"
        >
          {rejectLabel}
        </Button>
      </div>
      {reason === undefined ? null : (
        <p className={style("reason")} id={reasonId}>
          {reason}
        </p>
      )}
      <p className={style("status")} id={statusId} role="status">
        {statusText}
      </p>
      {note === undefined ? null : <p className={style("note")}>{note}</p>}
    </div>
  )
}

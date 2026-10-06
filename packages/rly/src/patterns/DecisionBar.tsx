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
  /** What is being decided, named in full ("Reassign Rotate signing keys from arch to arch-b"). */
  readonly target: string
}

/**
 * Approve or reject one named target. The target and its clock stay visible above the actions,
 * and both buttons carry the target in their accessible names, so a tap never decides the wrong
 * thing. An `off` decision stays focusable with its reason linked; a sent decision waits for the
 * server, and the caller shows the server's answer (including a refusal), never an optimistic one.
 */
export const DecisionBar = ({
  approveLabel = "Approve",
  className,
  clock,
  note,
  onApprove,
  onReject,
  placement = "inline",
  rejectLabel = "Reject",
  state,
  target,
  ...props
}: DecisionBarProps): ReactElement => {
  const visibleTarget = requireText(target, "DecisionBar target")
  const reasonId = `rly-decision-bar-${useId()}`
  const inert = state._tag !== "ready"
  const reason =
    state._tag === "off"
      ? state.reason
      : state._tag === "sending"
        ? `${state.action === "approve" ? approveLabel : rejectLabel} sent; waiting for the server's answer.`
        : undefined
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
          aria-describedby={reason === undefined ? undefined : reasonId}
          aria-disabled={inert ? true : undefined}
          aria-label={`${approveLabel}: ${visibleTarget}`}
          onClick={guarded(onApprove)}
          variant={inert ? "secondary" : "primary"}
        >
          {approveLabel}
        </Button>
        <Button
          aria-describedby={reason === undefined ? undefined : reasonId}
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
      {note === undefined ? null : <p className={style("note")}>{note}</p>}
    </div>
  )
}

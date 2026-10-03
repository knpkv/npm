import * as Predicate from "effect/Predicate"
import { useEffect, useRef, type ReactNode } from "react"

/** Focus returns to the trigger, or its week when saving removes that suggestion, without scrolling. */
export const EditorFrame = (props: {
  readonly children: ReactNode
  readonly identity: string
  readonly busy: boolean
  readonly label: string
  readonly onClose: () => void
}) => {
  const frame = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    const triggerId = previous?.id
    const week = previous?.closest<HTMLElement>(".jcf-week-view")
    frame.current?.focus({ preventScroll: true })
    return () => {
      // Rollback may recreate the suggestion after its optimistic preview removed the original node.
      const replacement = triggerId !== undefined && triggerId !== "" ? document.getElementById(triggerId) : null
      const target = previous?.isConnected === true ? previous : (replacement ?? week)
      if (target != null && "focus" in target && Predicate.isFunction(target.focus) && target.isConnected)
        target.focus({ preventScroll: true })
    }
  }, [props.identity])
  return (
    <aside
      ref={frame}
      className="jcf-editor"
      tabIndex={-1}
      aria-label={props.label}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !props.busy) {
          event.stopPropagation()
          props.onClose()
        }
      }}
    >
      <fieldset className="jcf-editor-fields" disabled={props.busy}>
        {props.children}
      </fieldset>
    </aside>
  )
}

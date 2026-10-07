import * as Predicate from "effect/Predicate"
import { useEffect, useRef, type ReactNode } from "react"

/**
 * Opening focuses the editor's heading; closing returns focus to the trigger, or its week when saving
 * removes that suggestion, without scrolling. A `notice` (a failed write, a read error) leads the
 * frame, so feedback stays beside the fields it concerns instead of floating over the page.
 */
export const EditorFrame = (props: {
  readonly children: ReactNode
  readonly notice?: ReactNode
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
    const heading = frame.current?.querySelector<HTMLElement>(".jcf-editor-fields h2")
    if (heading == null) frame.current?.focus({ preventScroll: true })
    else {
      heading.tabIndex = -1
      heading.focus({ preventScroll: true })
    }
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
      {props.notice === undefined ? null : <div className="jcf-editor-notice">{props.notice}</div>}
      <fieldset className="jcf-editor-fields" disabled={props.busy}>
        {props.children}
      </fieldset>
    </aside>
  )
}

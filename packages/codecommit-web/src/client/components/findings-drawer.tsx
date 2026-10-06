/**
 * Where the Relay findings pane goes, and the drawer that holds it on mid-width columns.
 *
 * The review workspace shows Relay as a third column when its grid is wide, and stacked under
 * the diff on narrow screens. Between those, a third column would squeeze the diff, so the pane
 * moves into a native modal `<dialog>` opened from a header button ("Relay" before a review,
 * "Findings (n)" after): Esc closes it, and the browser returns focus to that button. The command
 * palette shortcut closes it too, so the palette does not open behind the modal. The findings and
 * the selection live in the workspace and survive a move between placements; the pane itself
 * remounts, so DOM-only state (an expanded Evidence section, the deck's scroll) resets on a resize.
 *
 * @module
 */
import { type ReactNode, type RefObject, useEffect, useRef } from "react"
import { isCommandPaletteShortcut } from "./command-palette.js"
import styles from "./findings-drawer.module.css"

/**
 * `column`: a third column beside the file tree and diff. `drawer`: in the dialog, the grid keeps
 * file tree and diff. `inline`: in the grid, where the stylesheet stacks it (phones, and the
 * first render before the grid is measured).
 */
export type FindingsPlacement = "column" | "drawer" | "inline"

/**
 * Decided from the workspace grid's own width, in rem: three columns need their minimums
 * (10 + 28 + 31 = 69); file tree beside diff needs 12 + 24 = 36. Below that the grid stacks.
 */
export const findingsPlacement = (gridWidth: number | undefined, remPx: number): FindingsPlacement => {
  if (gridWidth === undefined) return "inline"
  if (gridWidth >= 69 * remPx) return "column"
  return gridWidth > 36 * remPx ? "drawer" : "inline"
}

/** The modal drawer; `open` is controlled, and Esc or Close report back through `onClose`. */
export function FindingsDrawer({
  children,
  onClose,
  open,
  returnFocus,
  title
}: {
  readonly children: ReactNode
  readonly onClose: () => void
  readonly open: boolean
  /** Where focus goes when the drawer closes with nothing else focused, e.g. after it opened itself. */
  readonly returnFocus: RefObject<HTMLElement | null>
  readonly title: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])
  return (
    <dialog
      aria-labelledby="findings-drawer-title"
      className={styles.drawer}
      onClose={() => {
        // The browser restores focus to the element that opened the dialog. When the drawer opened
        // itself on a resize, that element has unmounted and focus would fall to the page body.
        if (document.activeElement === null || document.activeElement === document.body) returnFocus.current?.focus()
        onClose()
      }}
      onKeyDown={(event) => {
        if (isCommandPaletteShortcut(event)) onClose()
      }}
      ref={dialog}
    >
      <header className={styles.head}>
        <h2 className={styles.title} id="findings-drawer-title">
          {title}
        </h2>
        <button className={styles.close} onClick={onClose} type="button">
          Close
        </button>
      </header>
      <div className={styles.body}>{children}</div>
    </dialog>
  )
}

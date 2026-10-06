/**
 * Where the Relay findings pane goes, and the drawer that holds it on mid-width columns.
 *
 * The review workspace shows Relay as a third column when its grid is wide, and stacked under
 * the diff on narrow screens. Between those, a third column would squeeze the diff, so the pane
 * moves into a native modal `<dialog>` opened from a header button ("Relay" before a review,
 * "Findings (n)" after): Esc closes it, and the browser returns focus to that button. Any other
 * dialog opening meanwhile (the command palette, a permission prompt) closes it first, so that
 * dialog is never left inert behind the modal. The findings and
 * the selection live in the workspace and survive a move between placements; the pane itself
 * remounts, so DOM-only state (an expanded Evidence section, the deck's scroll) resets on a resize.
 *
 * @module
 */
import { type ReactNode, useEffect, useRef } from "react"
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
  /**
   * Where focus goes when the drawer closes and would otherwise leave it on the page body or inside
   * the closed dialog, e.g. after it opened itself on a resize.
   */
  readonly returnFocus: () => HTMLElement | null
  readonly title: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])
  // A native modal sits above every portal-based dialog, which it would leave inert behind it (the
  // command palette, a permission prompt). So the drawer steps aside for any other dialog: it closes
  // as soon as one appears, and hands it the focus it could not take while the modal was open.
  useEffect(() => {
    const element = dialog.current
    if (!open || element === null) return
    const observer = new MutationObserver(() => {
      const other = [...document.querySelectorAll<HTMLElement>("[role='dialog'], [role='alertdialog']")].find(
        (candidate) => !element.contains(candidate)
      )
      if (other === undefined || !element.open) return
      element.close()
      // That dialog tried to take focus while the modal still made it inert; give it focus now.
      if (!other.contains(document.activeElement)) {
        const first = other.querySelector<HTMLElement>(
          "input, textarea, select, button, [href], [tabindex]:not([tabindex='-1'])"
        )
        ;(first ?? other).focus()
      }
      // Its own focus restore points into the closed drawer; when it goes and focus falls to the
      // page body, hand focus to the drawer's return target instead.
      const handoff = new MutationObserver(() => {
        if (other.isConnected) return
        handoff.disconnect()
        // After that dialog's own focus restore has run.
        window.requestAnimationFrame(() => {
          if (document.activeElement === null || document.activeElement === document.body) returnFocus()?.focus()
        })
      })
      handoff.observe(document.body, { childList: true, subtree: true })
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [open])
  return (
    <dialog
      aria-labelledby="findings-drawer-title"
      className={styles.drawer}
      onClose={() => {
        // The browser restores focus to the element that opened the dialog. When the drawer opened
        // itself on a resize, that element has unmounted, and focus is left on the page body or on
        // a control inside the now-closed dialog.
        const active = document.activeElement
        if (active === null || active === document.body || dialog.current?.contains(active) === true) {
          returnFocus()?.focus()
        }
        onClose()
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

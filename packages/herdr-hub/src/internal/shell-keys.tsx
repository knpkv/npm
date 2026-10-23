import { Dialog } from "@knpkv/rly/primitives"
import { Predicate } from "effect"
import type { ReactElement } from "react"

/** Every shortcut, as the `?` overlay lists them. */
const shortcutList: ReadonlyArray<{ readonly keys: ReadonlyArray<string>; readonly action: string }> = [
  { action: "Go to Approvals", keys: ["g", "a"] },
  { action: "Go to Connect", keys: ["g", "c"] },
  { action: "Go to Work", keys: ["g", "w"] },
  { action: "Go to Usage", keys: ["g", "u"] },
  { action: "Search agents", keys: ["Ctrl", "K"] },
  { action: "Show these shortcuts", keys: ["?"] }
]

export const ShortcutsDialog = ({
  onOpenChange,
  open,
  restoreFocus
}: {
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
  readonly restoreFocus?: (opener: HTMLElement | null) => boolean
}): ReactElement => (
  <Dialog.Root onOpenChange={onOpenChange} open={open}>
    <Dialog.Content
      className="fleet-shortcuts-dialog"
      description="Type a sequence with no field focused; Ctrl+K works anywhere. The tabs are also reachable with Tab, then the arrow keys."
      title="Keyboard shortcuts"
      {...(restoreFocus === undefined ? {} : { restoreFocus })}
    >
      <dl className="fleet-shortcuts">
        {shortcutList.map(({ action, keys }) => (
          <div key={action}>
            <dt>
              {keys.map((key, index) => (
                <span key={key}>
                  {index > 0 ? (keys[0] === "Ctrl" ? " + " : " then ") : null}
                  <kbd>{key}</kbd>
                </span>
              ))}
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
      {/* Esc closes it too, but a phone has no Esc: the close action is always on screen. */}
      <div className="fleet-shortcuts-actions">
        <Dialog.Close size="compact" variant="secondary">
          Close
        </Dialog.Close>
      </div>
    </Dialog.Content>
  </Dialog.Root>
)

/** How long Ctrl+K keeps trying to reach agent search while the Connect tab shows and loads. */
const SEARCH_FOCUS_MS = 3000

/**
 * Focuses the element `id` once it is mounted and shown. Switching to Connect renders its panel a
 * frame or more later, and the search field can mount later still, so one attempt can land before
 * it exists or while it is hidden: keep trying each frame until it has focus, for a bounded time.
 */
export const focusWhenShown = (id: string, deadline: number = performance.now() + SEARCH_FOCUS_MS): (() => void) => {
  let frame: number
  const focus = (now: number): void => {
    const element = document.getElementById(id)
    const filters = element?.closest<HTMLElement>("[data-connect-home-filters]")
    if (filters?.hidden === true) {
      const reveal = filters.parentElement?.querySelector<HTMLButtonElement>("[data-connect-search-reveal]")
      if (
        reveal?.getAttribute("aria-expanded") === "false" &&
        reveal.closest('[aria-hidden="true"], [inert], [hidden]') === null
      )
        reveal.click()
    }
    if (element !== null && element.closest('[aria-hidden="true"], [inert], [hidden]') === null) element.focus()
    if (element !== null && document.activeElement === element) return
    if (now < deadline) frame = window.requestAnimationFrame(focus)
  }
  frame = window.requestAnimationFrame(focus)
  return () => window.cancelAnimationFrame(frame)
}

export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!Predicate.hasProperty(target, "nodeName") || !Predicate.isString(target.nodeName)) return false
  if (target.nodeName === "INPUT" || target.nodeName === "TEXTAREA" || target.nodeName === "SELECT") return true
  if (Predicate.hasProperty(target, "isContentEditable") && target.isContentEditable === true) return true
  return Predicate.hasProperty(target, "role") && target.role === "textbox"
}

/**
 * Exact approvals win over their tab; modal portals own focus while their module slot is hidden.
 * Pass the navigation-time focus origin to preserve targets claimed by earlier child layout effects.
 * `ring: false` focuses without painting a focus ring: a cold load lands on the page before anyone
 * pressed a key, so the ring would show on a tab nobody reached by keyboard. The next Tab shows it.
 */
export const focusModulePage = (
  module: string,
  page: string,
  preserveOwnerFocus = false,
  focusBeforeNavigation: Element | null = document.activeElement,
  ring = true
): (() => void) => {
  let cancelSearch: (() => void) | undefined
  const previousFocus = focusBeforeNavigation
  const frame = window.requestAnimationFrame(() => {
    const slot = [...document.querySelectorAll<HTMLElement>("[data-module]")].find(
      (element) => element.dataset.module === module && element.hidden === false
    )
    if (slot !== undefined && slot.closest('[aria-hidden="true"], [inert]') !== null) return
    if (
      preserveOwnerFocus === true &&
      document.activeElement !== previousFocus &&
      slot?.contains(document.activeElement) === true
    )
      return
    const tab = [...(slot?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find(
      (element) => element.dataset.tabValue === page
    )
    // A module may portal its page links into shell chrome; `data-module-owner` keeps them its own.
    const owned = [...document.querySelectorAll<HTMLElement>("[data-module-owner]")].filter(
      (element) => element.dataset.moduleOwner === module
    )
    const pageLink = [slot, ...owned]
      .flatMap((root) => [...(root?.querySelectorAll<HTMLElement>("[data-module-page]") ?? [])])
      .find((element) => element.dataset.modulePage === page)
    const dialog = slot?.querySelector('[role="dialog"]')
    if (dialog !== null && dialog !== undefined) return
    const search = slot?.querySelector("#connect-agent-search")
    if (page === "connect" && search !== null && search !== undefined) {
      cancelSearch = focusWhenShown("connect-agent-search")
      return
    }
    const approval = page === "approvals" ? slot?.querySelector<HTMLElement>('[data-approval-target="true"]') : null
    const target = approval ?? tab ?? pageLink ?? document.getElementById("main")
    if (target !== null && target !== undefined && target.closest('[aria-hidden="true"], [inert], [hidden]') === null)
      target.focus(ring ? { preventScroll: true } : { preventScroll: true, focusVisible: false })
  })
  return () => {
    window.cancelAnimationFrame(frame)
    cancelSearch?.()
  }
}

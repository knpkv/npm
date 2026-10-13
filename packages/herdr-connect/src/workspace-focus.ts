export type ConnectWorkspaceFocusFailureReason = "detached_element" | "focus_rejected"

/** Tell the user how to recover without exposing the browser transition's internal code. */
export const connectWorkspaceFocusFailureMessage = (reason: ConnectWorkspaceFocusFailureReason): string => {
  const messages = {
    detached_element: "The terminal view changed before focus could move. Try again.",
    focus_rejected: "Couldn’t switch views while another panel has focus. Close it and try again."
  } satisfies Record<ConnectWorkspaceFocusFailureReason, string>
  return messages[reason]
}

export type ConnectWorkspaceFocusTransition = { readonly _tag: "moved" } | {
  readonly _tag: "failed"
  readonly reason: ConnectWorkspaceFocusFailureReason
}

export interface ConnectWorkspaceElements {
  readonly directory: HTMLElement
  readonly terminal: HTMLElement
  readonly workspace: HTMLElement
}

export interface ConnectLockedWorkspaceFocusTransition {
  readonly releaseLock: () => void
  readonly transition: ConnectWorkspaceFocusTransition
}

const elementsAreAttached = (
  { directory, terminal, workspace }: ConnectWorkspaceElements,
  focusTarget: HTMLElement
): boolean =>
  workspace.isConnected &&
  workspace.contains(directory) &&
  workspace.contains(terminal) &&
  workspace.contains(focusTarget)

/** Uses the browser's active element as the focusability check after revealing the terminal. */
export const enterTerminalWorkspace = (
  elements: ConnectWorkspaceElements,
  focusTarget: HTMLElement
): ConnectWorkspaceFocusTransition => {
  if (!elementsAreAttached(elements, focusTarget)) return { _tag: "failed", reason: "detached_element" }

  elements.terminal.setAttribute("aria-hidden", "false")
  elements.terminal.inert = false
  elements.workspace.dataset.mode = "terminal"
  focusTarget.focus({ preventScroll: true })
  if (elements.workspace.ownerDocument.activeElement !== focusTarget) {
    elements.workspace.dataset.mode = "directory"
    elements.terminal.setAttribute("aria-hidden", "true")
    elements.terminal.inert = true
    return { _tag: "failed", reason: "focus_rejected" }
  }
  elements.directory.setAttribute("aria-hidden", "true")
  elements.directory.inert = true
  return { _tag: "moved" }
}

/** Acquires the document lock before revealing and focusing a connected terminal. */
export const enterTerminalWorkspaceWithLock = (
  elements: ConnectWorkspaceElements,
  focusTarget: HTMLElement,
  acquireLock: () => () => void
): ConnectLockedWorkspaceFocusTransition => {
  const releaseLock = acquireLock()
  try {
    return { releaseLock, transition: enterTerminalWorkspace(elements, focusTarget) }
  } catch (error) {
    releaseLock()
    throw error
  }
}

/** Uses the browser's active element as the focusability check before hiding the terminal. */
export const returnToDirectoryWorkspace = (
  elements: ConnectWorkspaceElements,
  focusTarget: HTMLElement
): ConnectWorkspaceFocusTransition => {
  if (!elementsAreAttached(elements, focusTarget)) return { _tag: "failed", reason: "detached_element" }

  elements.directory.setAttribute("aria-hidden", "false")
  elements.directory.inert = false
  elements.workspace.dataset.mode = "directory"
  focusTarget.focus({ preventScroll: true })
  if (elements.workspace.ownerDocument.activeElement !== focusTarget) {
    elements.directory.focus({ preventScroll: true })
  }
  if (
    elements.workspace.ownerDocument.activeElement !== focusTarget &&
    elements.workspace.ownerDocument.activeElement !== elements.directory
  ) {
    elements.workspace.focus({ preventScroll: true })
  }
  const shell = elements.workspace.closest<HTMLElement>(".connect-shell")
  if (
    elements.workspace.ownerDocument.activeElement !== focusTarget &&
    elements.workspace.ownerDocument.activeElement !== elements.directory &&
    elements.workspace.ownerDocument.activeElement !== elements.workspace &&
    shell !== null
  ) {
    shell.focus({ preventScroll: true })
  }
  const activeElement = elements.workspace.ownerDocument.activeElement
  const focusMoved = activeElement === focusTarget || activeElement === elements.directory ||
    activeElement === elements.workspace || activeElement === shell
  if (!focusMoved) {
    elements.workspace.dataset.mode = "terminal"
    elements.directory.setAttribute("aria-hidden", "true")
    elements.directory.inert = true
    return { _tag: "failed", reason: "focus_rejected" }
  }
  elements.terminal.setAttribute("aria-hidden", "true")
  elements.terminal.inert = true
  return { _tag: "moved" }
}

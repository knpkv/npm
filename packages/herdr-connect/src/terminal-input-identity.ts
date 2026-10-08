export type TerminalInputIdentityTarget = {
  id: string
  name: string
}

export const applyTerminalInputIdentity = (input: TerminalInputIdentityTarget): void => {
  input.id = "connect-terminal-input"
  input.name = "terminal-input"
}

/**
 * Focus the terminal's text input from inside the gesture that asked for it (a tap, a rail key).
 * Ghostty Web's `Terminal.focus()` focuses its container div instead, and iOS opens the keyboard
 * only for an editable control focused synchronously within the user's gesture. Keys, composition
 * and paste bubble from this input to Ghostty's container listeners, so input handling is unchanged.
 */
export const focusTerminalInput = (input: Pick<HTMLElement, "focus">): void => {
  input.focus({ preventScroll: true })
}

/**
 * Report whether the terminal's text input holds focus, as it changes: a tap, the Keyboard button,
 * or iOS dismissing its keyboard. The Keyboard button's pressed state follows this, so it never
 * disagrees with the screen. Returns the release.
 */
export const trackTerminalInputFocus = (
  input: Pick<HTMLElement, "addEventListener" | "removeEventListener">,
  onChange: (focused: boolean) => void
): () => void => {
  const focused = (): void => onChange(true)
  const blurred = (): void => onChange(false)
  input.addEventListener("focus", focused)
  input.addEventListener("blur", blurred)
  return () => {
    input.removeEventListener("focus", focused)
    input.removeEventListener("blur", blurred)
  }
}

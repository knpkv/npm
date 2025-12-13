/**
 * Keyboard navigation logic for column-based components.
 */
import type { KeyEvent } from "@opentui/core"

/**
 * Navigation direction from a key event.
 *
 * @category models
 */
export type NavDirection = "up" | "down" | "left" | "right" | "select" | "back" | "quit"

/**
 * Parses a key event into a navigation direction.
 *
 * @category parsing
 */
export const parseNavKey = (key: KeyEvent): NavDirection | undefined => {
  switch (key.name) {
    case "up":
    case "k":
      return "up"
    case "down":
    case "j":
      return "down"
    case "left":
    case "h":
      return "left"
    case "right":
    case "l":
      return "right"
    case "return":
      return "select"
    case "backspace":
      return "back"
    case "q":
    case "escape":
      return "quit"
    default:
      return undefined
  }
}

/**
 * Checks if a key is an action key (not navigation).
 *
 * @category parsing
 */
export const isActionKey = (key: KeyEvent): boolean => {
  const navKeys = ["up", "down", "left", "right", "k", "j", "h", "l", "return", "backspace", "q", "escape"]
  return !navKeys.includes(key.name)
}

import { textFromKeyboardKey } from "./keyboard-text.js"

export interface TextFilterInputKey {
  readonly char?: string
  readonly name: string
}

export interface TextFilterInputState {
  readonly active: boolean
  readonly text: string
}

export interface TextFilterInputTransition {
  readonly handled: boolean
  readonly state: TextFilterInputState
}

/** Resolves a batch action's scope from the synchronous filter state, including just-submitted text. */
export const textFilterActionScope = <Value extends string>(
  state: TextFilterInputState,
  values: ReadonlyArray<Value>
): Array<Value> | null => {
  const needle = state.text.toLowerCase()
  return needle.length === 0 ? null : values.filter((value) => value.toLowerCase().includes(needle))
}

/**
 * Advances filter input synchronously so pasted terminal key batches do not
 * depend on a React render occurring between individual key events.
 */
export const transitionTextFilterInput = (
  state: TextFilterInputState,
  key: TextFilterInputKey,
  canOpen: boolean
): TextFilterInputTransition => {
  if (!state.active) {
    const opensFilter = key.name === "/" || key.char === "/" || key.name === "f"
    return opensFilter && canOpen
      ? { handled: true, state: { active: true, text: state.text } }
      : { handled: false, state }
  }

  if (key.name === "escape") {
    return { handled: true, state: { active: false, text: "" } }
  }
  if (key.name === "return") {
    return { handled: true, state: { active: false, text: state.text } }
  }
  if (key.name === "backspace") {
    return { handled: true, state: { active: true, text: state.text.slice(0, -1) } }
  }

  const char = textFromKeyboardKey(key)
  return char && char.length === 1
    ? { handled: true, state: { active: true, text: state.text + char } }
    : { handled: true, state }
}

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

export interface SingleLineDraftTransition {
  readonly draft: string
  readonly submission: string | null
}

/** Advances a bounded dialog draft synchronously and snapshots the submitted text. */
export const transitionSingleLineDraft = (
  draft: string,
  key: TextFilterInputKey,
  maximumCharacters: number
): SingleLineDraftTransition => {
  if (key.name === "return") {
    const submission = draft.trim()
    return { draft, submission: submission.length === 0 ? null : submission }
  }
  if (key.name === "backspace") return { draft: draft.slice(0, -1), submission: null }
  const text = textFromKeyboardKey(key)
  return {
    draft: text === undefined ? draft : `${draft}${text}`.slice(0, maximumCharacters),
    submission: null
  }
}

export interface ParsedSettingsFilter {
  readonly status: "all" | "on" | "off"
  readonly name: string
}

export const parseSettingsFilter = (raw: string): ParsedSettingsFilter => {
  const lower = raw.toLowerCase()
  if (lower.startsWith("on:")) return { status: "on", name: lower.slice(3) }
  if (lower.startsWith("off:")) return { status: "off", name: lower.slice(4) }
  return { status: "all", name: lower }
}

/** Resolves a batch action's scope from the synchronous filter state, including just-submitted text. */
export const textFilterActionScope = <Value extends string>(
  state: TextFilterInputState,
  values: ReadonlyArray<Value>
): Array<Value> | null => {
  const needle = state.text.toLowerCase()
  return needle.length === 0 ? null : values.filter((value) => value.toLowerCase().includes(needle))
}

/** Resolves account actions against the same status and name subset visible in settings. */
export const settingsFilterActionScope = <Value extends string>(
  state: TextFilterInputState,
  accounts: ReadonlyArray<{ readonly enabled: boolean; readonly profile: Value }>
): Array<Value> | null => {
  const { name, status } = parseSettingsFilter(state.text)
  const statusScoped = accounts.filter((account) =>
    status === "all" || (status === "on" ? account.enabled : !account.enabled)
  ).map((account) => account.profile)
  const nameScoped = textFilterActionScope({ ...state, text: name }, statusScoped)
  return nameScoped ?? (status === "all" ? null : statusScoped)
}

/** Cycles the settings status prefix while preserving the original profile text. */
export const cycleSettingsFilterMode = (text: string, direction: "left" | "right"): string => {
  const modes: ReadonlyArray<"" | "on:" | "off:"> = ["", "on:", "off:"]
  const { status } = parseSettingsFilter(text)
  const currentMode: "" | "on:" | "off:" = status === "all" ? "" : `${status}:`
  const name = currentMode.length === 0 ? text : text.slice(currentMode.length)
  const index = modes.indexOf(currentMode)
  const nextIndex = direction === "right"
    ? (index + 1) % modes.length
    : (index - 1 + modes.length) % modes.length
  return (modes[nextIndex] ?? "") + name
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

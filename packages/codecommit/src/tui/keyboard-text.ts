export interface KeyboardTextKey {
  readonly char?: string
  readonly name: string
}

/** Normalizes printable OpenTUI keys, including pasted spaces without `char`. */
export const textFromKeyboardKey = (key: KeyboardTextKey): string | undefined => {
  if (key.char !== undefined && key.char.length > 0) return key.char
  if (key.name === "space") return " "
  return key.name.length === 1 ? key.name : undefined
}

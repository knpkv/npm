export interface ExitConfirmationRef {
  current: boolean
}

export type ExitConfirmationPress = "armed" | "quit"

/** Owns the double-press transition synchronously so a React render is not part of exit correctness. */
export const pressExitConfirmation = (confirmation: ExitConfirmationRef): ExitConfirmationPress => {
  if (confirmation.current) {
    confirmation.current = false
    return "quit"
  }
  confirmation.current = true
  return "armed"
}

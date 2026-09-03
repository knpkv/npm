export type TerminalOutputBoundary = {
  readonly isActive: () => boolean
  readonly run: (write: () => void) => void
}

/** Mark synchronous Ghostty output so generated protocol replies bypass key modifiers. */
export const makeTerminalOutputBoundary = (): TerminalOutputBoundary => {
  let depth = 0
  return {
    isActive: () => depth > 0,
    run: (write) => {
      depth += 1
      try {
        write()
      } finally {
        depth -= 1
      }
    }
  }
}

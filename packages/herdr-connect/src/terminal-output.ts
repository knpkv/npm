import type { PendingTerminalInput } from "./terminal-input.js"
import type { TerminalInputApplication, TerminalModifier } from "./terminal-keyboard.js"

export type TerminalOutputBoundary = {
  readonly isActive: () => boolean
  readonly run: (write: () => void) => void
}

type TerminalOutputWriter = {
  readonly write: (data: Uint8Array) => void
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

/** Render server output through the production provenance boundary. */
export const writeTerminalOutput = (
  terminal: TerminalOutputWriter,
  data: Uint8Array,
  outputBoundary: TerminalOutputBoundary
): void => outputBoundary.run(() => terminal.write(data))

export type TerminalInputFailure = "connection_unavailable" | "input_queue_overflow"

type SupportedTerminalInput = Extract<TerminalInputApplication, { readonly _tag: "supported" }>

export type TerminalInputHandlerOptions = {
  readonly applyInput: (text: string) => SupportedTerminalInput | null
  readonly isReady: () => boolean
  readonly onFailure: (failure: TerminalInputFailure) => void
  readonly outputBoundary: TerminalOutputBoundary
  readonly pendingInput: PendingTerminalInput
  readonly sendInput: (text: string) => boolean
  readonly setModifier: (modifier: TerminalModifier | null) => void
}

/** Route Ghostty data by provenance so terminal replies bypass user modifiers. */
export const makeTerminalInputHandler = ({
  applyInput,
  isReady,
  onFailure,
  outputBoundary,
  pendingInput,
  sendInput,
  setModifier
}: TerminalInputHandlerOptions): (text: string) => void => {
  const sendOrFail = (text: string): boolean => {
    if (sendInput(text)) return true
    onFailure("connection_unavailable")
    return false
  }
  const queueOrFail = (text: string): boolean => {
    if (pendingInput.push(text) !== "overflow") return true
    onFailure("input_queue_overflow")
    return false
  }
  return (text) => {
    if (outputBoundary.isActive()) {
      if (isReady()) sendOrFail(text)
      else queueOrFail(text)
      return
    }
    const appliedText = applyInput(text)
    if (appliedText === null) return
    if (isReady()) {
      if (!sendOrFail(appliedText.text)) return
      setModifier(appliedText.nextModifier)
      return
    }
    if (queueOrFail(appliedText.text)) setModifier(appliedText.nextModifier)
  }
}

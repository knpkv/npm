export type PendingTerminalInput = {
  readonly clear: () => void
  readonly drain: () => string
  readonly push: (text: string) => "overflow" | "queued"
}

export const makePendingTerminalInput = (
  maximumLength = 65_536
): PendingTerminalInput => {
  let pending = ""
  return {
    clear: () => {
      pending = ""
    },
    drain: () => {
      const value = pending
      pending = ""
      return value
    },
    push: (text) => {
      if (pending.length + text.length > maximumLength) return "overflow"
      pending += text
      return "queued"
    }
  }
}

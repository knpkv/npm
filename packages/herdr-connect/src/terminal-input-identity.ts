export type TerminalInputIdentityTarget = {
  id: string
  name: string
}

export const applyTerminalInputIdentity = (input: TerminalInputIdentityTarget): void => {
  input.id = "connect-terminal-input"
  input.name = "terminal-input"
}

export interface TerminalWorkerGuard {
  readonly accepts: (currentRequestId: number) => boolean
  readonly release: () => void
}

/** Rejects callbacks after an effect cleanup, even when a remount reuses the persisted request id. */
export const makeTerminalWorkerGuard = (ownedRequestId: number): TerminalWorkerGuard => {
  let active = true
  return {
    accepts: (currentRequestId) => active && currentRequestId === ownedRequestId,
    release: () => {
      active = false
    }
  }
}

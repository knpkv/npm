/**
 * Interrupt-signal bracketing for children that own the terminal.
 *
 * `renderer.suspend()` puts the tty back in cooked mode and drops OpenTUI's own
 * exit listeners, so ISIG stays enabled for the whole handover and Ctrl-C at a
 * child's prompt raises SIGINT on the terminal's foreground process group.
 * `runMain` installs a SIGINT listener that interrupts the main fiber and exits,
 * so without this bracket the keystroke that should abandon a stuck child discards
 * the whole review session — findings, dispositions and conversations are
 * component state and cannot be recovered.
 *
 * Only SIGINT is bracketed, and only for the duration of one handover. SIGTERM is
 * deliberately left alone: it does not come from the tty, so it stays a working way
 * to end the session from another shell even while a child holds the terminal.
 *
 * The host signal API is injected rather than imported so this logic is testable
 * without a live process; the concrete binding lives at the executable boundary.
 */

/** The subset of the host signal API this bracket needs, over an opaque listener type. */
export interface InterruptSignals<Listener> {
  /** A listener that accepts the signal and does nothing, keeping Node from terminating. */
  readonly ignore: Listener
  readonly listeners: () => ReadonlyArray<Listener>
  readonly off: (listener: Listener) => void
  readonly on: (listener: Listener) => void
}

/**
 * Detaches the parent's interrupt teardown and returns its restore.
 *
 * The saved listeners are replaced by a no-op rather than merely removed: with no
 * listener at all Node applies its default termination, which would kill the TUI
 * just as surely as `runMain`'s handler. A child spawned into the parent's process
 * group receives the same signal and can act on it.
 *
 * The restore is idempotent, so an explicit resume and a scope finalizer may both
 * call it without installing duplicate teardown listeners.
 */
export const suppressInterruptTeardown = <Listener>(signals: InterruptSignals<Listener>): () => void => {
  const saved = signals.listeners()
  // Suppressing twice would save the already-suppressed list, so the real teardown
  // listeners would be gone for good and the session deaf to Ctrl-C for the rest of
  // its life. Refuse instead: the outstanding bracket already owns the restore.
  if (saved.includes(signals.ignore)) return () => {}
  for (const listener of saved) signals.off(listener)
  signals.on(signals.ignore)
  let restored = false
  return () => {
    if (restored) return
    restored = true
    signals.off(signals.ignore)
    for (const listener of saved) signals.on(listener)
  }
}

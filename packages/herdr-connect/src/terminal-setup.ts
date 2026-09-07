import { Effect, Schema } from "effect"

export class ConnectTerminalSetupError extends Schema.TaggedError<ConnectTerminalSetupError>()(
  "ConnectTerminalSetupError",
  { cause: Schema.Defect(), detail: Schema.String }
) {}

export const acquireTerminalSetup = <Terminal>(
  setup: () => Terminal,
  dispose: (terminal: Terminal) => void
) =>
  Effect.acquireRelease(
    Effect.try({
      try: setup,
      catch: (cause) =>
        new ConnectTerminalSetupError({
          cause,
          detail: "Ghostty Web terminal setup failed"
        })
    }),
    (terminal) => Effect.sync(() => dispose(terminal))
  )

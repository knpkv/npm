import { openOrServe, type OpenOrServeOptions } from "@knpkv/browser-pairing/launch"
import { Effect, Stdio, Stream } from "effect"
import { supportsTerminalLogin } from "./runtime/TerminalLoginControl.js"
import type { BindConfig } from "./security/BindConfig.js"

/** Start/reuse only supported loopback HTTP; other transports print guidance and mint nothing. */
export const openControlCenter = Effect.fn("ControlCenterOpen.run")(function*<LE, LR, SE, SR>(
  options: OpenOrServeOptions<LE, LR, SE, SR> & { readonly bindConfig: BindConfig }
) {
  if (!supportsTerminalLogin(options.bindConfig)) {
    const stdio = yield* Stdio.Stdio
    yield* Stream.make(`sign in through ${options.bindConfig.publicOrigin}\n`).pipe(
      Stream.run(stdio.stdout({ endOnDone: false }))
    )
    return
  }
  return yield* openOrServe(options)
})

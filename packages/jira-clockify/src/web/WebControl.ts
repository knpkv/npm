/** Product path and messages for the shared owner-only control protocol. */
import { type ControlFile, makeWebControl } from "@knpkv/browser-pairing/control"
import { Data, Effect, Path } from "effect"

import { HomeDirectory } from "../services/HomeDirectory.js"

export { ControlFile } from "@knpkv/browser-pairing/control"

/** Retained product error contract; the filesystem implementation lives in browser-pairing. */
export class ControlFileError extends Data.TaggedError("ControlFileError")<{ readonly path: string }> {
  override get message() {
    return `Could not write ${this.path}; jcf web login will not reach this server.`
  }
}

/** No running server can be reached through this product's registration. */
export class WebNotRunning extends Data.TaggedError("WebNotRunning")<{}> {
  override readonly message = "jcf-web is not running. Start it with jcf-web; it prints a link."
}
/** A refusal must fail sign-in instead of starting a second server. */
export class WebLoginRefused extends Data.TaggedError("WebLoginRefused")<{ readonly status: number }> {
  override get message() {
    return `jcf-web refused the sign-in request (HTTP ${this.status}). Restart jcf-web for a new link.`
  }
}

/** A private leaf keeps web credentials separate from the existing configuration directory. */
export const controlFilePath = Effect.gen(function*() {
  const path = yield* Path.Path
  const home = (yield* HomeDirectory).path
  return path.join(home, ".jcf", "web", "control.json")
})
const control = Effect.gen(function*() {
  const path = yield* Path.Path
  const file = yield* controlFilePath
  return makeWebControl({
    directory: path.dirname(file),
    file,
    messages: {
      notRunning: new WebNotRunning().message,
      loginRefused: (status) => new WebLoginRefused({ status }).message,
      controlFile: `Could not write ${file}; jcf web login will not reach this server.`
    }
  })
})
export const writeControlFile = (value: ControlFile) =>
  Effect.flatMap(control, (control) => control.writeControlFile(value)).pipe(
    Effect.catchTag(
      "ControlFileError",
      () => Effect.flatMap(controlFilePath, (path) => Effect.fail(new ControlFileError({ path })))
    )
  )
export const removeControlFile = (token: string) =>
  Effect.flatMap(control, (control) => control.removeControlFile(token))
export const requestLoginUrl = Effect.flatMap(control, (control) => control.requestLoginUrl).pipe(
  Effect.catchTags({
    WebNotRunning: () => Effect.fail(new WebNotRunning()),
    WebLoginRefused: ({ status }) => Effect.fail(new WebLoginRefused({ status }))
  })
)

/** Product path and messages for the shared owner-only control protocol. */
import { type ControlFile, makeWebControl } from "@knpkv/browser-pairing/control"
import { Config, Data, Effect, FileSystem, Option, Path, Schema } from "effect"
import { CodeOwnerUi } from "../../host-contract.js"

export { ControlFile } from "@knpkv/browser-pairing/control"

/** No running server can be reached through this product's registration. */
export class WebNotRunning extends Data.TaggedError("WebNotRunning")<{}> {
  override readonly message = "CodeCommit web is not running. Start it with codecommit web; it prints a link."
}
/** A refusal must fail sign-in instead of starting a second server. */
export class WebLoginRefused extends Data.TaggedError("WebLoginRefused")<{ readonly status: number }> {
  override get message() {
    return `CodeCommit web refused the sign-in request (HTTP ${this.status}). Restart it for a new link.`
  }
}

/** The registration remains optional when publication fails. */
export class ControlFileError extends Data.TaggedError("ControlFileError")<{}> {
  override readonly message = "Could not publish the owner-only CodeCommit web control file."
}
export const controlFilePath = Effect.gen(function*() {
  const path = yield* Path.Path
  const home = yield* Config.String("HOME").pipe(Config.orElse(() => Config.String("USERPROFILE")))
  return path.join(home, ".codecommit", "web.json")
})
/** readLink also detects dangling links, which exists/stat would otherwise follow or miss. */
const refuseLink = Effect.fn("CodeCommitWeb.refuseControlLink")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return yield* new ControlFileError()
})
const requirePrivatePath = Effect.fn("CodeCommitWeb.requirePrivateControlPath")(function*(
  file: string,
  kind: "File" | "Directory",
  mode: number
) {
  yield* refuseLink(file)
  const fs = yield* FileSystem.FileSystem
  const info = yield* fs.stat(file)
  if (info.type !== kind || (info.mode & 0o777) !== mode) return yield* new ControlFileError()
})

/** Read only the public origin projection; ignore credential keys and never mint a login link. */
export const readCodeOwnerUi = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = yield* controlFilePath
  yield* requirePrivatePath(path.dirname(file), "Directory", 0o700)
  yield* requirePrivatePath(file, "File", 0o600)
  const projection = yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ origin: CodeOwnerUi }))))
  )
  return projection.origin
}).pipe(Effect.mapError(() => new WebNotRunning()))

const control = Effect.gen(function*() {
  const path = yield* Path.Path
  const file = yield* controlFilePath
  return makeWebControl({
    directory: path.dirname(file),
    file,
    messages: {
      notRunning: new WebNotRunning().message,
      loginRefused: (status) => new WebLoginRefused({ status }).message,
      controlFile: new ControlFileError().message
    }
  })
})
export const writeControlFile = (value: ControlFile) =>
  Effect.flatMap(control, (control) => control.writeControlFile(value)).pipe(
    Effect.mapError(() => new ControlFileError())
  )
export const registerControlFile = (value: ControlFile) =>
  Effect.flatMap(control, (control) => control.registerControlFile(value)).pipe(
    Effect.mapError(() => new ControlFileError())
  )
export const removeControlFile = (token: string) =>
  Effect.flatMap(control, (control) => control.removeControlFile(token)).pipe(
    Effect.ignore({ log: "Warn", message: "Could not remove the CodeCommit web control file" })
  )
export const requestLoginUrl = Effect.flatMap(control, (control) => control.requestLoginUrl).pipe(
  Effect.catchTags({
    ConfigError: () => Effect.fail(new WebNotRunning()),
    WebNotRunning: () => Effect.fail(new WebNotRunning()),
    WebLoginRefused: ({ status }) => Effect.fail(new WebLoginRefused({ status }))
  })
)

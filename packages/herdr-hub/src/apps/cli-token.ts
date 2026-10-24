/**
 * The credential `herdr-hub apps restart` presents to the hub's loopback listener.
 *
 * Mental model:
 * - **Same user is trusted.** The hub writes a fresh random token at every start to `<hubState>/cli/token`, in a
 *   directory that must be this user's with no group or other bits (`ownPrivateDirectory`). The file is born 0600: a
 *   temp file created with that mode, renamed into place, never chmodded after the token is in it.
 * - **Rotated each start**, so a token in a backup or a copied home is dead. The CLI reads it per command and sends it
 *   as `x-hub-cli-token`; the hub compares it in constant time (`sameSecret`).
 * - Windows ignores the modes (as for app grants): there the directory being the user's own profile is the boundary.
 *
 * @since 0.1.0
 */
import { sameSecret } from "@knpkv/hub-app"
import { Crypto, Effect, FileSystem, Path, Redacted, Schema } from "effect"
import { Base64Url, Hex } from "effect/encoding"
import { ownPrivateDirectory } from "./supervisor.js"

/** The header the CLI sends its token in. */
export const cliTokenHeader = "x-hub-cli-token"

/** No readable token: the hub isn't running, or never started on this account. */
export class CliTokenUnavailable extends Schema.TaggedError<CliTokenUnavailable>()("CliTokenUnavailable", {}) {}

const tokenFile = (path: Path.Path, directory: string) => path.join(directory, "token")

/** Writes a fresh token for this hub start and returns it. */
export const writeCliToken = Effect.fn("CliToken.write")(function*(directory: string, uid: number) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cryptoService = yield* Crypto.Crypto
  yield* ownPrivateDirectory(directory, uid, true)
  const token = Base64Url.encode(yield* cryptoService.randomBytes(32))
  const temp = path.join(directory, `.token-${Hex.encode(yield* cryptoService.randomBytes(8))}`)
  yield* fileSystem.writeFileString(temp, token, { flag: "wx", mode: 0o600 })
  // best-effort: a temp file left behind is a dot file nothing reads, in a directory only this user can enter.
  const dropTemp = Effect.ignore(fileSystem.remove(temp, { force: true }))
  yield* fileSystem.rename(temp, tokenFile(path, directory)).pipe(Effect.tapError(() => dropTemp))
  return Redacted.make(token)
})

/** The current hub start's token, for the CLI. */
export const readCliToken = Effect.fn("CliToken.read")(function*(directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const token = yield* fileSystem.readFileString(tokenFile(path, directory)).pipe(
    Effect.mapError(() => new CliTokenUnavailable())
  )
  return Redacted.make(token.trim())
})

/** Whether a request presented `token`. */
export const presentsCliToken = (presented: string | undefined, token: Redacted.Redacted<string>): boolean =>
  sameSecret(presented, Redacted.value(token))

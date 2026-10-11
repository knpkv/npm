import { ControlFileError, loginControlRouterWithMint, makeWebControl } from "@knpkv/browser-pairing/control"
import { Crypto, Effect, Layer, Path, Redacted, Schema } from "effect"
import { Hex } from "effect/encoding"
import { HttpServerRequest } from "effect/http"
import { AuthRepository } from "../auth/AuthRepository.js"
import { TerminalLogin, type TerminalLoginIdentity } from "../auth/TerminalLogin.js"
import type { ControlCenterDataPaths } from "../cliConfiguration.js"
import { QuarantineRepository } from "../persistence/repositories/quarantineRepository.js"
import type { BindConfig } from "../security/BindConfig.js"
import { ServerLifecycle } from "./ServerLifecycle.js"

/** Server-private bearer authority. Neither the token nor its pathname may enter projections or logs. */
export interface TerminalLoginControlOptions extends TerminalLoginIdentity {
  readonly token: Redacted.Redacted<string>
}

class TerminalLoginAuthorityRejected extends Schema.TaggedError<TerminalLoginAuthorityRejected>()(
  "TerminalLoginAuthorityRejected",
  {}
) {}

/** Non-loopback, TLS, proxy and insecure LAN modes retain their existing sign-in policy. */
export const supportsTerminalLogin = (bind: BindConfig): boolean =>
  bind.transportPolicy === "loopback-http" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(bind.publicOrigin).hostname)

/** Resolve a private leaf beneath already verified canonical operational paths, not the configured symlink claim. */
export const terminalWebControl = Effect.fn("TerminalLoginControl.paths")(function*(paths: ControlCenterDataPaths) {
  const path = yield* Path.Path
  const directory = path.join(paths.dataRoot, "web")
  return makeWebControl({
    directory,
    file: path.join(directory, "control.json"),
    messages: {
      notRunning: "Control Center is not running.",
      loginRefused: () => "Control Center refused terminal sign-in. Use an existing paired browser or recover-owner.",
      controlFile: "Could not publish the owner-only Control Center control file."
    }
  })
})

/** Generate a redacted control bearer once per listener; it is distinct from all browser credentials. */
export const makeTerminalControlToken = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const bytes = yield* cryptoService.randomBytes(32).pipe(Effect.mapError(() => new ControlFileError({})))
  return Redacted.make(Hex.encode(bytes))
})

/** Bind the durable issuer to the same database as Auth and expose no additional service publicly. */
export const terminalLoginControlLayer = (bind: BindConfig, options: TerminalLoginControlOptions) => {
  const issuer = TerminalLogin.layer(options).pipe(
    Layer.provide(AuthRepository.layer.pipe(Layer.provide(QuarantineRepository.layer)))
  )
  return Layer.unwrap(Effect.gen(function*() {
    const terminal = yield* TerminalLogin
    const lifecycle = yield* ServerLifecycle
    const mint = Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!supportsTerminalLogin(bind) || request.headers.host !== new URL(bind.publicOrigin).host) {
        return yield* new TerminalLoginAuthorityRejected({})
      }
      const issued = yield* lifecycle.runMutation(terminal.mint).pipe(Effect.timeout("5 seconds"))
      return issued.pairingCode
    })
    return loginControlRouterWithMint(options.token, bind.publicOrigin, mint)
  })).pipe(Layer.provide(issuer))
}

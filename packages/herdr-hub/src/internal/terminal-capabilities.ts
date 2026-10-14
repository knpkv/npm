/** A takeover needs fresh proof from the owning host; it never retries as an ordinary attach. */
import { TerminalCapabilities } from "@knpkv/herdr-connect"
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet"
import { Duration, Effect, Schema } from "effect"
import { HttpClient } from "effect/http"

export class PeerTerminalCapabilityError extends Schema.TaggedError<PeerTerminalCapabilityError>()(
  "PeerTerminalCapabilityError",
  { reason: Schema.Literals(["unsupported", "transport"]) }
) {}

const terminalCapabilityTimeout = Duration.seconds(5)

/** The Node HTTP client does not follow redirects; only this endpoint's own 200 response is proof. */
export const requireRemoteTerminalTakeover = Effect.fn("HostHttp.requireRemoteTerminalTakeover")(
  function*(terminalUrl: string) {
    const url = new URL(terminalUrl)
    url.protocol = url.protocol === "wss:" ? "https:" : "http:"
    url.pathname = "/v1/connect/terminal/capabilities"
    url.search = ""
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(url).pipe(
      Effect.mapError(() => new PeerTerminalCapabilityError({ reason: "transport" }))
    )
    if (response.status !== 200) {
      return yield* new PeerTerminalCapabilityError({ reason: response.status >= 500 ? "transport" : "unsupported" })
    }
    yield* decodeBoundedResponseJson(response, TerminalCapabilities, 1_024).pipe(
      Effect.mapError((cause) =>
        new PeerTerminalCapabilityError({
          reason: cause.reason === "transport" ? "transport" : "unsupported"
        })
      )
    )
  },
  Effect.timeoutOrElse({
    duration: terminalCapabilityTimeout,
    orElse: () => Effect.fail(new PeerTerminalCapabilityError({ reason: "transport" }))
  })
)

/**
 * Reading the server's replies, apart from the page globals `api.ts` needs, so it can be tested
 * outside a browser.
 *
 * @module
 */
import { Data, Effect, Option, Schema } from "effect"
import type { HttpClientResponse } from "effect/http"

export class RequestFailure extends Data.TaggedError("RequestFailure")<{
  readonly message: string
  readonly status: number
}> {}

const ErrorBody = Schema.Struct({ message: Schema.String })
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody)

/**
 * What a response means to this client: its JSON body on success, else a {@link RequestFailure}
 * carrying the server's message when it sent one, or the status when it did not.
 */
export const readReply = Effect.fn("AgentUsageApi.readReply")(
  function*(response: HttpClientResponse.HttpClientResponse) {
    if (response.status >= 400) {
      // An error body need not be JSON (the bootstrap route answers in plain text, a proxy in HTML);
      // the status still names the failure, so an unreadable body only loses the server's wording.
      const message = yield* response.json.pipe(
        Effect.map((body) => Option.map(decodeErrorBody(body), ({ message }) => message)),
        Effect.catchTag("HttpClientError", () => Effect.succeed(Option.none<string>()))
      )
      return yield* new RequestFailure({
        message: Option.getOrElse(message, () => `Request failed (${response.status})`),
        status: response.status
      })
    }
    // Every success this client asks for is JSON; anything else is a failure, not an empty result.
    return yield* response.json.pipe(
      Effect.mapError(() =>
        new RequestFailure({ message: "The server sent a reply this page cannot read", status: response.status })
      )
    )
  }
)

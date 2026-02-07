import { HttpApiBuilder, HttpServerResponse } from "@effect/platform"
import { PRService } from "@knpkv/codecommit-core"
import { AppStatus, PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Duration, Effect, Schedule, Schema, Stream } from "effect"
import { CodeCommitApi } from "../Api.js"

const AccountState = Schema.Struct({
  profile: Schema.String,
  region: Schema.String,
  enabled: Schema.Boolean
})

const SsePayload = Schema.Struct({
  pullRequests: Schema.Array(PullRequest),
  accounts: Schema.Array(AccountState),
  status: AppStatus,
  statusDetail: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  lastUpdated: Schema.optional(Schema.DateFromSelf),
  currentUser: Schema.optional(Schema.String)
})

const encode = Schema.encode(SsePayload)

const encoder = new TextEncoder()

// SSE keepalive — prevents browser timeout
const keepalive = Stream.schedule(
  Stream.succeed(encoder.encode(":\n\n")),
  Schedule.spaced(Duration.seconds(30))
)

export const EventsLive = HttpApiBuilder.group(CodeCommitApi, "events", (handlers) =>
  Effect.gen(function*() {
    const prService = yield* PRService.PRService

    const stateStream = prService.state.changes.pipe(
      Stream.mapEffect((state) =>
        encode(state).pipe(
          Effect.map((payload) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)),
          Effect.catchAll((e) =>
            Effect.logWarning("SSE encode failed", e).pipe(
              Effect.map(() => encoder.encode(":\n\n"))
            )
          )
        )
      )
    )

    return handlers.handleRaw("stream", () =>
      Effect.succeed(
        HttpServerResponse.stream(
          Stream.merge(stateStream, keepalive),
          {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "connection": "keep-alive"
            }
          }
        )
      ))
  }))

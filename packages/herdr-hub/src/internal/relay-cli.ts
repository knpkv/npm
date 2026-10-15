import type { ConnectPostBody } from "@knpkv/herdr-connect"
import {
  Conflict,
  ConnectPost,
  connectReportResponseTimeoutMillis,
  ConnectStoreBusyError,
  Denied,
  InvalidReport,
  Unavailable,
  UnboundAgent
} from "@knpkv/herdr-connect"
import { type ConnectSelfBody } from "@knpkv/herdr-connect/model"
import { decodeBoundedResponseJson, loadConfiguration } from "@knpkv/herdr-fleet"
import { type HostConfiguration } from "@knpkv/herdr-fleet/model"
import { Config, Console, Crypto, Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { Mutable } from "effect/Types"
import { fleetConfigPath } from "./config-path.js"
import { decodeRelayPostBody } from "./relay-post-validation.js"
import { RelayStoreBusyFailureBody } from "./relay-report-failure.js"
import { resolveReportingAgent } from "./relay-report-identity.js"
import { decodeRelaySelfBody, type RelaySelfOptions } from "./relay-self-validation.js"
import { reportRelaySelf } from "./relay-self.js"

export { resolveReportingAgent } from "./relay-report-identity.js"

const ReportFailure = Schema.Union([
  RelayStoreBusyFailureBody,
  Schema.Struct({ error: Schema.Literal("InvalidReport"), detail: Schema.String }),
  Schema.Struct({ error: Schema.Literal("UnboundAgent"), agentId: Schema.String }),
  Schema.Struct({ error: Schema.Literal("Denied") }),
  Schema.Struct({ error: Schema.Literal("Conflict"), eventId: Schema.String }),
  Schema.Struct({ error: Schema.Literal("Unavailable"), operation: Schema.String })
])

/** Retry transport failures with the same event ID, so an uncertain response cannot duplicate a post. */
export const submitRelayPost = Effect.fn("Relay.submitPost")(function*(
  config: HostConfiguration,
  paneId: string,
  body: ConnectPostBody
) {
  const agentId = yield* resolveReportingAgent(config.herdrCommand, paneId)
  const client = yield* HttpClient.HttpClient
  const request = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(new URL("/v1/connect/posts", config.approvalHub.url).href),
    { ...body, agentId }
  ).pipe(
    Effect.mapError(() => new InvalidReport({ detail: "could not encode post" }))
  )
  return yield* Effect.gen(function*() {
    const response = yield* client.execute(request).pipe(
      Effect.mapError(() => new Unavailable({ operation: "post.request" }))
    )
    if (response.status < 200 || response.status >= 300) {
      const failure = yield* decodeBoundedResponseJson(response, ReportFailure).pipe(
        Effect.mapError(() => new Unavailable({ operation: "post.response" }))
      )
      switch (failure.error) {
        case "ConnectStoreBusyError":
          return yield* new ConnectStoreBusyError({
            operation: failure.operation,
            timeoutMillis: failure.timeoutMillis,
            cause: response.status
          })
        case "InvalidReport":
          return yield* new InvalidReport({ detail: failure.detail })
        case "UnboundAgent":
          return yield* new UnboundAgent({ agentId: failure.agentId })
        case "Denied":
          return yield* new Denied()
        case "Conflict":
          return yield* new Conflict({ eventId: failure.eventId })
        case "Unavailable":
          return yield* new Unavailable({ operation: failure.operation })
      }
    }
    const post = yield* decodeBoundedResponseJson(response, ConnectPost).pipe(
      Effect.mapError(() => new Unavailable({ operation: "post.response" }))
    )
    if (
      post.agentId !== agentId || post.host.toLowerCase() !== config.host.toLowerCase() ||
      post.eventId !== body.eventId || post.kind !== body.kind || post.text !== body.text ||
      post.goalStep !== body.goalStep
    ) {
      return yield* new Unavailable({ operation: "post.response.identity" })
    }
    return post
  }).pipe(
    Effect.timeoutOrElse({
      duration: connectReportResponseTimeoutMillis,
      orElse: () => Effect.fail(new Unavailable({ operation: "post.timeout" }))
    }),
    Effect.retry({ times: 2, while: Schema.is(Unavailable) })
  )
})

/** Validate CLI input before resolving the current pane or sending a report. */
export const makeRelayPostCommand = <A, E, R>(report: (body: ConnectPostBody) => Effect.Effect<A, E, R>) => {
  const post = Command.make(
    "post",
    {
      kind: Flag.Literals("kind", ["status", "progress", "skill-feedback", "note", "blocker"]),
      text: Argument.String("text"),
      eventId: Flag.String("event-id").pipe(Flag.optional),
      goalStep: Flag.String("goal-step").pipe(Flag.optional)
    },
    Effect.fn("Relay.post")(function*({ eventId, goalStep, kind, text }) {
      const cryptoService = yield* Crypto.Crypto
      const fields = {
        kind,
        text,
        eventId: Option.isSome(eventId) ? eventId.value : yield* cryptoService.randomUUIDv4.pipe(
          Effect.mapError(() => new Unavailable({ operation: "post.event-id" }))
        )
      }
      const body = yield* decodeRelayPostBody(
        Option.isSome(goalStep) ? { ...fields, goalStep: goalStep.value } : fields
      )
      yield* report(body)
    })
  ).pipe(Command.withDescription("Post a short agent update to the authenticated hub"))
  return post
}

export const relayPostCommand = makeRelayPostCommand(
  Effect.fn("Relay.report")(function*(body: ConnectPostBody) {
    const paneId = yield* Config.String("HERDR_PANE_ID").pipe(
      Effect.mapError(() => new UnboundAgent({ agentId: "current-pane" }))
    )
    const configPath = yield* fleetConfigPath.pipe(
      Effect.mapError(() => new Unavailable({ operation: "post.configuration" }))
    )
    const config = yield* loadConfiguration(configPath).pipe(
      Effect.mapError(() => new Unavailable({ operation: "post.configuration" }))
    )
    const post = yield* submitRelayPost(config, paneId, body)
    yield* Console.log(JSON.stringify(post))
  })
)

/** Parse and normalize self-state before touching configuration, identity or the network. */
export const makeRelaySelfCommand = <A, E, R>(report: (body: ConnectSelfBody) => Effect.Effect<A, E, R>) =>
  Command.make(
    "me",
    {
      mood: Flag.String("mood").pipe(Flag.optional),
      say: Flag.String("say").pipe(Flag.optional),
      accessory: Flag.String("accessory").pipe(Flag.optional)
    },
    Effect.fn("Relay.me")(function*({ accessory, mood, say }) {
      const input: Mutable<RelaySelfOptions> = {}
      if (Option.isSome(mood)) input.mood = mood.value
      if (Option.isSome(say)) input.say = say.value
      if (Option.isSome(accessory)) input.accessory = accessory.value
      const body = yield* decodeRelaySelfBody(input)
      yield* report(body)
    })
  ).pipe(Command.withDescription("Update this agent's creature: mood, words (1-140 characters) and accessory"))

export const relaySelfCommand = makeRelaySelfCommand(
  Effect.fn("Relay.printSelf")(function*(body: ConnectSelfBody) {
    const self = yield* reportRelaySelf(body)
    yield* Console.log(JSON.stringify(self))
  })
)

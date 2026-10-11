import { collectBoundedText } from "@knpkv/bounded-io"
import type { ConnectPostBody } from "@knpkv/herdr-connect"
import { Conflict, ConnectPost, Denied, InvalidReport, Unavailable, UnboundAgent } from "@knpkv/herdr-connect"
import { decodeBoundedResponseJson, loadConfiguration } from "@knpkv/herdr-fleet"
import { AgentStableId, AgentWorkerIdentity, type HostConfiguration } from "@knpkv/herdr-fleet/model"
import { Config, Console, Crypto, Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { fleetConfigPath } from "./config-path.js"
import { decodeRelayPostBody } from "./relay-post-validation.js"

const ReportingPane = Schema.fromJsonString(Schema.Struct({
  result: Schema.Struct({
    agent: Schema.Struct({
      agent: Schema.String,
      pane_id: AgentWorkerIdentity.fields.paneId,
      tokens: Schema.Struct({ agent_id: AgentStableId, lineage_version: Schema.Literal("hostd.agent-lineage.v1") })
    })
  })
}))

/** Resolve only the current pane's stable identity. There is no caller-supplied agent override. */
export const resolveReportingAgent = Effect.fn("Relay.resolveReportingAgent")(
  function*(command: string, paneId: string) {
    yield* Schema.decodeUnknownEffect(AgentWorkerIdentity.fields.paneId)(paneId).pipe(
      Effect.mapError(() => new UnboundAgent({ agentId: "current-pane" }))
    )
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* Effect.scoped(Effect.gen(function*() {
      const handle = yield* spawner.spawn(ChildProcess.make(command, ["agent", "get", paneId])).pipe(
        Effect.mapError(() => new Unavailable({ operation: "post.identity" }))
      )
      const [output, , exitCode] = yield* Effect.all([
        collectBoundedText(handle.stdout, 64 * 1024),
        collectBoundedText(handle.stderr, 64 * 1024),
        handle.exitCode
      ], { concurrency: "unbounded" }).pipe(Effect.mapError(() => new Unavailable({ operation: "post.identity" })))
      if (exitCode !== ChildProcessSpawner.ExitCode(0)) return yield* new UnboundAgent({ agentId: "current-pane" })
      const parsed = yield* Schema.decodeUnknownEffect(ReportingPane)(output).pipe(
        Effect.mapError(() => new UnboundAgent({ agentId: "current-pane" }))
      )
      if (parsed.result.agent.pane_id !== paneId) return yield* new UnboundAgent({ agentId: "current-pane" })
      return parsed.result.agent.tokens.agent_id
    })).pipe(Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () => Effect.fail(new Unavailable({ operation: "post.identity.timeout" }))
    }))
  }
)

const ReportFailure = Schema.Union([
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
      duration: "10 seconds",
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

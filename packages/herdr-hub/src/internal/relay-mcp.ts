/** Stdio adapter for the same current-pane self-state submission used by relay me. */
import type { ConnectSelfBody, ConnectSelfState } from "@knpkv/herdr-connect"
import { ConnectSelfBody as SelfBody } from "@knpkv/herdr-connect"
import { Context, Effect, Layer, Logger, Result, Schema } from "effect"
import { McpProtocol, McpSchema, McpServer } from "effect/ai"
import { Command } from "effect/cli"
import { decodeRelaySelfBody } from "./relay-self-validation.js"
import type { RelaySelfFailure } from "./relay-self.js"
import { reportRelaySelf } from "./relay-self.js"

type SelfReporter<R> = (body: ConnectSelfBody) => Effect.Effect<ConnectSelfState, typeof RelaySelfFailure.Type, R>

/** Bounds and identity failures become tool error results, while interruption still closes the request. */
export const registerRelaySelfTool = Effect.fn("Relay.registerSelfTool")(function*<R>(report: SelfReporter<R>) {
  const server = yield* McpServer.McpServer
  const inputSchema = yield* Schema.decodeUnknownEffect(McpSchema.ToolJson)({
    ...Schema.toJsonSchemaDocument(Schema.Struct(SelfBody.fields)).schema,
    additionalProperties: false,
    anyOf: [{ required: ["mood"] }, { required: ["say"] }]
  }).pipe(Effect.orDie)
  const services = yield* Effect.context<R>()
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: "relay_me",
      description: "Update your own creature's mood, short words and accessory",
      inputSchema
    }),
    annotations: Context.empty(),
    handle: Effect.fn("Relay.callSelf")(
      decodeRelaySelfBody,
      Effect.flatMap(report),
      Effect.provide(services),
      Effect.result,
      Effect.map((result) =>
        new McpSchema.CallToolResult({
          isError: Result.isFailure(result),
          content: [{
            type: "text",
            text: JSON.stringify(Result.isSuccess(result) ? result.success : result.failure)
          }]
        })
      )
    )
  })
})

export const makeRelayMcpLayer = <R>(report: SelfReporter<R>, version: string) =>
  Layer.effectDiscard(registerRelaySelfTool(report)).pipe(
    Layer.provide(McpServer.layerStdio({ name: "relay", version, protocols: [McpProtocol.v2025_06_18] })),
    Layer.provideMerge(Layer.succeed(Logger.LogToStderr, true))
  )

export const makeRelayMcpCommand = (version: string) =>
  Command.make("mcp", {}, () => Layer.launch(makeRelayMcpLayer(reportRelaySelf, version))).pipe(
    Command.withDescription("Serve the relay_me MCP tool over stdio")
  )

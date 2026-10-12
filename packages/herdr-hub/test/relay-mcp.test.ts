import { expect, it } from "@effect/vitest"
import { type ConnectSelfBody, UnboundAgent } from "@knpkv/herdr-connect"
import { Deferred, Effect, Layer, Queue, Schema, SchemaGetter, Sink, Stdio, Stream } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { makeRelayMcpLayer, registerRelaySelfTool } from "../src/internal/relay-mcp.js"

const initializePayload = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test-client", version: "1.0.0" }
}
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: initializePayload.clientInfo,
  initializePayload,
  getClient: Effect.die("client callbacks unused")
})
type RelayMcpRequest =
  | { readonly method: "initialize"; readonly params: typeof McpSchema.Initialize.payloadSchema.Type }
  | { readonly method: "tools/list"; readonly params: typeof McpSchema.ListTools.payloadSchema.Type }
  | { readonly method: "tools/call"; readonly params: typeof McpSchema.CallTool.payloadSchema.Type }
const StdioText = Schema.Union([
  Schema.String,
  Schema.Uint8Array.pipe(Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((bytes) => new TextDecoder().decode(bytes)),
    encode: SchemaGetter.transform((text) => new TextEncoder().encode(text))
  }))
])
const RelayMcpResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Number,
  result: Schema.Union([McpSchema.InitializeResult, McpSchema.ListToolsResult, McpSchema.CallToolResult])
})
const words = (result: McpSchema.CallToolResult) => {
  const content = result.content[0]
  if (content?.type !== "text") throw new TypeError("Expected text tool result")
  return content.text
}

it.effect("lists only relay_me with bounded mood, text and accessory parameters", () =>
  Effect.gen(function*() {
    const server = yield* McpServer.McpServer.make
    yield* registerRelaySelfTool(() => Effect.die("listing must not submit")).pipe(
      Effect.provideService(McpServer.McpServer, server)
    )
    expect(server.tools.map(({ tool }) => tool.name)).toEqual(["relay_me"])
    expect(server.tools[0]?.tool.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      anyOf: [{ required: ["mood"] }, { required: ["say"] }],
      properties: {
        say: { maxLength: 140 },
        mood: { enum: ["happy", "focused", "worried", "sleepy", "excited", "waiting"] }
      }
    })
  }).pipe(Effect.scoped))

it.effect("normalizes a successful call and returns the shared reporter's self-state", () =>
  Effect.gen(function*() {
    const server = yield* McpServer.McpServer.make
    const received: Array<ConnectSelfBody> = []
    yield* registerRelaySelfTool((body) =>
      Effect.sync(() => {
        received.push(body)
        return { ...body, accessory: body.accessory ?? "none", at: 1, replyTo: null }
      })
    ).pipe(Effect.provideService(McpServer.McpServer, server))
    const result = yield* server.callTool({
      name: "relay_me",
      arguments: { mood: "focused", say: "  Running tests  ", accessory: "glasses" }
    }).pipe(Effect.provideService(McpSchema.McpServerClient, client))
    expect(result.isError).toBe(false)
    expect(received).toEqual([{ mood: "focused", say: "Running tests", accessory: "glasses" }])
    expect(words(result)).toBe(JSON.stringify({ ...received[0], accessory: "glasses", at: 1, replyTo: null }))
  }).pipe(Effect.scoped))

it.effect("returns validation failures as tool errors without invoking the reporter or crashing", () =>
  Effect.gen(function*() {
    const server = yield* McpServer.McpServer.make
    yield* registerRelaySelfTool(() => Effect.die("invalid self reached transport")).pipe(
      Effect.provideService(McpServer.McpServer, server)
    )
    for (
      const input of [
        { say: "x".repeat(141) },
        { mood: "angry" },
        { mood: "happy", accessory: "crown" },
        { accessory: "glasses" },
        { say: "line\nbreak" },
        { say: "\tReady" },
        { say: 42 },
        { say: null },
        { mood: "happy", agentId: "sibling" }
      ]
    ) {
      const result = yield* server.callTool({ name: "relay_me", arguments: input }).pipe(
        Effect.provideService(McpSchema.McpServerClient, client)
      )
      expect(result.isError).toBe(true)
      expect(words(result)).toContain("\"_tag\":\"InvalidReport\"")
    }
  }).pipe(Effect.scoped))

it.effect("returns a missing current-pane identity as a tool error", () =>
  Effect.gen(function*() {
    const server = yield* McpServer.McpServer.make
    yield* registerRelaySelfTool(() => Effect.fail(new UnboundAgent({ agentId: "current-pane" }))).pipe(
      Effect.provideService(McpServer.McpServer, server)
    )
    const result = yield* server.callTool({ name: "relay_me", arguments: { mood: "happy" } }).pipe(
      Effect.provideService(McpSchema.McpServerClient, client)
    )
    expect(result.isError).toBe(true)
    expect(words(result)).toContain("\"_tag\":\"UnboundAgent\"")
  }).pipe(Effect.scoped))

it.effect("serves initialization, listing and calls as newline-delimited MCP on stdio", () =>
  Effect.gen(function*() {
    const stdin = yield* Queue.unbounded<Uint8Array>()
    const stdout = yield* Queue.unbounded<string | Uint8Array>()
    const stdio = Stdio.layerTest({
      stdin: Stream.fromQueue(stdin),
      stdout: () => Sink.forEach((chunk) => Queue.offer(stdout, chunk))
    })
    const ready = yield* Deferred.make<void>()
    yield* Effect.gen(function*() {
      yield* Layer.build(
        makeRelayMcpLayer(
          (body) => Effect.succeed({ ...body, accessory: "none", at: 1, replyTo: null }),
          "test-version"
        ).pipe(
          Layer.provide(stdio)
        )
      )
      yield* Deferred.succeed(ready, undefined)
      return yield* Effect.never
    }).pipe(Effect.scoped, Effect.forkScoped)
    yield* Deferred.await(ready)
    const send = (id: number, request: RelayMcpRequest) =>
      Queue.offer(stdin, new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id, ...request })}\n`))
    const read = Effect.gen(function*() {
      const text = yield* Schema.decodeUnknownEffect(StdioText)(yield* Queue.take(stdout))
      expect(text.endsWith("\n")).toBe(true)
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RelayMcpResponse))(text)
    })
    yield* send(1, { method: "initialize", params: initializePayload })
    expect(yield* read).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "relay", version: "test-version" } }
    })
    yield* Queue.offer(
      stdin,
      new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    )
    yield* send(2, { method: "tools/list", params: {} })
    expect(yield* read).toMatchObject({ id: 2, result: { tools: [{ name: "relay_me" }] } })
    yield* send(3, { method: "tools/call", params: { name: "relay_me", arguments: { say: "Ready" } } })
    expect(yield* read).toMatchObject({
      id: 3,
      result: {
        isError: false,
        content: [{ type: "text", text: JSON.stringify({ say: "Ready", accessory: "none", at: 1, replyTo: null }) }]
      }
    })
    yield* send(4, { method: "tools/call", params: { name: "relay_me", arguments: { say: "x".repeat(141) } } })
    expect(yield* read).toMatchObject({ id: 4, result: { isError: true } })
  }).pipe(Effect.scoped))

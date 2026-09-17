#!/usr/bin/env node
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Clock, Config, Console, Effect, FileSystem, Path, Redacted, Schema } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { MAX_BYTES, Snapshot } from "./model.js"
import { publish, PublishFailed } from "./publisher.js"
import { makeMonitor } from "./server.js"

const origin = Config.string("MONITOR_ORIGIN").pipe(Config.withDefault("http://127.0.0.1:4319"))
const board = Config.string("MONITOR_BOARD").pipe(Config.withDefault("main"))
const serve = Command.make(
  "serve",
  {},
  Effect.fn(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const web = new URL("./web/", import.meta.url)
    const html = yield* fs.readFileString(yield* path.fromFileUrl(new URL("index.html", web)))
    const script = yield* fs.readFileString(yield* path.fromFileUrl(new URL("board.js", web)))
    const css = yield* fs.readFileString(yield* path.fromFileUrl(new URL("board.css", web)))
    const { handler } = yield* makeMonitor({
      boardId: yield* board,
      origin: yield* origin,
      publishToken: Redacted.value(yield* Config.redacted("MONITOR_PUBLISH_TOKEN")),
      viewToken: Redacted.value(yield* Config.redacted("MONITOR_VIEW_TOKEN"))
    }, { html, script, css })
    const hostname = yield* Config.string("MONITOR_BIND").pipe(Config.withDefault("127.0.0.1"))
    const port = yield* Config.port("MONITOR_PORT").pipe(Config.withDefault(4319))
    return yield* HttpServer.serveEffect(handler).pipe(
      Effect.andThen(Console.log("Monitor ready. Waiting for explicit publication.")),
      Effect.andThen(Effect.never),
      // This serve command is the listener composition entry point; its scope includes Effect.never.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeHttpServer.layer(() =>
        createServer({
          requestTimeout: 5000,
          headersTimeout: 5000,
          maxHeaderSize: 8192,
          connectionsCheckingInterval: 1000
        }), { host: hostname, port }))
    )
  })
)
const send = Command.make(
  "publish",
  { file: Argument.string("snapshot-file") },
  Effect.fn(function*({ file }) {
    const fs = yield* FileSystem.FileSystem
    const stat = yield* fs.stat(file)
    if (stat.size > MAX_BYTES) return yield* new PublishFailed()
    const input = yield* fs.readFileString(file)
    const snapshot = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot), { onExcessProperty: "error" })(
      input
    )
    yield* publish(yield* origin, yield* Config.redacted("MONITOR_PUBLISH_TOKEN"), snapshot)
    yield* Console.log("Published")
  })
)
const demo = Command.make(
  "demo",
  {},
  Effect.fn(function*() {
    const now = yield* Clock.currentTimeMillis
    const snapshot: Snapshot = {
      version: 1,
      boardId: yield* board,
      sequence: now,
      sourceAt: now,
      title: "Demo flight board",
      agents: [
        {
          id: "demo-builder",
          name: "Builder",
          task: "Tablet status board",
          state: "working",
          status: "Checking read-only publication",
          blocker: null,
          jiraKey: "DEMO-42",
          branch: "feat/demo-monitor",
          pullRequest: "Example PR #42",
          clockify: { source: "clockify", seconds: 1800, observedAt: now },
          elapsedSeconds: 2400
        },
        {
          id: "demo-reviewer",
          name: "Reviewer",
          task: "Security review",
          state: "blocked",
          status: "Waiting for review slot",
          blocker: "Browser slot in use",
          jiraKey: null,
          branch: null,
          pullRequest: null,
          clockify: null,
          elapsedSeconds: 300
        },
        {
          id: "demo-docs",
          name: "Docs",
          task: "Deployment notes",
          state: "done",
          status: "Isolation assumptions documented",
          blocker: null,
          jiraKey: null,
          branch: "docs/demo",
          pullRequest: null,
          clockify: null,
          elapsedSeconds: 900
        }
      ]
    }
    yield* publish(yield* origin, yield* Config.redacted("MONITOR_PUBLISH_TOKEN"), snapshot)
    yield* Console.log("Published synthetic demo. No live session was read.")
  })
)
Command.make("herdr-monitor").pipe(
  Command.withSubcommands([serve, send, demo]),
  Command.run({ version: "0.0.0" }),
  // Executable entry point owns the platform services.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  Effect.mapError(() => new PublishFailed()),
  Effect.tapError(() => Console.error("Monitor failed. Check configuration, credentials and snapshot.")),
  NodeRuntime.runMain({ disableErrorReporting: true })
)

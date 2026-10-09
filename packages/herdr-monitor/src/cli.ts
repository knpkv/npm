#!/usr/bin/env node
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import type { PlatformError } from "effect"
import { Clock, Config, Console, Crypto, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Base64Url } from "effect/encoding"
import { HttpServer } from "effect/http"
import { createServer } from "node:http"
import {
  AssetsMissing,
  describeFailure,
  InvalidSetting,
  KeysExist,
  KeysNotWritten,
  ListenFailed,
  MissingSetting,
  SnapshotFileInvalid,
  SnapshotFileTooLarge,
  SnapshotFileUnreadable
} from "./failure.js"
import { MAX_BYTES, Snapshot } from "./model.js"
import { publish } from "./publisher.js"
import { makeMonitor } from "./server.js"

/** A required environment variable. Unset or unusable fails naming it, never echoing a value. */
const required = <A>(name: string, config: Config.Config<A>) =>
  Config.option(config).pipe(
    Effect.mapError(() => new InvalidSetting({ name })),
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new MissingSetting({ name })),
      onSome: Effect.succeed
    }))
  )
/**
 * A variable with a default; a value it cannot parse fails naming it and echoing the value. Only for
 * settings that are not secret: keys go through `required`, which never echoes.
 */
const optional = <A>(name: string, config: Config.Config<A>) =>
  config.pipe(
    Effect.catchTag("ConfigError", () =>
      Config.option(Config.String(name)).pipe(
        // The raw value is only echoed in the error; when even it cannot be read, the error names the setting alone.
        Effect.catchTag("ConfigError", () => Effect.succeed(Option.none<string>())),
        Effect.flatMap((value) => Effect.fail(new InvalidSetting({ name, value: Option.getOrUndefined(value) })))
      ))
  )

/** What a file read failure means, in words: the system tag, not the platform's call trace. */
const fileProblem = (error: PlatformError.PlatformError): string => {
  switch (error.reason._tag) {
    case "NotFound":
      return "no such file"
    case "PermissionDenied":
      return "permission denied"
    case "BadResource":
      return "not a readable file"
    case "AlreadyExists":
      return "it already exists"
    default:
      return "it could not be read"
  }
}

const origin = optional(
  "MONITOR_ORIGIN",
  Config.String("MONITOR_ORIGIN").pipe(Config.withDefault("http://127.0.0.1:4319"))
)
const board = optional("MONITOR_BOARD", Config.String("MONITOR_BOARD").pipe(Config.withDefault("main")))
const publishToken = required("MONITOR_PUBLISH_TOKEN", Config.Redacted("MONITOR_PUBLISH_TOKEN"))

const serve = Command.make(
  "serve",
  {},
  Effect.fn(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const web = new URL("./web/", import.meta.url)
    const asset = (name: string) =>
      path.fromFileUrl(new URL(name, web)).pipe(
        Effect.flatMap((file) => fs.readFileString(file)),
        Effect.mapError((error) => new AssetsMissing({ reason: error.message }))
      )
    const { handler } = yield* makeMonitor({
      boardId: yield* board,
      origin: yield* origin,
      publishToken: Redacted.value(yield* publishToken),
      viewToken: Redacted.value(yield* required("MONITOR_VIEW_TOKEN", Config.Redacted("MONITOR_VIEW_TOKEN")))
    }, { html: yield* asset("index.html"), script: yield* asset("board.js"), css: yield* asset("board.css") })
    const hostname = yield* optional(
      "MONITOR_BIND",
      Config.String("MONITOR_BIND").pipe(Config.withDefault("127.0.0.1"))
    )
    const port = yield* optional("MONITOR_PORT", Config.Port("MONITOR_PORT").pipe(Config.withDefault(4319)))
    return yield* HttpServer.serveEffect(handler).pipe(
      Effect.andThen(Console.log(`Monitor ready at http://${hostname}:${port}. Waiting for a publication.`)),
      Effect.andThen(Effect.never),
      // This serve command is the listener composition entry point; its scope includes Effect.never.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeHttpServer.layer(() =>
        createServer({
          requestTimeout: 5000,
          headersTimeout: 5000,
          maxHeaderSize: 8192,
          connectionsCheckingInterval: 1000
        }), { host: hostname, port })),
      // The system's error code only ("EADDRINUSE"); its message repeats the bind address.
      Effect.mapError((error) =>
        new ListenFailed({
          address: `${hostname}:${port}`,
          reason: /\bE[A-Z]{3,}\b/u.exec(error.message)?.[0] ?? "the listener failed"
        })
      )
    )
  })
).pipe(Command.withDescription("Serve the board on MONITOR_BIND:MONITOR_PORT (default 127.0.0.1:4319)"))

const send = Command.make(
  "publish",
  { file: Argument.String("snapshot-file") },
  Effect.fn(function*({ file }) {
    const fs = yield* FileSystem.FileSystem
    const unreadable = (error: PlatformError.PlatformError) =>
      new SnapshotFileUnreadable({ file, reason: fileProblem(error) })
    const stat = yield* fs.stat(file).pipe(Effect.mapError(unreadable))
    const bytes = Number(stat.size)
    if (bytes > MAX_BYTES) return yield* new SnapshotFileTooLarge({ file, bytes })
    const input = yield* fs.readFileString(file).pipe(Effect.mapError(unreadable))
    const snapshot = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot), { onExcessProperty: "error" })(
      input
    ).pipe(Effect.mapError((error) => new SnapshotFileInvalid({ file, reason: error.message })))
    yield* publish(yield* origin, yield* publishToken, snapshot)
    yield* Console.log(`Published ${file} to board ${snapshot.boardId}.`)
  })
).pipe(Command.withDescription("Send one sanitized snapshot file to the monitor at MONITOR_ORIGIN"))

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
    yield* publish(yield* origin, yield* publishToken, snapshot)
    yield* Console.log("Published synthetic demo. No live session was read.")
  })
).pipe(Command.withDescription("Publish a synthetic three-agent board, to try the monitor without live data"))

/** `<prefix>` and 32 random bytes in base64url: the 43-character keys the monitor expects. */
const key = Effect.fn("Monitor.key")(function*(prefix: string) {
  const cryptoService = yield* Crypto.Crypto
  const bytes = yield* cryptoService.randomBytes(32)
  return `${prefix}${Base64Url.encode(bytes)}`
})

const init = Command.make(
  "init",
  {
    envFile: Flag.String("env-file").pipe(
      Flag.withDescription("Where to write the keys (default: $XDG_CONFIG_HOME/herdr-monitor/monitor.env)"),
      Flag.optional
    )
  },
  Effect.fn(function*({ envFile }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const configHome = yield* required(
      "HOME",
      Config.String("XDG_CONFIG_HOME").pipe(
        Config.orElse(() => Config.String("HOME").pipe(Config.map((home) => path.join(home, ".config"))))
      )
    )
    const file = Option.getOrElse(envFile, () => path.join(configHome, "herdr-monitor", "monitor.env"))
    const notWritten = (error: PlatformError.PlatformError) =>
      new KeysNotWritten({ path: file, reason: fileProblem(error) })
    if (yield* fs.exists(file).pipe(Effect.mapError(notWritten))) return yield* new KeysExist({ path: file })
    const keys = {
      publish: yield* key("publish_").pipe(Effect.mapError(notWritten)),
      view: yield* key("view_").pipe(Effect.mapError(notWritten))
    }
    yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 }).pipe(Effect.mapError(notWritten))
    yield* fs.writeFileString(
      file,
      [
        "# herdr-monitor keys, written by `herdr-monitor init`. Keep this file private.",
        `MONITOR_PUBLISH_TOKEN=${keys.publish}`,
        `MONITOR_VIEW_TOKEN=${keys.view}`,
        ""
      ].join("\n"),
      // `wx`: never replace keys a board already uses, even if one appeared since the check above.
      { flag: "wx", mode: 0o600 }
    ).pipe(Effect.mapError(notWritten))
    yield* Console.log(
      [
        `Wrote a publish key and a view key to ${file} (readable by you only).`,
        `Load them before serve or publish:  set -a; . ${file}; set +a`,
        "Viewers open the board with the view key, MONITOR_VIEW_TOKEN in that file."
      ].join("\n")
    )
  })
).pipe(Command.withDescription("Generate the publish and view keys into a private env file"))

Command.make("herdr-monitor").pipe(
  Command.withDescription("A read-only status board for herdr agents, fed by explicit publication"),
  Command.withSubcommands([init, serve, send, demo]),
  Command.run({ version: "0.0.0" }),
  // Executable entry point owns the platform services.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  Effect.tapError((error) => {
    const line = describeFailure(error)
    return line === undefined ? Effect.void : Console.error(line)
  }),
  NodeRuntime.runMain({ disableErrorReporting: true })
)

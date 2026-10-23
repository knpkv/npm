import { NodeTerminal } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { BrowserOpener } from "@knpkv/browser-pairing/launch"
import type { HostConfiguration } from "@knpkv/herdr-fleet"
import type { TailStatus } from "@knpkv/herdr-tailscale"
import {
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Predicate,
  Ref,
  Sink,
  Stream
} from "effect"
import { Command } from "effect/cli"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Path from "effect/Path"
import type { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process"
import * as Stdio from "effect/Stdio"
import * as TestClock from "effect/testing/TestClock"
import { RelayProbe, relayRootCommand } from "../src/internal/relay-open.js"
import { ownerPaths } from "./fixtures/hub-paths.js"

const hub = "https://hub.example.test/"
const local = "http://127.0.0.1:4778/"
const config: HostConfiguration = {
  host: "HOST-A",
  repository: "/fixture/repository",
  stateDirectory: "/fixture/state",
  crossHost: true,
  port: 4777,
  localPort: 4778,
  approvalPort: 443,
  approvalHub: { host: "HOST-B", nodeId: "node-b", url: hub },
  allowedUsers: ["owner@example.test"],
  approvalNodes: [],
  machines: [{ host: "HOST-A", nodeId: "node-a" }, { host: "HOST-B", nodeId: "node-b" }],
  applyMachines: [],
  checkCommand: ["check"],
  applyCommand: null,
  browserMcpRecoverCommand: null,
  coordinatorCommand: ["coordinator"],
  herdrCommand: "herdr",
  tailscaleCommand: "tailscale",
  approvalTls: null,
  pushAllowedOrigins: [],
  pushSubject: "mailto:owner@example.test"
}

/** Exercise the real parser/config/decision with controlled reachability and browser boundaries. */
const makeHarness = Effect.gen(function*() {
  const stdout = yield* Ref.make<ReadonlyArray<string | Uint8Array>>([])
  const stderr = yield* Ref.make<ReadonlyArray<string | Uint8Array>>([])
  const opened = yield* Ref.make<ReadonlyArray<string>>([])
  const probes = yield* Ref.make<ReadonlyArray<string>>([])
  const spawned = yield* Ref.make<ReadonlyArray<ChildProcess.Command>>([])
  return { stdout, stderr, opened, probes, spawned }
})
class Harness extends Context.Service<Harness, Effect.Success<typeof makeHarness>>()("RelayOpen/test/Harness") {}
const testLayer = (
  online: boolean,
  hubAnswers: boolean,
  localAnswers: boolean,
  environment: Readonly<Record<string, string>> = {},
  interactive = true
) =>
  Layer.unwrap(Effect.map(makeHarness, (harness) =>
    Layer.mergeAll(
      Layer.succeed(Harness, harness),
      // The command runner needs Path and Terminal; neither touches the fake filesystem or spawner.
      Path.layer,
      NodeTerminal.layer,
      ownerPaths(),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ FLEET_CONFIG_PATH: "/fixture/fleet.json", ...environment })),
      Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ readFileString: () => Effect.succeed(JSON.stringify(config)) })
      ),
      Stdio.layerTest({
        stdoutIsTerminal: Effect.succeed(interactive),
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) => Ref.update(harness.stdout, (chunks) => [...chunks, chunk])),
        stderr: () =>
          Sink.forEach((chunk: string | Uint8Array) => Ref.update(harness.stderr, (chunks) => [...chunks, chunk]))
      }),
      Layer.succeed(
        BrowserOpener,
        BrowserOpener.of({ open: (url) => Ref.update(harness.opened, (urls) => [...urls, url]) })
      ),
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Ref.update(harness.spawned, (commands) => [...commands, command]).pipe(
            Effect.andThen(Effect.die("Root launch must not start hostd"))
          )
        )
      ),
      Layer.succeed(
        RelayProbe,
        RelayProbe.of({
          tailnetOnline: () => Effect.succeed(online),
          answers: (url) =>
            Ref.update(harness.probes, (urls) => [...urls, url]).pipe(
              Effect.as(url === hub ? hubAnswers : localAnswers)
            )
        })
      )
    )))
const output = (chunks: ReadonlyArray<string | Uint8Array>) =>
  chunks.map((chunk) => Predicate.isString(chunk) ? chunk : new TextDecoder().decode(chunk)).join("")
const run = (args: ReadonlyArray<string> = []) => Command.runWith(relayRootCommand, { version: "test" })(args)

it.layer(testLayer(true, true, true))("Relay launch", (it) => {
  it.effect("prints and opens the configured HTTPS hub without probing the local dashboard", () =>
    Effect.gen(function*() {
      const harness = yield* Harness
      yield* run()
      expect(output(yield* Ref.get(harness.stdout))).toBe(`${hub}\n`)
      expect(output(yield* Ref.get(harness.stderr))).toBe("")
      expect(yield* Ref.get(harness.opened)).toEqual([hub])
      expect(yield* Ref.get(harness.probes)).toEqual([hub])
      expect(yield* Ref.get(harness.spawned)).toEqual([])
    }))
})

const failures: ReadonlyArray<readonly [string, boolean, boolean, boolean, string, ReadonlyArray<string>]> = [
  [
    "offline tailnet",
    false,
    true,
    true,
    "Relay is only served over the tailnet (hub not reachable); this machine's dashboard is at http://127.0.0.1:4778/",
    [local]
  ],
  [
    "unreachable hub",
    true,
    false,
    true,
    "Relay is only served over the tailnet (hub not reachable); this machine's dashboard is at http://127.0.0.1:4778/",
    [hub, local]
  ],
  [
    "offline tailnet and stopped hostd",
    false,
    false,
    false,
    "hostd is not running. Start it with: systemctl --user start hostd",
    [local]
  ],
  [
    "unreachable hub and stopped hostd",
    true,
    false,
    false,
    "hostd is not running. Start it with: systemctl --user start hostd",
    [hub, local]
  ]
]
for (const [name, online, hubAnswers, localAnswers, message, probes] of failures) {
  it.layer(testLayer(online, hubAnswers, localAnswers))(name, (it) => {
    it.effect("reports one exact stderr line, fails and neither opens nor starts anything", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        const failure = yield* Effect.flip(run(["--no-open"]))
        expect(failure._tag).toBe("RelayOpenFailed")
        expect(output(yield* Ref.get(harness.stderr))).toBe(`${message}\n`)
        expect(output(yield* Ref.get(harness.stdout))).toBe("")
        expect(yield* Ref.get(harness.opened)).toEqual([])
        expect(yield* Ref.get(harness.probes)).toEqual(probes)
        expect(yield* Ref.get(harness.spawned)).toEqual([])
      }))
  })
}

const skips: ReadonlyArray<readonly [Readonly<Record<string, string>>, boolean, ReadonlyArray<string>, string]> = [
  [{}, true, ["--no-open"], "--no-open"],
  [{ BROWSER: "none" }, true, [], "BROWSER=none"],
  [{ CI: "true" }, true, [], "CI is set"],
  [{}, false, [], "not an interactive terminal"]
]
for (const [environment, interactive, args, reason] of skips) {
  it.layer(testLayer(true, true, true, environment, interactive))(`skip ${reason}`, (it) => {
    it.effect("still prints the configured URL and policy reason without opening", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        yield* run(args)
        expect(output(yield* Ref.get(harness.stdout))).toBe(
          `${hub}\nNot opening a browser (${reason}); open the link above.\n`
        )
        expect(output(yield* Ref.get(harness.stderr))).toBe("")
        expect(yield* Ref.get(harness.opened)).toEqual([])
        expect(yield* Ref.get(harness.spawned)).toEqual([])
      }))
  })
}

const onlineStatus: TailStatus = {
  Self: { ID: "node-a", HostName: "HOST-A", Online: true, TailscaleIPs: ["100.64.0.1"] },
  Peer: { hub: { ID: "node-b", HostName: "HOST-B", Online: true, TailscaleIPs: ["100.64.0.2"] } }
}
type Reply = "valid" | "redirect" | "wrong-product" | "malformed" | "oversized" | "unavailable" | "slow"

/** Use the live probe service with fake HTTP/process transports, without spawning any host process. */
const makeProbeHarness = Effect.gen(function*() {
  const status = yield* Ref.make(onlineStatus)
  const reply = yield* Ref.make<Reply>("valid")
  const requests = yield* Ref.make<ReadonlyArray<string>>([])
  const commands = yield* Ref.make<ReadonlyArray<ChildProcess.Command>>([])
  const started = yield* Deferred.make<void>()
  const client = HttpClient.make((request) =>
    Effect.gen(function*() {
      yield* Ref.update(requests, (urls) => [...urls, request.url])
      const mode = yield* Ref.get(reply)
      if (mode === "slow") {
        yield* Deferred.succeed(started, undefined)
        return yield* Effect.never
      }
      return HttpClientResponse.fromWeb(
        request,
        mode === "redirect" ?
          new Response(null, { status: 302, headers: { location: "https://other.example.test/" } })
          : mode === "unavailable" ?
          new Response(null, { status: 503 })
          : mode === "malformed" ?
          new Response("not json")
          : mode === "oversized" ?
          Response.json({ name: "Relay", id: "/", start_url: "/", padding: "x".repeat(4096) })
          : Response.json({ name: mode === "wrong-product" ? "Another product" : "Relay", id: "/", start_url: "/" })
      )
    })
  )
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function*() {
      yield* Ref.update(commands, (values) => [...values, command])
      if (
        command._tag !== "StandardCommand" || command.command !== "tailscale" ||
        command.args.join(" ") !== "status --json"
      ) {
        return yield* Effect.die("Only the read-only configured Tailscale status command is allowed")
      }
      return ChildProcessSpawner.makeHandle({
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(7),
        stderr: Stream.empty,
        stdin: Sink.drain,
        stdout: Stream.fromEffect(
          Ref.get(status).pipe(Effect.map((value) => new TextEncoder().encode(JSON.stringify(value))))
        ),
        unref: Effect.succeed(Effect.void)
      })
    })
  )
  return {
    status,
    reply,
    requests,
    commands,
    started,
    layer: RelayProbe.layer.pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
    )))
  }
})
class ProbeHarness
  extends Context.Service<ProbeHarness, Effect.Success<typeof makeProbeHarness>>()("RelayOpen/test/ProbeHarness")
{}
const probeLayer = Layer.unwrap(
  Effect.map(makeProbeHarness, (harness) => Layer.merge(Layer.succeed(ProbeHarness, harness), harness.layer))
)

it.layer(Layer.fresh(probeLayer))("manifest probe", (it) => {
  it.effect("requires the public Relay manifest, caps its body and rejects redirects without following them", () =>
    Effect.gen(function*() {
      const harness = yield* ProbeHarness
      const probe = yield* RelayProbe
      for (
        const reply of [
          "valid",
          "redirect",
          "wrong-product",
          "malformed",
          "oversized",
          "unavailable"
        ] satisfies ReadonlyArray<Reply>
      ) {
        yield* Ref.set(harness.reply, reply)
        yield* Ref.set(harness.requests, [])
        expect(yield* probe.answers(hub), reply).toBe(reply === "valid")
        expect(yield* Ref.get(harness.requests)).toEqual(["https://hub.example.test/manifest.webmanifest"])
        expect(yield* Ref.get(harness.commands)).toEqual([])
      }
    }))
})
it.layer(Layer.fresh(probeLayer))("probe timeout", (it) => {
  it.effect("marks a hanging manifest unreachable at one second", () =>
    Effect.gen(function*() {
      const harness = yield* ProbeHarness
      const probe = yield* RelayProbe
      yield* Ref.set(harness.reply, "slow")
      const fiber = yield* probe.answers(hub).pipe(Effect.forkScoped)
      yield* Deferred.await(harness.started)
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(fiber)).toBe(false)
    }))
})
it.layer(Layer.fresh(probeLayer))("tailnet discovery", (it) => {
  it.effect("requires online addressed nodes and the configured hub identity; runs only read-only status", () =>
    Effect.gen(function*() {
      const harness = yield* ProbeHarness
      const probe = yield* RelayProbe
      const peer = onlineStatus.Peer.hub
      if (peer === undefined) return yield* Effect.die("Missing fixture hub")
      const cases: ReadonlyArray<readonly [TailStatus, boolean]> = [
        [onlineStatus, true],
        [{ ...onlineStatus, Self: { ...onlineStatus.Self, Online: false } }, false],
        [{ ...onlineStatus, Self: { ...onlineStatus.Self, TailscaleIPs: [] } }, false],
        [{ ...onlineStatus, Peer: { hub: { ...peer, ID: "foreign-node" } } }, false],
        [{ ...onlineStatus, Peer: { hub: { ...peer, HostName: "FOREIGN" } } }, false],
        [{ ...onlineStatus, Peer: { hub: { ...peer, Online: false } } }, false]
      ]
      for (const [status, online] of cases) {
        yield* Ref.set(harness.status, status)
        expect(yield* probe.tailnetOnline(config)).toBe(online)
      }
      expect((yield* Ref.get(harness.commands)).length).toBe(cases.length)
      expect(yield* Ref.get(harness.requests)).toEqual([])
    }))
})

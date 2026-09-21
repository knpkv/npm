/** Isolated application over real engine logic and fake providers. Controls never encode API replies. */
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { ReconcileService } from "@knpkv/jira-clockify"
import { FAKE_HOME, makeFakeHeadless } from "@knpkv/jira-clockify/testing.js"
import { Effect, Layer, Queue, Ref, Schema } from "effect"
import { Etag, HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"
import { application } from "../../src/server/HttpApplication.js"
import {
  activateOwnerSessionBootstrap,
  makeOwnerSessionSecrets,
  ownerSessionCookie,
  OwnerSessionSecrets,
  ownerSessionUrl
} from "../../src/server/OwnerSession.js"

// This executable composes isolated engine services and a real loopback HTTP listener.
// @effect-diagnostics strictEffectProvide:off
const origin = "http://127.0.0.1:4179"
const mondays = ["2026-09-07", "2026-09-14"]
type Hold = "hold" | "hold-start" | null
type Command = "activity" | "finish"

const Scenario = Schema.NullOr(Schema.Literals(["seconds", "whole-minutes", "sub-hour-seconds", "overlap"]))
type Scenario = typeof Scenario.Type

/** Two evidence blocks per week, including their five-minute trailing presence. */
const transcriptsFor = (hours: ReadonlyArray<number>, firstBlockSeconds = 3600) =>
  Object.fromEntries(mondays.flatMap((day) =>
    hours.map((hour) => {
      const id = `${day}-${hour}`
      const start = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00`).getTime()
      const activeSeconds = hour === 11 ? firstBlockSeconds - 300 : 3300
      const eventCount = Math.ceil(activeSeconds / 60) + 1
      return [
        `repo/${id}.jsonl`,
        Array.from({ length: eventCount }, (_, minute) =>
          JSON.stringify({
            cwd: `${FAKE_HOME}/dev/work/repo`,
            gitBranch: "feature/PROJ-123",
            isSidechain: false,
            message: { content: "Implement PROJ-123", role: "user" },
            sessionId: id,
            timestamp: new Date(start + Math.min(minute * 60, activeSeconds) * 1000).toISOString(),
            type: "user",
            uuid: `${id}-${minute}`,
            version: "9.9.9"
          })).join("\n")
      ]
    })
  ))

/** Every reset owns fresh providers, retained plans and one-time credentials. */
const makeFixture = Effect.fn("BrowserFixture.make")(function*(
  seed: boolean = true,
  savedEditing: boolean = false,
  scenario: Scenario = null
) {
  const next = yield* Ref.make<Hold>(null)
  const pending = yield* Ref.make<Queue.Queue<Command> | null>(null)
  const security = yield* makeOwnerSessionSecrets(origin)
  const fake = makeFakeHeadless({
    config: { sessionRoots: [`${FAKE_HOME}/dev/work`], sessionOwnership: "any" },
    describer: () => "Improved weekly time review and tested approval behavior",
    transcripts: transcriptsFor(
      savedEditing ? [9, 11, 14] : [11, 14],
      scenario === "seconds"
        ? 5027
        : scenario === "whole-minutes"
        ? 4980
        : scenario === "sub-hour-seconds"
        ? 3027
        : 3600
    ),
    clockifyEntries: [
      ...(scenario === "overlap" ? [] : mondays.map((day) => ({
        description: "[PROJ-123] Review weekly time",
        start: new Date(`${day}T09:00:00`).toISOString(),
        end: new Date(`${day}T10:00:00`).toISOString()
      }))),
      ...(scenario === "overlap" ?
        mondays.map((day) => ({
          description: "[PROJ-123] Review weekly time",
          start: new Date(`${day}T11:00:00`).toISOString(),
          end: new Date(`${day}T11:30:00`).toISOString()
        })) :
        []),
      ...(savedEditing ?
        [{
          id: "unkeyed",
          description: "Planning without a ticket",
          start: new Date("2026-09-07T11:00:00").toISOString(),
          end: new Date("2026-09-07T12:00:00").toISOString()
        }, {
          id: "overnight",
          description: "Overnight operation",
          start: new Date("2026-09-07T23:30:00").toISOString(),
          end: new Date("2026-09-08T00:30:00").toISOString()
        }] :
        [])
    ],
    jiraWorklogs: {
      "PROJ-123": mondays.flatMap((day) => [
        ...(scenario === "overlap"
          ? []
          : [{ started: new Date(`${day}T09:00:00`).toISOString(), timeSpentSeconds: 3600 }]),
        ...(scenario === "overlap"
          ? [{ started: new Date(`${day}T11:00:00`).toISOString(), timeSpentSeconds: 1800 }]
          : [])
      ])
    }
  })
  // Keep fixture filesystem and credentials inside the engine. Static assets use the host platform.
  const engine = Layer.effect(
    ReconcileService.ReconcileService,
    Effect.gen(function*() {
      const reconcile = yield* ReconcileService.ReconcileService
      const controlled = ReconcileService.ReconcileService.of({
        ...reconcile,
        proposeFromSessions: (period, options) =>
          Effect.gen(function*() {
            const hold = yield* Ref.getAndSet(next, null)
            if (hold !== null) {
              const commands = yield* Queue.unbounded<Command>()
              yield* Ref.set(pending, commands)
              const report = (event: ReconcileService.SessionProposalProgress) =>
                options?.onProgress?.(event) ?? Effect.void
              const activity = (kind: "status" | "text" | "request" | "response", text: string) =>
                report({ _tag: "AgentActivity", batch: 1, batches: 2, kind, text })
              const output = Effect.forEach(
                ["Checking session context. ", "Matched PROJ-5662."],
                (text) => activity("text", text)
              )
              yield* report({
                _tag: "SessionAttributed",
                done: 2,
                total: 8,
                gitBranch: "main",
                cwd: `${FAKE_HOME}/dev/work/repo`,
                outcome: { _tag: "Placed", ticketKey: "PROJ-5662", confidence: 1 }
              })
              if (hold === "hold-start") {
                yield* activity("request", "Match the session about PROJ-5662 using its supplied evidence.")
                yield* activity("status", "Agent started")
              } else yield* output
              let outputs = 0
              while (true) {
                const command = yield* Queue.take(commands)
                if (command === "finish") break
                if (outputs === 0) yield* output
                else {
                  yield* activity("response", "{\"answers\":[{\"ticketKey\":\"PROJ-5662\"}]}")
                  yield* activity("status", "Answer received")
                }
                outputs += 1
              }
              yield* Ref.set(pending, null)
            }
            return yield* reconcile.proposeFromSessions(period, options)
          })
      })
      return controlled
    })
  ).pipe(Layer.provideMerge(fake.layer))
  const app = application.pipe(
    Layer.provide(engine),
    Layer.provideMerge(Layer.succeed(OwnerSessionSecrets, security)),
    Layer.provide(Etag.layer),
    Layer.provide(HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provideMerge(NodeServices.layer)
  )
  const web = HttpRouter.toWebHandler(app, { disableLogger: true })
  // Seed by reading through the real routes. Saved plans, IDs and JSON codecs remain application-owned.
  yield* Effect.forEach(
    seed ? mondays : [],
    (monday) =>
      Effect.forEach(["both", "jira", "clockify"], (scope) =>
        Effect.promise(async () => {
          const response = await web.handler(
            new Request(`${origin}/api/week/?monday=${monday}&only=${scope}`, {
              headers: { cookie: ownerSessionCookie(security) }
            })
          )
          const body = await response.text()
          if (response.status !== 200) return { status: response.status, body }
          return null
        }).pipe(Effect.flatMap((failure) => failure === null ? Effect.void : Effect.die(failure))))
  ).pipe(Effect.onError(() => Effect.promise(() => web.dispose())))
  yield* activateOwnerSessionBootstrap(security)
  return {
    web,
    url: ownerSessionUrl(origin, security),
    observations: Effect.sync(() => ({
      clockifyWrites: fake.world.createdClockifyEntries.length,
      jiraWrites: fake.world.jiraWorklogs.length,
      clockifyWriteSeconds: fake.world.createdClockifyEntries.map((entry) =>
        entry.end === undefined ? 0 : (new Date(entry.end).getTime() - new Date(entry.start).getTime()) / 1000
      ),
      jiraWriteSeconds: fake.world.jiraWorklogs.map((entry) => entry.timeSpentSeconds),
      transcriptReads: fake.world.transcriptReads.length,
      describeCalls: fake.world.describeBatches.length,
      clockifyUpdates: fake.world.updatedClockifyEntries,
      jiraUpdates: fake.world.updatedJiraWorklogs
    })),
    hold: (mode: Hold) => Ref.set(next, mode),
    command: (command: Command) =>
      Ref.get(pending).pipe(
        Effect.flatMap((queue) => queue === null ? Effect.void : Queue.offer(queue, command).pipe(Effect.asVoid))
      )
  }
})

const run = Effect.gen(function*() {
  let fixture = yield* makeFixture()
  yield* Effect.addFinalizer(() => Effect.promise(() => fixture.web.dispose()))
  const routes = HttpRouter.use((router) =>
    Effect.gen(function*() {
      yield* router.add(
        "GET",
        "/__test/observations",
        Effect.suspend(() => fixture.observations).pipe(
          Effect.flatMap((observations) => HttpServerResponse.json(observations))
        )
      )
      yield* router.add(
        "POST",
        "/__test/reset",
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          const seed = new URL(request.url, origin).searchParams.get("seed") !== "false"
          yield* Effect.promise(() => fixture.web.dispose())
          const parameters = new URL(request.url, origin).searchParams
          const scenario = Schema.decodeUnknownSync(Scenario)(parameters.get("scenario"))
          fixture = yield* makeFixture(seed, parameters.get("savedEditing") === "true", scenario)
          return yield* HttpServerResponse.json({ url: fixture.url })
        })
      )
      yield* router.add(
        "GET",
        "/__test/hold",
        Effect.suspend(() => fixture.hold("hold")).pipe(Effect.as(HttpServerResponse.text("ok")))
      )
      yield* router.add(
        "GET",
        "/__test/hold-start",
        Effect.suspend(() => fixture.hold("hold-start")).pipe(Effect.as(HttpServerResponse.text("ok")))
      )
      yield* router.add(
        "GET",
        "/__test/activity",
        Effect.suspend(() => fixture.command("activity")).pipe(Effect.as(HttpServerResponse.text("ok")))
      )
      yield* router.add(
        "GET",
        "/__test/finish",
        Effect.suspend(() => fixture.command("finish")).pipe(Effect.as(HttpServerResponse.text("ok")))
      )
      // Adapt requests only. The real application owns bootstrap, cookies, CSRF, codecs and streaming.
      yield* router.add(
        "*",
        "/*",
        Effect.gen(function*() {
          const incoming = yield* HttpServerRequest.HttpServerRequest
          const controller = new AbortController()
          yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
          const request = yield* HttpServerRequest.toWeb(incoming, { signal: controller.signal })
          const response = yield* Effect.promise(() => fixture.web.handler(request))
          return HttpServerResponse.fromWeb(response)
        })
      )
    })
  )
  return yield* Layer.launch(
    HttpRouter.serve(routes).pipe(
      Layer.provide(NodeHttpServer.layerServer(createServer, { host: "127.0.0.1", port: 4179 })),
      Layer.provide(Etag.layer),
      Layer.provide(HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer))),
      Layer.provide(NodeServices.layer)
    )
  )
})

NodeRuntime.runMain(run.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

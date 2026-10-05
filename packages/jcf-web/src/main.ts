#!/usr/bin/env node
/**
 * `jcf-web` — start the week view and print the URL that gets you in.
 *
 * @module
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { loopbackOrigin } from "@knpkv/browser-pairing/owner-session"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { makeOwnerSession } from "./server/OwnerSession.js"
import { makeServer, Port, PublicOrigin } from "./server/Server.js"

const run = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const port = yield* Port.pipe(Effect.orDie)
  const configuredOrigin = yield* PublicOrigin.pipe(Effect.orDie)
  const authorityOrigin = loopbackOrigin("127.0.0.1", port)

  // One origin decision: the URL that gets printed is the same origin every request is checked
  // against, so a dev proxy in front of the server cannot be advertised and then rejected.
  const security = yield* makeOwnerSession(
    authorityOrigin,
    Option.getOrUndefined(configuredOrigin)
  ).pipe(Effect.orDie)

  const ready = yield* Deferred.make<string>()
  const server = yield* Layer.launch(makeServer({ port, ready, security })).pipe(
    Effect.forkChild({ startImmediately: true })
  )
  // The server only ends this race by failing; until it is listening there is no link to print.
  const url = yield* Effect.raceFirst(Deferred.await(ready), Fiber.join(server).pipe(Effect.andThen(Effect.never)))
  // On stdout and nowhere else: this line is the credential. It is not logged, so it cannot end up
  // in a log file that outlives the process that minted it.
  yield* Stream.make(`jcf week view: ${url}\n`).pipe(
    Stream.run(stdio.stdout())
  )
  return yield* Fiber.join(server)
})

// Executable entry point: the host platform is provided once for this process.
// @effect-diagnostics-next-line strictEffectProvide:off
NodeRuntime.runMain(run.pipe(Effect.provide(NodeServices.layer)))

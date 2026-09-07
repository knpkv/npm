/**
 * `jcf-web` — start the week view and print the URL that gets you in.
 *
 * @module
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import {
  makeOwnerSessionSecrets,
  ownerSessionOrigin,
  ownerSessionUrl,
  resolvePublicOrigin
} from "./server/OwnerSession.js"
import { makeServer, Port, PublicOrigin } from "./server/Server.js"

const run = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const port = yield* Port.pipe(Effect.orDie)
  const configuredOrigin = yield* PublicOrigin.pipe(Effect.orDie)
  const authorityOrigin = ownerSessionOrigin("127.0.0.1", port)

  const security = yield* makeOwnerSessionSecrets(authorityOrigin).pipe(Effect.orDie)
  const publicOrigin = yield* resolvePublicOrigin(Option.getOrUndefined(configuredOrigin), authorityOrigin).pipe(
    Effect.orDie
  )

  const ready = yield* Deferred.make<void>()
  const server = yield* Layer.launch(makeServer({ port, ready, security })).pipe(
    Effect.forkChild({ startImmediately: true })
  )
  yield* Effect.raceFirst(Deferred.await(ready), Fiber.join(server))
  // On stdout and nowhere else: this line is the credential. It is not logged, so it cannot end up
  // in a log file that outlives the process that minted it.
  yield* Stream.make(`jcf week view: ${ownerSessionUrl(publicOrigin, security)}\n`).pipe(
    Stream.run(stdio.stdout())
  )
  return yield* Fiber.join(server)
})

NodeRuntime.runMain(run.pipe(Effect.provide(NodeServices.layer)))

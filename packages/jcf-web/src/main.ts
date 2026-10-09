#!/usr/bin/env node
/**
 * `jcf-web` — start the week view and print the URL that gets you in.
 *
 * `jcf-web login` (the same as `jcf web login`) asks the running server for a fresh one-time URL.
 *
 * @module
 */
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { issueCredential } from "@knpkv/browser-pairing"
import { loopbackOrigin, serveWithBootstrapUrl } from "@knpkv/browser-pairing/owner-session"
import { Layers, WebControl } from "@knpkv/jira-clockify"
import { Console, Data, Effect, Layer, Option, Redacted, Runtime } from "effect"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { makeOwnerSession } from "./server/OwnerSession.js"
import { makeServer, Port, PublicOrigin } from "./server/Server.js"

/** A failure already printed as its one line; the process exits 1 without a stack. */
class Reported extends Data.TaggedError("Reported")<{}> {
  override readonly [Runtime.errorReported] = false
}

const serve = Effect.gen(function*() {
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
  // Proves to /control/login that the caller could read the owner-only control file.
  const controlToken = yield* issueCredential().pipe(Effect.orDie)

  return yield* serveWithBootstrapUrl(
    (ready) => makeServer({ port, ready, security, controlToken }),
    (url) =>
      Effect.gen(function*() {
        // On stdout and nowhere else: this line is the credential. It is not logged, so it cannot end
        // up in a log file that outlives the process that minted it.
        yield* Stream.make(`jcf week view: ${url}\n`).pipe(Stream.run(stdio.stdout()))
        yield* WebControl.writeControlFile({ origin: authorityOrigin, token: Redacted.value(controlToken) }).pipe(
          Effect.catch((error) => Console.error(error.message))
        )
        yield* Effect.addFinalizer(() => WebControl.removeControlFile(Redacted.value(controlToken)))
      })
  )
})

const login = WebControl.requestLoginUrl.pipe(
  Effect.flatMap((url) => Console.log(`jcf week view: ${url}`)),
  Effect.catch((error) => Console.error(error.message).pipe(Effect.andThen(Effect.fail(new Reported()))))
)

const main = Effect.gen(function*() {
  const args = yield* Stdio.Stdio.use((stdio) => stdio.args)
  return yield* args[0] === "login" ? login : serve
}).pipe(Effect.scoped)

// Executable entry point: the host platform is provided once for this process.
NodeRuntime.runMain(main.pipe(
  Effect.provide(Layer.mergeAll(Layers.HomeDirectoryLive, NodeServices.layer, NodeHttpClient.layerFetch))
))

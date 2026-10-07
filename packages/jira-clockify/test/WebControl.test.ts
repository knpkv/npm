/**
 * `jcf web login` and the control file the running jcf-web leaves for it.
 *
 * Each case gets a fresh home directory; the "server" is an HttpClient that answers like jcf-web or
 * cannot connect, so the file, its mode and the answer are all observable without a listener.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Path } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { HomeDirectory } from "../src/services/HomeDirectory.js"
import { controlFilePath, removeControlFile, requestLoginUrl, writeControlFile } from "../src/web/WebControl.js"

const control = { origin: "http://127.0.0.1:3111", token: "control-token" }

/** jcf-web as `jcf web login` sees it: a link for the right token, 401 otherwise, or nothing listening. */
const server = (mode: "running" | "stopped") =>
  HttpClient.make((request) =>
    mode === "stopped"
      ? Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection refused" })
        })
      )
      : Effect.succeed(HttpClientResponse.fromWeb(
        request,
        request.headers.authorization === "Bearer control-token" && request.url.endsWith("/control/login")
          ? new Response(JSON.stringify({ url: "http://127.0.0.1:3111/#bootstrap_token=fresh" }), {
            headers: { "content-type": "application/json" }
          })
          : new Response(null, { status: 401 })
      ))
  )

/** Runs `body` in a fresh home directory, against jcf-web in `mode`. */
const inHome = <A, E>(
  mode: "running" | "stopped",
  body: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | HomeDirectory | HttpClient.HttpClient>
) =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "jcf-web-control-" })
    return yield* body.pipe(
      Effect.provideService(HomeDirectory, HomeDirectory.of({ path: home })),
      Effect.provideService(HttpClient.HttpClient, server(mode))
    )
  }))

describe("WebControl", () =>
  it.layer(NodeServices.layer)((it) => {
    // QA-J17: the only way in was the link printed once at start.
    it.effect("gets a fresh link from the running server through an owner-only file", () =>
      inHome(
        "running",
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* writeControlFile(control)
          const file = yield* controlFilePath
          expect(((yield* fs.stat(file)).mode & 0o777).toString(8)).toBe("600")
          expect(yield* requestLoginUrl).toBe("http://127.0.0.1:3111/#bootstrap_token=fresh")
        })
      ))

    it.effect("says jcf-web is not running when there is no file, or nothing answers", () =>
      Effect.gen(function*() {
        const noFile = yield* inHome("running", Effect.flip(requestLoginUrl))
        expect(noFile.message).toBe("jcf-web is not running. Start it with jcf-web; it prints a link.")
        const stale = yield* inHome(
          "stopped",
          writeControlFile(control).pipe(Effect.andThen(Effect.flip(requestLoginUrl)))
        )
        expect(stale._tag).toBe("WebNotRunning")
      }))

    it.effect("names a refused request, and a wrong token gets no link", () =>
      inHome(
        "running",
        Effect.gen(function*() {
          yield* writeControlFile({ ...control, token: "someone-else" })
          const refused = yield* Effect.flip(requestLoginUrl)
          expect(refused.message).toBe(
            "jcf-web refused the sign-in request (HTTP 401). Restart jcf-web for a new link."
          )
        })
      ))

    // A server shutting down must not remove the file a newer server wrote.
    it.effect("removes the file only for the server that wrote it", () =>
      inHome(
        "running",
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const file = yield* controlFilePath
          yield* writeControlFile(control)
          yield* removeControlFile("an-older-server")
          expect(yield* fs.exists(file)).toBe(true)
          yield* removeControlFile(control.token)
          expect(yield* fs.exists(file)).toBe(false)
        })
      ))
  }))

// The lock is retried on real time, so these run on the live clock.
describe("WebControl lock", () =>
  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    // Review finding: an exiting server's check and unlink could straddle a newer server's write and
    // delete it. Both now hold web.lock, so whichever order they take, the newer server's file survives.
    it.effect("a newer server's file survives an older server's exit racing its write", () =>
      inHome(
        "running",
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const file = yield* controlFilePath
          const lock = path.join(path.dirname(file), "web.lock")
          yield* writeControlFile(control)
          // Hold the lock, start both, then release: neither may run until the lock is free.
          yield* fs.writeFileString(lock, "")
          const newer = { origin: control.origin, token: "newer-token" }
          const fibers = yield* Effect.all([
            Effect.forkChild(removeControlFile(control.token)),
            Effect.forkChild(writeControlFile(newer))
          ])
          yield* Effect.sleep("100 millis")
          expect(yield* fs.readFileString(file)).toContain(control.token)
          yield* fs.remove(lock)
          yield* Effect.forEach(fibers, Fiber.join)
          expect(yield* fs.readFileString(file)).toContain("newer-token")
        })
      ))

    it.effect("breaks a lock left by a process that died holding it", () =>
      inHome(
        "running",
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const lock = path.join(path.dirname(yield* controlFilePath), "web.lock")
          yield* fs.makeDirectory(path.dirname(lock), { recursive: true })
          yield* fs.writeFileString(lock, "")
          yield* fs.utimes(lock, new Date(0), new Date(0))
          yield* writeControlFile(control)
          expect(yield* requestLoginUrl).toBe("http://127.0.0.1:3111/#bootstrap_token=fresh")
        })
      ))
  }))

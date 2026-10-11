import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { HomeDirectory } from "../src/services/HomeDirectory.js"
import * as WebControl from "../src/web/WebControl.js"

const fixture = (running = false) =>
  Layer.unwrap(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "product-control-" })
    return Layer.mergeAll(
      Layer.succeed(HomeDirectory, HomeDirectory.of({ path: home })),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(
            request,
            running
              ? Response.json({ url: `http://127.0.0.1:3001/#bootstrap_token=${"a".repeat(64)}` })
              : new Response(null, { status: 401 })
          ))
        )
      )
    )
  })).pipe(Layer.provideMerge(NodeServices.layer))
describe("jcf control adapter", () => {
  it.layer(fixture())((it) =>
    it.effect("uses its private control path and retains product-specific failures", () =>
      Effect.gen(function*() {
        const file = yield* WebControl.controlFilePath
        expect(file).toBe(`${(yield* HomeDirectory).path}/.jcf/web/control.json`)
        expect(new WebControl.WebNotRunning().message).toBe(
          "jcf-web is not running. Start it with jcf-web; it prints a link."
        )
        expect(yield* Effect.flip(WebControl.requestLoginUrl)).toBeInstanceOf(WebControl.WebNotRunning)
        yield* WebControl.writeControlFile({ origin: "http://127.0.0.1:3001", token: "a1".repeat(32) })
        const refused = yield* Effect.flip(WebControl.requestLoginUrl)
        expect(refused).toBeInstanceOf(WebControl.WebLoginRefused)
        expect(refused.message).toBe(
          "jcf-web refused the sign-in request (HTTP 401). Restart jcf-web for a new link."
        )
      }))
  )
  it.layer(fixture(true))((it) => {
    it.effect("registers and logs in inside a private leaf without changing an existing 0755 parent", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const home = (yield* HomeDirectory).path
        const parent = `${home}/.jcf`
        yield* fs.makeDirectory(parent, { mode: 0o755 })
        yield* fs.chmod(parent, 0o755)
        const legacy = `${parent}/web.json`
        const previous = JSON.stringify({ origin: "http://127.0.0.1:3002", token: "b2".repeat(32) })
        yield* fs.writeFileString(legacy, previous, { mode: 0o600 })
        const control = { origin: "http://127.0.0.1:3001", token: "a1".repeat(32) }
        yield* WebControl.writeControlFile(control)
        expect(yield* WebControl.requestLoginUrl).toBe(`http://127.0.0.1:3001/#bootstrap_token=${"a".repeat(64)}`)
        const file = yield* WebControl.controlFilePath
        expect(file).toBe(`${parent}/web/control.json`)
        expect((yield* fs.stat(`${parent}/web`)).mode & 0o777).toBe(0o700)
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
        expect((yield* fs.stat(parent)).mode & 0o777).toBe(0o755)
        yield* WebControl.removeControlFile(control.token)
        expect(yield* fs.exists(file)).toBe(false)
        expect(yield* fs.readFileString(legacy)).toBe(previous)
        expect((yield* fs.stat(parent)).mode & 0o777).toBe(0o755)
      }))
  })
})

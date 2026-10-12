import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, test } from "@playwright/test"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

import { browserCall } from "../src/browser.js"
import { LiveProduct } from "../src/live.js"
import { runConformance } from "../src/runner.js"
import { serveFiles } from "../src/server.js"
import { localServer, readyHtml, testLive, testReferences } from "./fixtures.js"

test("redirect hops reject forbidden origins before dispatch and preserve same-origin redirects and assets", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      let forbiddenRequests = 0
      const forbidden = yield* localServer(() => {
        forbiddenRequests += 1
        return HttpServerResponse.html(readyHtml)
      })
      const refs = yield* testReferences(readyHtml)
      const origin = yield* localServer((address) => {
        const url = new URL(address, "http://fixture.test")
        if (url.pathname === "/external") {
          return HttpServerResponse.empty({ status: 302, headers: { location: `${forbidden}/page.html` } })
        }
        if (url.pathname === "/chain") {
          return HttpServerResponse.empty({ status: 302, headers: { location: "/chain2" } })
        }
        if (url.pathname === "/chain2") {
          return HttpServerResponse.empty({ status: 307, headers: { location: "/page.html" } })
        }
        if (url.pathname === "/asset.js") {
          return HttpServerResponse.text("document.documentElement.dataset.designReady='true'", {
            contentType: "text/javascript"
          })
        }
        return HttpServerResponse.html(
          "<html><body><main data-region=content>Fixture workspace</main><script src='/asset.js'></script></body></html>"
        )
      })
      const invalid = yield* runConformance(refs, { output: yield* fs.makeTempDirectoryScoped(), captureOnly: true })
        .pipe(Effect.provideService(LiveProduct, testLive(origin, "/external")), Effect.result)
      expect(invalid).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BrowserFailure", operation: "external capture network" }
      })
      expect(forbiddenRequests).toBe(0)
      const live = testLive(origin, "/chain")
      yield* runConformance(refs, { output: yield* fs.makeTempDirectoryScoped(), captureOnly: true }).pipe(
        Effect.provideService(LiveProduct, {
          ...live,
          ready: (page, identity) =>
            live.ready(page, identity).pipe(Effect.andThen(browserCall("assert final redirect URL", async () => {
              expect(new URL(page.url()).pathname).toBe("/page.html")
            })))
        })
      )
      expect(forbiddenRequests).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

for (const target of ["live", "reference"]) {
  test(`external WebSocket is blocked in the ${target} context`, async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        let requests = 0
        const forbidden = yield* localServer(() => {
          requests += 1
          return HttpServerResponse.empty()
        })
        const clean = yield* testReferences(readyHtml)
        const attack = yield* testReferences(
          `<html><body><main data-region=content>Fixture workspace</main><script>const socket=new WebSocket(${
            JSON.stringify(forbidden.replace("http:", "ws:") + "/socket")
          });socket.onclose=()=>{document.documentElement.dataset.designReady='true'}</script></body></html>`
        )
        const source = target === "live" ? attack : clean
        const origin = yield* serveFiles(source.root, { "/page.html": "page.html" })
        const result = yield* runConformance(target === "reference" ? attack : clean, {
          output: yield* fs.makeTempDirectoryScoped(),
          captureOnly: target === "live"
        }).pipe(Effect.provideService(LiveProduct, testLive(origin)), Effect.flip)
        expect(result).toMatchObject({ _tag: "BrowserFailure", operation: "external capture network" })
        expect(requests).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )
  })

  test(`service-worker attempts fail without fetching the worker in the ${target} context`, async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        let workerRequests = 0
        let forbiddenRequests = 0
        const forbidden = yield* localServer(() => {
          forbiddenRequests += 1
          return HttpServerResponse.text("fixture data")
        })
        const clean = yield* testReferences(readyHtml)
        const html =
          "<html><body><main data-region=content>Fixture workspace</main><script>navigator.serviceWorker.register('/worker.js').then(()=>{document.documentElement.dataset.designReady='true'},()=>{document.documentElement.dataset.designReady='true'})</script></body></html>"
        const worker = `fetch(${JSON.stringify(`${forbidden}/worker-data`)})`
        const attack = yield* testReferences(
          html,
          { "worker.js": worker }
        )
        const origin = yield* localServer((address) => {
          if (address.startsWith("/worker.js")) {
            workerRequests += 1
            return HttpServerResponse.text(worker, {
              contentType: "text/javascript"
            })
          }
          return HttpServerResponse.html(target === "live" ? html : readyHtml)
        })
        const result = yield* runConformance(target === "reference" ? attack : clean, {
          output: yield* fs.makeTempDirectoryScoped(),
          captureOnly: target === "live"
        }).pipe(Effect.provideService(LiveProduct, testLive(origin)), Effect.flip)
        expect(result).toMatchObject({ _tag: "BrowserFailure", operation: "external capture network" })
        expect(workerRequests).toBe(0)
        expect(forbiddenRequests).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )
  })
}

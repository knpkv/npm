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

for (
  const { file, kind, markup } of [
    { kind: "HTML", file: "missing.html", markup: "<iframe src='/missing.html?cache=fixture'></iframe>" },
    { kind: "CSS", file: "missing.css", markup: "<link rel=stylesheet href='/missing.css?cache=fixture'>" },
    {
      kind: "font",
      file: "missing.woff2",
      markup:
        "<style>@font-face{font-family:Fixture;src:url('/missing.woff2?cache=fixture')}main{font-family:Fixture}</style>"
    },
    { kind: "image", file: "missing.svg", markup: "<img src='/missing.svg?cache=fixture'>" },
    { kind: "script", file: "missing.js", markup: "<script src='/missing.js?cache=fixture'></script>" }
  ]
) {
  test(`unlisted ${kind} requests fail ready refs while live same-origin HTTP errors remain allowed`, async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const attack = yield* testReferences(readyHtml.replace("</body>", `${markup}</body>`))
        const clean = yield* testReferences(readyHtml)
        const origin = yield* serveFiles(attack.root, { "/page.html": "page.html" })
        yield* runConformance(attack, { output: yield* fs.makeTempDirectoryScoped(), captureOnly: true }).pipe(
          Effect.provideService(LiveProduct, testLive(origin))
        )
        const cleanOrigin = yield* serveFiles(clean.root, { "/page.html": "page.html" })
        const invalid = yield* runConformance(attack, { output: yield* fs.makeTempDirectoryScoped() }).pipe(
          Effect.provideService(LiveProduct, testLive(cleanOrigin)),
          Effect.flip
        )
        expect(invalid).toMatchObject({
          _tag: "ReferenceFailure",
          file,
          detail: "Request path is not in the reference hash inventory"
        })
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )
  })
}

test("a hashed ref asset with an HTTP error fails even when its error handler signals readiness", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const refs = yield* testReferences(
        "<html><body><main data-region=content>Fixture workspace</main><img src='/probe.svg?cache=fixture' onerror=\"document.documentElement.dataset.designReady='true'\"></body></html>",
        { "probe.svg": "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'></svg>" }
      )
      // Simulate a file disappearing after hash validation; its listed server route now returns HTTP 500.
      yield* fs.remove(`${refs.root}/probe.svg`)
      const clean = yield* testReferences(readyHtml)
      const origin = yield* serveFiles(clean.root, { "/page.html": "page.html" })
      const invalid = yield* runConformance(refs, { output: yield* fs.makeTempDirectoryScoped() }).pipe(
        Effect.provideService(LiveProduct, testLive(origin)),
        Effect.flip
      )
      expect(invalid).toMatchObject({
        _tag: "ReferenceFailure",
        file: "probe.svg",
        detail: "Reference response HTTP 500"
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

test("reference WebSockets fail even at the reference origin", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const refs = yield* testReferences(
        "<html><body><main data-region=content>Fixture workspace</main><script>const socket=new WebSocket(location.origin.replace('http:','ws:')+'/socket');socket.onclose=()=>{document.documentElement.dataset.designReady='true'}</script></body></html>"
      )
      const clean = yield* testReferences(readyHtml)
      const origin = yield* serveFiles(clean.root, { "/page.html": "page.html" })
      const invalid = yield* runConformance(refs, { output: yield* fs.makeTempDirectoryScoped() }).pipe(
        Effect.provideService(LiveProduct, testLive(origin)),
        Effect.flip
      )
      expect(invalid).toMatchObject({
        _tag: "ReferenceFailure",
        file: "socket",
        detail: "WebSockets are not hashed reference assets"
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

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

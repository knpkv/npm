import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, test } from "@playwright/test"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

import { browserCall, capturePage } from "../src/browser.js"
import { captureContext, installCaptureClock } from "../src/capture.js"
import { LiveProduct } from "../src/live.js"
import { restrictContextNetwork, restrictPageNetwork } from "../src/network.js"
import { runConformance } from "../src/runner.js"
import { serveFiles } from "../src/server.js"
import { bodyTransferServer, localServer, readyHtml, testLive, testReferences } from "./fixtures.js"

for (const extension of ["mjs", "js"]) {
  test(`hashed .${extension} module scripts execute imports and signal reference readiness`, async () => {
    test.setTimeout(10_000)
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const entry = `boot.${extension}`
        const refs = yield* testReferences(
          `<html><body><main data-region=content>Waiting</main><script type=module src='/${entry}?cache=fixture'></script></body></html>`,
          {
            [entry]:
              "import{heading}from './helper.js';document.querySelector('main').textContent=heading;document.documentElement.dataset.designReady='true'",
            "helper.js": "export const heading='Fixture workspace'"
          }
        )
        const origin = yield* serveFiles(refs.root, {
          "/page.html": "page.html",
          [`/${entry}`]: entry,
          "/helper.js": "helper.js"
        })
        const result = yield* runConformance(refs, { output: yield* fs.makeTempDirectoryScoped() }).pipe(
          Effect.provideService(LiveProduct, testLive(origin))
        )
        expect(result?.passed).toBe(true)
        expect(result?.findings).toEqual([])
        expect(result?.shots).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )
  })
}

for (const mode of ["truncated", "cancelled", "complete"]) {
  test(`${mode} 200 response bodies settle before the reference context closes`, async ({ browser }) => {
    // Only the regression deadline bounds OLD code's deadlock; production settlement has no timeout.
    test.setTimeout(10_000)
    await Effect.runPromise(
      Effect.gen(function*() {
        const body = "complete fixture body"
        const html = readyHtml.replace("data-design-ready=true", "data-design-ready=false").replace(
          "</body>",
          "<button id=cancel onclick=controller.abort()>Cancel</button><script>const controller=new AbortController();fetch('/probe.txt',{signal:controller.signal}).then(response=>response.text()).then(text=>{document.documentElement.dataset.transfer=text;document.documentElement.dataset.designReady='true'},()=>{document.documentElement.dataset.transfer='failed';document.documentElement.dataset.designReady='true'})</script></body>"
        )
        const server = yield* bodyTransferServer(html, body)
        const context = yield* Effect.acquireRelease(
          browserCall(
            "body transfer context",
            () => browser.newContext({ ...captureContext, serviceWorkers: "block" })
          ),
          (context) => browserCall("close body transfer context", () => context.close()).pipe(Effect.orDie)
        )
        const blocked: Array<string> = []
        const network = yield* restrictContextNetwork(
          context,
          server.origin,
          blocked,
          new Set(["page.html", "probe.txt"])
        )
        const page = yield* browserCall("body transfer page", () => context.newPage())
        const interception = yield* restrictPageNetwork(context, page, network.permits)
        yield* browserCall("body transfer clock", () => installCaptureClock(page))
        yield* browserCall("observe probe headers before ending transfer", async () => {
          const headers = page.waitForResponse((response) => response.url() === `${server.origin}/probe.txt`)
          await page.goto(`${server.origin}/page.html`)
          const response = await headers
          expect(response.status()).toBe(200)
          expect(response.headers()["content-length"]).toBe(String(body.length))
        })
        if (mode === "complete") yield* server.finish
        else {
          const failure = yield* browserCall("observe terminal body failure", async () => ({
            request: page.waitForEvent("requestfailed", (request) => request.url() === `${server.origin}/probe.txt`)
          }))
          if (mode === "truncated") yield* server.truncate
          else yield* browserCall("cancel response after headers", () => page.locator("#cancel").click())
          yield* browserCall("assert terminal body failure", async () => {
            const request = await failure.request
            expect(request.failure()?.errorText).toBe(
              mode === "truncated" ? "net::ERR_CONTENT_LENGTH_MISMATCH" : "net::ERR_ABORTED"
            )
          })
        }
        yield* browserCall("body failure can still signal readiness", async () => {
          await page.locator("html[data-design-ready=true]").waitFor()
          expect(await page.locator("html").getAttribute("data-transfer")).toBe(mode === "complete" ? body : "failed")
        })
        // Match withPage ordering: capture and both network settlements happen before scope closes the context.
        expect((yield* capturePage(page)).frame.byteLength).toBeGreaterThan(0)
        yield* interception.settle()
        if (mode === "complete") yield* network.settle()
        else {
          const failure = yield* network.settle().pipe(Effect.flip)
          expect(failure).toMatchObject({
            _tag: "ReferenceFailure",
            file: "probe.txt",
            detail: `Reference request failed: ${
              mode === "truncated" ? "net::ERR_CONTENT_LENGTH_MISMATCH" : "net::ERR_ABORTED"
            }`
          })
        }
        expect(page.isClosed()).toBe(false)
        expect(blocked).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )
  })
}

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

test("a hashed ref asset with an HTTP error fails even when its error handler signals readiness", async ({ browser }) => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const origin = yield* localServer((address) =>
        address.startsWith("/probe.svg")
          ? HttpServerResponse.empty({ status: 500 })
          : HttpServerResponse.html(
            "<html><body><main data-region=content>Fixture workspace</main><img src='/probe.svg?cache=fixture' onerror=\"document.documentElement.dataset.designReady='true'\"></body></html>"
          )
      )
      const context = yield* Effect.acquireRelease(
        browserCall(
          "HTTP error reference context",
          () => browser.newContext({ ...captureContext, serviceWorkers: "block" })
        ),
        (context) => browserCall("close HTTP error reference context", () => context.close()).pipe(Effect.orDie)
      )
      const network = yield* restrictContextNetwork(context, origin, [], new Set(["page.html", "probe.svg"]))
      const page = yield* browserCall("HTTP error reference page", () => context.newPage())
      const interception = yield* restrictPageNetwork(context, page, network.permits)
      yield* browserCall("HTTP error reference readiness", async () => {
        await page.goto(`${origin}/page.html`)
        await page.locator("html[data-design-ready=true]").waitFor()
      })
      yield* capturePage(page)
      yield* interception.settle()
      expect(yield* network.settle().pipe(Effect.flip)).toMatchObject({
        _tag: "ReferenceFailure",
        file: "probe.svg",
        detail: "Reference response HTTP 500"
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** Rewrite after the production hash boundary, before either renderer navigates. */
test("reference navigation serves original verified HTML and unchanged hashed assets after disk rewrite", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const html = readyHtml.replace("</body>", "<link rel=stylesheet href='/probe.css'></body>")
      const css = "main { color: rgb(255, 0, 0); }"
      const refs = yield* testReferences(html, { "probe.css": css })
      const origin = yield* localServer((address) =>
        address.startsWith("/probe.css")
          ? HttpServerResponse.text(css, { contentType: "text/css" })
          : HttpServerResponse.html(html)
      )
      yield* fs.writeFileString(`${refs.root}/page.html`, html.replace("Fixture workspace", "Unverified rewrite"))
      const result = yield* runConformance(refs, { output: yield* fs.makeTempDirectoryScoped() }).pipe(
        Effect.provideService(LiveProduct, testLive(origin))
      )
      expect(result?.passed).toBe(true)
      expect(result?.findings).toEqual([])
      expect(result?.shots).toHaveLength(1)
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

for (const target of ["live", "reference"]) {
  test(`popup redirect requests are blocked before dispatch in the ${target} context`, async ({ browser }) => {
    await Effect.runPromise(
      Effect.gen(function*() {
        let forbiddenRequests = 0
        const forbidden = yield* localServer(() => {
          forbiddenRequests += 1
          return HttpServerResponse.html(readyHtml)
        })
        const origin = yield* localServer((address) => {
          if (address === "/jump") {
            return HttpServerResponse.empty({
              status: 302,
              headers: { location: `${forbidden}/page.html` }
            })
          }
          return HttpServerResponse.html(readyHtml.replace("</body>", "<script>window.open('/jump')</script></body>"))
        })
        const context = yield* Effect.acquireRelease(
          browserCall(
            "popup boundary context",
            () => browser.newContext({ ...captureContext, serviceWorkers: "block" })
          ),
          (context) => browserCall("close popup boundary context", () => context.close()).pipe(Effect.orDie)
        )
        const blocked: Array<string> = []
        const network = yield* restrictContextNetwork(
          context,
          origin,
          blocked,
          target === "reference" ? new Set(["page.html", "jump"]) : undefined
        )
        const page = yield* browserCall("popup boundary page", () => context.newPage())
        const interception = yield* restrictPageNetwork(context, page, network.permits)
        yield* browserCall("observe popup attempt", async () => {
          const popup = page.waitForEvent("popup")
          await page.goto(`${origin}/page.html`)
          await popup
        })
        yield* capturePage(page)
        yield* interception.settle()
        yield* network.settle().pipe(Effect.result)
        expect(forbiddenRequests).toBe(0)
        expect(blocked.some((address) => address.startsWith("additional-page:") || address.startsWith("unowned-page:")))
          .toBe(true)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )
  })
}

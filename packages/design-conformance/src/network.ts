import type { BrowserContext, Page, Request } from "@playwright/test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { browserCall } from "./browser.js"
import { BrowserFailure, ReferenceFailure } from "./schema.js"

declare global {
  interface Window {
    __designCaptureBlocked: (address: string) => Promise<void>
  }
}

/** Local browser schemes do not send packets; network URLs require an exact HTTP origin. */
export const permittedCaptureUrl = (address: string, origin: string): boolean => {
  const url = new URL(address)
  return ["about:", "data:", "blob:"].includes(url.protocol) ||
    ["http:", "https:"].includes(url.protocol) && url.origin === origin
}

/** Query/fragment variants identify the same hashed file; encoded or extended paths do not. */
export const permittedReferenceUrl = (address: string, files: ReadonlySet<string>): boolean =>
  files.has(new URL(address).pathname.slice(1))

/** Install before creating pages. Service-worker attempts fail the capture even when the app catches rejection. */
export const restrictContextNetwork = Effect.fn("DesignConformance.restrictContextNetwork")(
  function*(context: BrowserContext, origin: string, blocked: Array<string>, referenceFiles?: ReadonlySet<string>) {
    const pending = new Set<Promise<void>>()
    const failures: Array<ReferenceFailure> = []
    let capturePage: Page | undefined
    const failedRequests = new Map<Request, (failure: ReferenceFailure) => void>()
    const permits = (address: string): boolean => {
      if (!permittedCaptureUrl(address, origin)) {
        blocked.push(address)
        return false
      }
      const url = new URL(address)
      if (
        referenceFiles !== undefined && ["http:", "https:"].includes(url.protocol) &&
        !permittedReferenceUrl(address, referenceFiles)
      ) {
        failures.push(
          new ReferenceFailure({
            file: url.pathname.slice(1),
            detail: "Request path is not in the reference hash inventory"
          })
        )
        return false
      }
      return true
    }
    yield* browserCall("restrict capture network", async () => {
      context.on("page", (page) => {
        if (capturePage === undefined) capturePage = page
        else blocked.push(`additional-page:${page.url()}`)
      })
      context.on("request", (request) => {
        const url = new URL(request.url())
        if (referenceFiles === undefined || !["http:", "https:"].includes(url.protocol) || url.origin !== origin) return
        const file = url.pathname.slice(1)
        const failed = new Promise<ReferenceFailure>((resolve) => failedRequests.set(request, resolve))
        const completed = (async () => {
          const response = await request.response()
          if (response === null) {
            return new ReferenceFailure({ file, detail: "Reference request received no HTTP response" })
          } else if (!response.ok()) {
            return new ReferenceFailure({ file, detail: `Reference response HTTP ${response.status()}` })
          } else {
            const error = await response.finished()
            if (error !== null) {
              return new ReferenceFailure({ file, detail: `Reference response failed: ${error.message}` })
            }
          }
        })()
        // Playwright 1.63 does not settle response.finished() on requestfailed after headers.
        const action = Promise.race([completed, failed]).then((failure) => {
          if (failure !== undefined) failures.push(failure)
        }).catch((cause) => {
          failures.push(new ReferenceFailure({ file, detail: `Reference request failed: ${String(cause)}` }))
        }).finally(() => failedRequests.delete(request))
        pending.add(action)
        void action.then(() => pending.delete(action))
      })
      context.on("requestfailed", (request) => {
        if (!permittedCaptureUrl(request.url(), origin)) blocked.push(request.url())
        const fail = failedRequests.get(request)
        if (fail !== undefined) {
          const reason = request.failure()
          fail(
            new ReferenceFailure({
              file: new URL(request.url()).pathname.slice(1),
              detail: reason === null
                ? "Reference request failed without a browser reason"
                : `Reference request failed: ${reason.errorText}`
            })
          )
        }
      })
      await context.route("**/*", async (route) => {
        const request = route.request()
        let requestPage: Page
        try {
          requestPage = request.frame().page()
        } catch (cause) {
          // Initial popup requests can precede their Playwright frame. Unowned traffic fails closed.
          blocked.push(`unowned-page:${request.url()}:${String(cause)}`)
          await route.abort("blockedbyclient")
          return
        }
        if (requestPage !== capturePage) {
          blocked.push(`additional-page:${request.url()}`)
          await route.abort("blockedbyclient")
        } else if (permits(request.url())) await route.continue()
        else await route.abort("blockedbyclient")
      })
      await context.routeWebSocket("**/*", async (socket) => {
        const url = new URL(socket.url())
        url.protocol = url.protocol === "wss:" ? "https:" : "http:"
        if (url.origin === origin && referenceFiles === undefined) socket.connectToServer()
        else {
          if (url.origin === origin) {
            failures.push(
              new ReferenceFailure({
                file: url.pathname.slice(1),
                detail: "WebSockets are not hashed reference assets"
              })
            )
          } else blocked.push(socket.url())
          await socket.close({ code: 1008, reason: "Capture network boundary" })
        }
      })
      await context.exposeBinding("__designCaptureBlocked", (_source, address: string) => {
        blocked.push(Schema.decodeUnknownSync(Schema.String)(address))
      })
      await context.addInitScript(() => {
        if (navigator.serviceWorker === undefined) return
        navigator.serviceWorker.register = async (scriptURL) => {
          await window.__designCaptureBlocked(`service-worker:${String(scriptURL)}`)
          throw new DOMException("Service workers are blocked in design captures", "SecurityError")
        }
      })
    })
    return {
      permits,
      settle: Effect.fn("DesignConformance.settleReferenceNetwork")(function*() {
        yield* browserCall("settle reference responses", async () => {
          while (pending.size > 0) await Promise.all(pending)
        })
        const failure = failures[0]
        if (failure !== undefined) return yield* failure
      })
    }
  }
)

const PausedRequest = Schema.Struct({ requestId: Schema.String, request: Schema.Struct({ url: Schema.String }) })
type PausedRequest = Schema.Schema.Type<typeof PausedRequest>

/** The context owns this session until close. Fetch interception validates every native redirect hop. */
export const restrictPageNetwork = Effect.fn("DesignConformance.restrictPageNetwork")(
  function*(context: BrowserContext, page: Page, permits: (address: string) => boolean) {
    const session = yield* browserCall("capture network session", () => context.newCDPSession(page))
    const pending = new Set<Promise<void>>()
    const failures: Array<BrowserFailure> = []
    yield* browserCall("intercept capture redirect targets", async () => {
      session.on("Fetch.requestPaused", (event: PausedRequest) => {
        const action = (async () => {
          const { request, requestId } = Schema.decodeUnknownSync(PausedRequest)(event)
          if (permits(request.url)) await session.send("Fetch.continueRequest", { requestId })
          else await session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
        })().catch((cause) => {
          failures.push(new BrowserFailure({ operation: "intercept capture redirect targets", cause }))
        })
        pending.add(action)
        void action.then(() => pending.delete(action))
      })
      await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] })
    })
    return {
      settle: Effect.fn("DesignConformance.settleCaptureNetwork")(function*() {
        yield* browserCall("settle capture interception", async () => {
          await Promise.all(pending)
        })
        const failure = failures[0]
        if (failure !== undefined) return yield* failure
      })
    }
  }
)

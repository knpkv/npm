import type { BrowserContext, Page } from "@playwright/test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { browserCall } from "./browser.js"
import { BrowserFailure } from "./schema.js"

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

/** Install before creating pages. Service-worker attempts fail the capture even when the app catches rejection. */
export const restrictContextNetwork = Effect.fn("DesignConformance.restrictContextNetwork")(
  function*(context: BrowserContext, origin: string, blocked: Array<string>) {
    yield* browserCall("restrict capture network", async () => {
      context.on("requestfailed", (request) => {
        if (!permittedCaptureUrl(request.url(), origin)) blocked.push(request.url())
      })
      await context.route("**/*", async (route) => {
        const address = route.request().url()
        if (permittedCaptureUrl(address, origin)) await route.continue()
        else {
          blocked.push(address)
          await route.abort("blockedbyclient")
        }
      })
      await context.routeWebSocket("**/*", async (socket) => {
        const url = new URL(socket.url())
        url.protocol = url.protocol === "wss:" ? "https:" : "http:"
        if (url.origin === origin) socket.connectToServer()
        else {
          blocked.push(socket.url())
          await socket.close({ code: 1008, reason: "External capture network" })
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
  }
)

const PausedRequest = Schema.Struct({ requestId: Schema.String, request: Schema.Struct({ url: Schema.String }) })
type PausedRequest = Schema.Schema.Type<typeof PausedRequest>

/** The context owns this session until close. Fetch interception validates every native redirect hop. */
export const restrictPageNetwork = Effect.fn("DesignConformance.restrictPageNetwork")(
  function*(context: BrowserContext, page: Page, origin: string, blocked: Array<string>) {
    const session = yield* browserCall("capture network session", () => context.newCDPSession(page))
    const pending = new Set<Promise<void>>()
    const failures: Array<BrowserFailure> = []
    yield* browserCall("intercept capture redirect targets", async () => {
      session.on("Fetch.requestPaused", (event: PausedRequest) => {
        const action = (async () => {
          const { request, requestId } = Schema.decodeUnknownSync(PausedRequest)(event)
          if (permittedCaptureUrl(request.url, origin)) await session.send("Fetch.continueRequest", { requestId })
          else {
            blocked.push(request.url)
            await session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
          }
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

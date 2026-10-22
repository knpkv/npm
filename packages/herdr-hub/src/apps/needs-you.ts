/** Ready apps that declare `needs-you` join the hub's collector; each is read from its own socket. @module */
import { appPaths } from "@knpkv/hub-app"
import { Effect } from "effect"
import type { NeedsYouProvider } from "../module-needs-you-server.js"
import type { AppRegistry } from "./registry.js"
import { getJson } from "./socket.js"

/** The collector's own 4 s timeout bounds the read; this one only frees the socket. */
const readTimeoutMillis = 5_000

export const appNeedsYouProviders = (registry: AppRegistry): Effect.Effect<ReadonlyArray<NeedsYouProvider>> =>
  Effect.map(
    registry.apps,
    (apps) =>
      apps.flatMap((app) =>
        app.state._tag === "Ready" && app.state.manifest.services.includes("needs-you")
          ? [{
            id: app.id,
            pages: app.state.manifest.module.pages.map((page) => page.id),
            read: getJson(app.socket, appPaths.needsYou, readTimeoutMillis)
          }]
          : []
      )
  )

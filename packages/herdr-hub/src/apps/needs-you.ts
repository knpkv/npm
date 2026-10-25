/**
 * Ready apps that declare `needs-you` join the hub's collector; each is read from its own endpoint.
 *
 * The collector is built once for every listener, so a third-party app's items also show where its page is
 * `local_only`. Left so on purpose: an item carries no free text (only ids, a page and counts), and following it
 * lands on the panel that says the app opens only on this machine.
 *
 * @module
 */
import { appPaths } from "@knpkv/hub-app"
import { Effect } from "effect"
import type { NeedsYouProvider } from "../module-needs-you-server.js"
import { type AppRegistry, getFromApp } from "./registry.js"

/** The collector's own 4 s timeout bounds the read; this one only frees the socket. */
const readTimeoutMillis = 5_000

export const appNeedsYouProviders = (registry: AppRegistry): Effect.Effect<ReadonlyArray<NeedsYouProvider>> =>
  Effect.map(
    registry.apps,
    (apps) =>
      apps.flatMap((app) =>
        app.state._tag === "Ready" && app.reach !== null && app.state.manifest.services.includes("needs-you")
          ? [{
            id: app.id,
            pages: app.state.manifest.module.pages.map((page) => page.id),
            read: getFromApp(app.reach, appPaths.needsYou, readTimeoutMillis)
          }]
          : []
      )
  )

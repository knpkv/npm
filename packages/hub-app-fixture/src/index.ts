/**
 * A one-page app for the hub's contract tests, with knobs for each way an app can fail:
 *
 * - `ok`: serves normally. `GET /echo` answers the caller; `POST /job` submits a Fleet job for it.
 * - `contract-2`: declares a contract this hub doesn't speak.
 * - `wrong-id`: answers as another app.
 * - `mount-throws`: its client's `mount` throws.
 *
 * Throwing at load and hanging aren't runner modes: a test runs no app, or a socket that never answers.
 *
 * @module
 */
import {
  AppId,
  type AppManifestInput,
  ModuleHandlers,
  moduleReadRoute,
  ModuleRouteFailure,
  moduleWriteRoute
} from "@knpkv/hub-app"
import { ShellServices } from "@knpkv/hub-app/hub-client"
import type { AppServer } from "@knpkv/hub-app/node"
import { Effect, Layer, Schema } from "effect"
import { fileURLToPath } from "node:url"

export const FixtureMode = Schema.Literals(["ok", "contract-2", "wrong-id", "mount-throws"])
export type FixtureMode = typeof FixtureMode.Type

export const fixtureManifest = (mode: FixtureMode, id = "fixture"): AppManifestInput => {
  const answeredId = mode === "wrong-id" ? `${id}-other` : id
  return {
    contract: mode === "contract-2" ? 2 : 1,
    id: Schema.decodeSync(AppId)(answeredId),
    package: "@knpkv/hub-app-fixture",
    version: "0.0.0",
    module: {
      id: answeredId,
      label: "Fixture",
      defaultPage: "overview",
      pages: [{ id: "overview", label: "Overview" }],
      listeners: ["serve", "local"],
      requires: ["read", "write"]
    },
    services: ["jobs.submit", "relay.post", "host", "needs-you"],
    nav: { order: 100, primary: false, mobile: false },
    standalone: { defaultPort: 3190 }
  }
}

const Echo = Schema.Struct({
  login: Schema.String,
  sameNode: Schema.Boolean,
  provenance: Schema.Literals(["verified_local_listener", "authenticated_remote"])
})
const Empty = Schema.fromURLSearchParams(Schema.Struct({}))
const JobRequest = Schema.Struct({ payload: Schema.Json })
const JobReply = Schema.Struct({ jobId: Schema.String, status: Schema.String })

const handlers = Layer.effect(
  ModuleHandlers,
  Effect.gen(function*() {
    const shell = yield* ShellServices
    return {
      routes: [
        moduleReadRoute("/echo", Empty, Echo, (_query, caller) => Effect.succeed(caller)),
        moduleWriteRoute("POST", "/job", Empty, JobRequest, JobReply, ({ payload }) =>
          shell.submitJob(payload).pipe(
            Effect.mapError((error) =>
              error._tag === "GrantInvalid"
                ? new ModuleRouteFailure({ status: 403, code: `grant_${error.reason}` })
                : new ModuleRouteFailure({ status: 503, code: "unavailable" })
            )
          ))
      ],
      needsYou: Effect.succeed({ items: [], issues: [], asOf: null })
    }
  })
)

/** The fixture as its runner serves it. */
export const fixtureApp = (mode: FixtureMode, id = "fixture"): AppServer<never, never> => ({
  manifest: fixtureManifest(mode, id),
  handlers,
  clientDirectory: fileURLToPath(
    new URL(mode === "mount-throws" ? "../client/throws" : "../client/ok", import.meta.url)
  )
})

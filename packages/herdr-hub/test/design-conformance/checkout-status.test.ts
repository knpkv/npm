import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { Fixture } from "../../../design-conformance/src/schema.js"
import { checkoutDashboard } from "../../scripts/design-checkout-status.js"
import { makeCodeReadings } from "./fixtures.js"

const loadSnapshot = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = yield* path.fromFileUrl(new URL("../../../../design-refs/code-review/fixture.json", import.meta.url))
  const fixture = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Fixture))(yield* fs.readFileString(file))
  return makeCodeReadings(fixture.data).snapshot
})

it.layer(NodeServices.layer)("design capture status shape", (it) => {
  // Base capture drives the merge-base app with this fixture: a checkout from before the repository object
  // decodes the flat fields, so it is served those, or its page never renders.
  it.effect("serves a checkout without HostRepository the flat repository fields", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const snapshot = yield* loadSnapshot
      const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "design-checkout-" })
      const model = path.join(checkout, "packages/herdr-fleet/dist")
      yield* fs.makeDirectory(model, { recursive: true })
      yield* fs.writeFileString(path.join(model, "model.js"), "export const HostStatus = {}\n")
      const served = (yield* checkoutDashboard(checkout))(snapshot)
      expect(served.status).toEqual({
        applyConfigured: false,
        branch: "main",
        dirty: false,
        herdr: snapshot.status.herdr,
        host: snapshot.status.host,
        repository: "fixture",
        revision: "fixture-revision"
      })
    }).pipe(Effect.scoped))

  it.effect("serves this checkout the snapshot unchanged", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const snapshot = yield* loadSnapshot
      const repository = yield* path.fromFileUrl(new URL("../../../../", import.meta.url))
      expect((yield* checkoutDashboard(repository))(snapshot)).toBe(snapshot)
    }))
})

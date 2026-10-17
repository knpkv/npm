import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { StackDetailResult, StacksOverviewResult } from "@knpkv/alchemy-console/host"
import type { StacksHostReads } from "@knpkv/alchemy-console/host/server"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { ConfigProvider, Effect, Layer, Result, Schema } from "effect"
import { stacksModule } from "../src/module-contract.js"
import { dispatchModuleRoute, makeModuleLayer } from "../src/module-server.js"
import { makeStacksModule, readStacksHost, StacksReaderStartError } from "../src/stacks-module.js"

const host = Schema.decodeUnknownSync(FleetHostName)("atlas")
const other = Schema.decodeUnknownSync(FleetHostName)("cedar")
const id = "00000000-0000-4000-8000-000000000001"

const request = (path: string, listener: "serve" | "approval" | "tailnet" | "lan" | "work" = "serve", method = "GET") =>
  dispatchModuleRoute({
    method,
    listener,
    url: new URL(`https://hub.example/v1/modules/stacks/${path}`),
    authorize: Effect.succeed({ login: "example-viewer", sameNode: false }),
    sameOrigin: Effect.void,
    readJson: () => Effect.die("Stacks has no write routes")
  })

const overview: StacksOverviewResult = {
  _tag: "Ready",
  list: {
    stacks: [{
      id,
      app: "aws-org",
      stage: "org",
      backend: "s3",
      alchemyVersion: "2.0.0-beta.81",
      lastDeploy: null,
      resourceCount: 42
    }],
    issues: []
  }
}

const fakeReads: StacksHostReads = {
  overview: Effect.succeed(overview),
  stack: (stackId) =>
    stackId === id
      ? Effect.succeed<StackDetailResult>({ _tag: "Failed", reason: "authentication" })
      : Effect.die("unknown id reached the reader"),
  plan: () => Effect.succeed({ _tag: "Ready", plan: { _tag: "NotPublishing" } })
}

const withModule = <A, E, R>(
  stacksHost: FleetHostName | null,
  run: Effect.Effect<A, E, R>,
  reads: Effect.Effect<StacksHostReads, StacksReaderStartError> = Effect.succeed(fakeReads),
  isHub = true
) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(
      makeModuleLayer([stacksModule], [makeStacksModule({ host, isHub, stacksHost, home: "/fixture", reads })])
        .pipe(Layer.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)))
    )
    return yield* run.pipe(Effect.provideContext(context))
  })

describe("host-local Stacks module", () => {
  it("is a read-only serve module with an overview and a stack page", () => {
    expect(stacksModule).toMatchObject({
      id: "stacks",
      defaultPage: "overview",
      listeners: ["serve"],
      requires: ["read"]
    })
    expect(stacksModule.pages.map(({ id: page }) => page)).toEqual(["overview", "stack"])
  })

  it.effect("serves the configured host's stacks on the serve listener only, read-only", () =>
    withModule(
      host,
      Effect.gen(function*() {
        expect((yield* request("overview"))?.body).toEqual(overview)
        expect((yield* request(`stack?id=${id}`))?.body).toEqual({ _tag: "Failed", reason: "authentication" })
        expect((yield* request(`plan?id=${id}`))?.body).toEqual({ _tag: "Ready", plan: { _tag: "NotPublishing" } })
        const others: ReadonlyArray<"approval" | "tailnet" | "lan" | "work"> = ["approval", "tailnet", "lan", "work"]
        for (const listener of others) {
          expect(yield* request("overview", listener)).toBeNull()
        }
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          expect(yield* request("overview", "serve", method)).toBeNull()
        }
        const invalid = yield* Effect.result(request("stack?id=not-a-uuid"))
        expect(invalid._tag).toBe("Failure")
        if (invalid._tag === "Failure") expect(invalid.failure).toMatchObject({ status: 400, code: "invalid_query" })
      })
    ))

  it.effect("is unavailable, with the reason, when not configured or configured for another host", () =>
    Effect.gen(function*() {
      const notConfigured = yield* withModule(null, request("overview"))
      expect(notConfigured?.body).toEqual({ _tag: "Unavailable", reason: "not_configured", host: null })
      const elsewhere = yield* withModule(other, request(`plan?id=${id}`))
      expect(elsewhere?.body).toEqual({ _tag: "Unavailable", reason: "other_host", host: other })
      // This host is the named one but isn't the hub: say so, rather than point at itself.
      const notHub = yield* withModule(host, request("overview"), Effect.succeed(fakeReads), false)
      expect(notHub?.body).toEqual({ _tag: "Unavailable", reason: "not_hub", host })
    }))

  // A reader that can't start (no AWS config, no state root) is a remote fact, never a startup failure.
  it.effect("is unavailable, not a startup failure, when the host's reader can't start", () =>
    withModule(
      host,
      Effect.gen(function*() {
        expect((yield* request("overview"))?.body).toEqual({ _tag: "Unavailable", reason: "unavailable", host })
      }),
      Effect.fail(new StacksReaderStartError({ cause: "no state root" }))
    ))

  it.effect("reads RELAY_STACKS_HOST: missing is none, invalid fails startup", () =>
    Effect.gen(function*() {
      const read = (config: Record<string, string>) =>
        readStacksHost.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)))
      expect(yield* read({})).toBeNull()
      expect(yield* read({ RELAY_STACKS_HOST: "atlas" })).toBe(host)
      const invalid = yield* Effect.result(read({ RELAY_STACKS_HOST: "invalid host" }))
      expect(Result.isFailure(invalid)).toBe(true)
      if (Result.isFailure(invalid)) expect(invalid.failure._tag).toBe("FleetValidationError")
    }))
})

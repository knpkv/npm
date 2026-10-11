import { Context, Effect, Layer, Ref } from "effect"
import type { CatalogReadError, DiscoveryIssue } from "../src/api.js"
import type { StackState } from "../src/schema.js"
import { type DiscoveredStack, StackSource } from "../src/server/Catalog.js"

export const state: StackState = {
  app: "billing",
  stage: "prod",
  backend: "local",
  alchemyVersion: "2.0.0-beta.77",
  lastDeploy: null,
  resources: [{
    fqn: "Storage/Assets",
    logicalId: "Assets",
    resourceType: "AWS.S3.Bucket",
    status: "created",
    parent: "Storage",
    providerId: null,
    account: null,
    region: null,
    consoleUrl: null
  }]
}

export const entry: DiscoveredStack = {
  key: "fixture-private-locator",
  summary: {
    app: state.app,
    stage: state.stage,
    backend: state.backend,
    alchemyVersion: state.alchemyVersion,
    lastDeploy: null,
    resourceCount: 1
  },
  read: Effect.succeed({
    ...state,
    props: "fixture-secret",
    resources: state.resources.map((resource) => ({ ...resource, attrs: "fixture-secret" }))
  })
}

export class FixtureSource extends Context.Service<FixtureSource, {
  readonly calls: Ref.Ref<number>
  readonly entries: Ref.Ref<ReadonlyArray<DiscoveredStack>>
  readonly issues: Ref.Ref<ReadonlyArray<DiscoveryIssue>>
  readonly failure: Ref.Ref<CatalogReadError | null>
}>()("AlchemyConsole/FixtureSource") {}

export const fixtureSourceLayer = Layer.effectContext(Effect.gen(function*() {
  const calls = yield* Ref.make(0)
  const entries = yield* Ref.make<ReadonlyArray<DiscoveredStack>>([entry])
  const issues = yield* Ref.make<ReadonlyArray<DiscoveryIssue>>([])
  const failure = yield* Ref.make<CatalogReadError | null>(null)
  const discover = Effect.fn("FixtureSource.discover")(function*() {
    yield* Ref.update(calls, (count) => count + 1)
    const error = yield* Ref.get(failure)
    if (error !== null) return yield* error
    return { stacks: yield* Ref.get(entries), issues: yield* Ref.get(issues) }
  })
  return Context.make(FixtureSource, { calls, entries, issues, failure }).pipe(
    Context.add(StackSource, { discover: discover() })
  )
}))

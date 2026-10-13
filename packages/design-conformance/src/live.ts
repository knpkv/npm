import type { Page } from "@playwright/test"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"

import type { BrowserFailure, Fixture, Identity, Inventory, RunnerFailure } from "./schema.js"

export class LiveProduct extends Context.Service<LiveProduct, {
  readonly origin: string
  /** Derive from live inputs owned by the product package, independently of design-refs. */
  readonly inventory: Inventory
  /** Seed fixture and capture identity before navigation. Live route query keys belong to the application. */
  readonly seed: (
    page: Page,
    fixture: Fixture,
    identity: Identity
  ) => Effect.Effect<void, BrowserFailure | RunnerFailure>
  /** Wait for product-specific rendering after navigation. */
  readonly ready: (page: Page, identity: Identity) => Effect.Effect<void, BrowserFailure | RunnerFailure>
}>()("@knpkv/design-conformance/LiveProduct") {}

export type StartProduct = (fixture: Fixture, repository: string) => Effect.Effect<
  LiveProduct["Service"],
  PlatformError.PlatformError | RunnerFailure | BrowserFailure,
  FileSystem.FileSystem | Path.Path | Scope.Scope
>

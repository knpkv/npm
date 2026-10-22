/**
 * Base capture drives the merge-base app with the PR's fixture. A checkout built before `HostStatus` carried one
 * `repository` object decodes the earlier flat fields, so the adapters serve each checkout the shape it reads.
 *
 * @module
 */
import { RunnerFailure } from "@knpkv/design-conformance"
import type { HostStatus } from "@knpkv/herdr-fleet/model"
import { Effect, Path, Schema } from "effect"
import type { DashboardSnapshot } from "../src/dashboard-model.js"

/** The status a checkout without `HostRepository` decodes: nullable flat fields and a repository path. */
type FlatHostStatus = Omit<HostStatus, "repository"> & {
  readonly branch: string | null
  readonly dirty: boolean
  readonly repository: string | null
  readonly revision: string | null
}

/** A dashboard snapshot in the shape the served checkout decodes. */
export type CheckoutDashboard =
  | DashboardSnapshot
  | (Omit<DashboardSnapshot, "status"> & { readonly status: FlatHostStatus })

/** The checkout's built page, which embeds the snapshot it is given in the shape that checkout reads. */
export interface CheckoutPage {
  dashboardPage(snapshot: CheckoutDashboard, fonts: string): string
}

const RepositoryObjectModel = Schema.Struct({ HostRepository: Schema.Unknown })

const flatStatus = ({ repository, ...status }: HostStatus): FlatHostStatus => ({
  ...status,
  branch: repository?.branch ?? null,
  dirty: repository?.dirty ?? false,
  repository: repository?.path ?? null,
  revision: repository?.revision ?? null
})

/** Reads the checkout's built Fleet model once and returns the projection its app decodes. */
export const checkoutDashboard = Effect.fn("DesignConformance.checkoutDashboard")(function*(repository: string) {
  const path = yield* Path.Path
  const file = path.join(repository, "packages/herdr-fleet/dist/model.js")
  const url = yield* path.toFileUrl(file).pipe(
    Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid Fleet model path ${file}: ${String(cause)}` }))
  )
  const model: unknown = yield* Effect.tryPromise({
    try: () => import(url.href),
    catch: (cause) => new RunnerFailure({ detail: `Cannot load built Fleet model ${file}: ${String(cause)}` })
  })
  return Schema.is(RepositoryObjectModel)(model)
    ? (snapshot: DashboardSnapshot): CheckoutDashboard => snapshot
    : (snapshot: DashboardSnapshot): CheckoutDashboard => ({ ...snapshot, status: flatStatus(snapshot.status) })
})

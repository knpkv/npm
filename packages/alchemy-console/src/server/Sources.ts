import { Effect, FileSystem, Layer, Path } from "effect"
import { HttpClient } from "effect/http"
import { CatalogReadError, type DiscoveryIssue } from "../api.js"
import { discoverProjects } from "../discovery.js"
import { readLocalState } from "../local-state.js"
import { discoverSsoProfiles } from "../profiles.js"
import { makeS3Reader } from "../s3-live.js"
import { S3Reader } from "../s3-reader.js"
import { discoverS3Buckets, discoverS3Stacks, readS3State } from "../s3-state.js"
import { SsoCredentials } from "../sso-credentials.js"
import { readAlchemyVersion } from "../version.js"
import { type DiscoveredStack, StackSource } from "./Catalog.js"

/** Runtime configuration contains server-private paths. It is never an API response. */
export interface SourceOptions {
  readonly root: string
  readonly awsConfigFile: string
}

/** Reads only when the authenticated catalog is requested; each project/profile/bucket reports its own failure. */
export const sourceLayer = (options: SourceOptions) =>
  Layer.effect(
    StackSource,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      // Capture the source adapter's services once; read closures need no transport/request context.
      const client = yield* HttpClient.HttpClient
      const sso = yield* SsoCredentials
      const local = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path)
        )
      const discover = Effect.fn("AlchemyConsole.discoverSources")(function*() {
        const stacks: Array<DiscoveredStack> = []
        const issues: Array<DiscoveryIssue> = []
        const discovered = yield* Effect.result(local(discoverProjects(options.root)))
        if (discovered._tag === "Failure") issues.push({ source: "local", reason: discovered.failure.reason })
        else {
          // Entries the walk couldn't read are reported once; the projects it did find are still read.
          if (discovered.success.unreadable > 0) issues.push({ source: "local", reason: "io" })
          if (discovered.success.projects.length > 1000) return yield* new CatalogReadError({ reason: "limit" })
          for (const project of discovered.success.projects) {
            const found = yield* Effect.result(
              local(Effect.gen(function*() {
                const version = yield* readAlchemyVersion(project.directory, options.root)
                // A source with no resource state need not use one of the supported local encodings.
                if (!(yield* fs.exists(path.join(project.directory, ".alchemy", "state")))) return []
                const state = yield* readLocalState(project.directory, version)
                return state.stacks.map((stack): DiscoveredStack => ({
                  key: JSON.stringify(["local", project.directory, stack.app, stack.stage]),
                  summary: {
                    app: stack.app,
                    stage: stack.stage,
                    backend: "local",
                    alchemyVersion: version,
                    lastDeploy: stack.lastDeploy,
                    resourceCount: stack.resources.length
                  },
                  read: local(readLocalState(project.directory, version)).pipe(
                    Effect.mapError((error) => new CatalogReadError({ reason: error.reason })),
                    Effect.flatMap((fresh) => {
                      const current = fresh.stacks.find((item) => item.app === stack.app && item.stage === stack.stage)
                      return current === undefined ?
                        Effect.fail(new CatalogReadError({ reason: "not-found" })) :
                        Effect.succeed(current)
                    })
                  )
                }))
              })).pipe(Effect.mapError((error) =>
                new CatalogReadError({
                  reason: error._tag === "PlatformError" ? "io" : error.reason
                })
              ))
            )
            if (found._tag === "Failure") issues.push({ source: "local", reason: found.failure.reason })
            else for (const stack of found.success) stacks.push(stack)
            if (stacks.length > 1000 || issues.length > 1000) return yield* new CatalogReadError({ reason: "limit" })
          }
        }
        const profiles = yield* Effect.result(local(discoverSsoProfiles(options.awsConfigFile)))
        if (profiles._tag === "Failure") issues.push({ source: "s3", reason: profiles.failure.reason })
        else {
          if (profiles.success.length > 100) return yield* new CatalogReadError({ reason: "limit" })
          for (const profile of profiles.success) {
            const reader = yield* makeS3Reader(profile).pipe(
              Effect.provideService(HttpClient.HttpClient, client),
              Effect.provideService(SsoCredentials, sso)
            )
            const buckets = yield* Effect.result(discoverS3Buckets().pipe(Effect.provideService(S3Reader, reader)))
            if (buckets._tag === "Failure") {
              issues.push({ source: "s3", reason: buckets.failure.reason })
              continue
            }
            if (buckets.success.length > 1000) return yield* new CatalogReadError({ reason: "limit" })
            for (const bucket of buckets.success) {
              const found = yield* Effect.result(discoverS3Stacks(bucket).pipe(Effect.provideService(S3Reader, reader)))
              if (found._tag === "Failure") issues.push({ source: "s3", reason: found.failure.reason })
              else {
                for (const stack of found.success) {
                  stacks.push({
                    key: JSON.stringify([
                      "s3",
                      profile.name,
                      profile.account,
                      bucket.name,
                      stack.prefix,
                      stack.app,
                      stack.stage
                    ]),
                    summary: {
                      app: stack.app,
                      stage: stack.stage,
                      backend: "s3",
                      alchemyVersion: null,
                      lastDeploy: null,
                      resourceCount: null
                    },
                    read: readS3State(stack).pipe(
                      Effect.provideService(S3Reader, reader),
                      Effect.mapError((error) => new CatalogReadError({ reason: error.reason }))
                    )
                  })
                }
              }
              if (stacks.length > 1000 || issues.length > 1000) return yield* new CatalogReadError({ reason: "limit" })
            }
          }
        }
        return { stacks, issues }
      })
      return StackSource.of({ discover: discover() })
    })
  )

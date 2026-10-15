/** Host-local Code mount. No discovery, fan-out, grant, write or publish authority. @module */
import {
  CodeDetail,
  CodeDiffContentQuery,
  CodeDiffContentResult,
  CodeDiffResult,
  CodeQueue,
  CodeQueueQuery,
  CodeReviewResult,
  CodeTargetQuery,
  type CodeUnavailable
} from "@knpkv/codecommit-web/host"
import * as CodeHost from "@knpkv/codecommit-web/host/server"
import { FleetValidationError } from "@knpkv/herdr-fleet"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { Config, Effect, Exit, FileSystem, Layer, Option, Schema, Scope } from "effect"
import * as Path from "effect/Path"
import { makeCodeReferences } from "./code-reference-store.js"
import { codeModule } from "./module-contract.js"
import { ModuleHandlers, moduleReadRoute, ModuleRouteFailure } from "./module-server.js"

/** Missing configuration is unavailable; invalid configuration fails startup without auto-detection. */
export const readCodeHost = Config.option(Config.String("RELAY_CODE_HOST")).pipe(
  Effect.flatMap((configured) =>
    Option.isNone(configured) ?
      Effect.succeed(null) :
      Schema.decodeUnknownEffect(FleetHostName)(configured.value).pipe(
        Effect.mapError(() => new FleetValidationError({ detail: "RELAY_CODE_HOST must be a valid host name" }))
      )
  )
)

/** Only the explicitly selected credential host's own configured hub may build Code authority. */
export const makeCodeModule = (configuration: {
  readonly host: string
  readonly isHub: boolean
  readonly stateDirectory: string
  readonly codeHost: FleetHostName | null
}) => ({
  descriptor: codeModule,
  handlers: Layer.effect(
    ModuleHandlers,
    Effect.gen(function*() {
      const { codeHost, host, isHub, stateDirectory } = configuration
      if (codeHost !== null) {
        yield* Schema.decodeUnknownEffect(FleetHostName)(codeHost).pipe(
          Effect.mapError(() => new FleetValidationError({ detail: "Code host configuration is invalid" }))
        )
      }
      const unavailable = (reason: CodeUnavailable["reason"]): CodeUnavailable => ({
        _tag: "Unavailable",
        reason,
        host: codeHost
      })
      const matches = codeHost !== null && isHub && codeHost.toLowerCase() === host.toLowerCase()
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      // This projection is independent of cache/provider availability. Never read it on another host.
      const ownerUi = matches ?
        CodeHost.readCodeOwnerUi.pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.option
        ) :
        Effect.succeed(Option.none<string>())
      const scope = yield* Effect.acquireRelease(Scope.make(), (child) => Scope.close(child, Exit.void))
      const reads = matches ?
        yield* Effect.result(
          Effect.gen(function*() {
            return yield* CodeHost.makeCodeHostReads(
              makeCodeReferences(path.join(stateDirectory, "code-references.sqlite"))
            )
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.tapError((cause) => Effect.logWarning("Code host read service could not start", cause)),
            Effect.onError(() => Scope.close(scope, Exit.void))
          )
        ) :
        null
      const mounted: CodeUnavailable | { readonly _tag: "Ready"; readonly reader: CodeHost.CodeHostReads } =
        reads === null ?
          unavailable(codeHost === null ? "not_configured" : "other_host") :
          reads._tag === "Failure"
          ? unavailable("unavailable")
          : { _tag: "Ready", reader: reads.success }
      const recover = <A>(effect: Effect.Effect<A, CodeHost.CodeHostReadError>) =>
        effect.pipe(
          Effect.catchTag("CodeHostReadError", (failure) =>
            failure.reason === "not_found"
              ? Effect.fail(new ModuleRouteFailure({ status: 404, code: "not_found" }))
              : Effect.succeed(unavailable(failure.reason)))
        )
      return {
        routes: [
          moduleReadRoute("/queue", CodeQueueQuery, CodeQueue, (query) =>
            Effect.gen(function*() {
              const origin = yield* ownerUi
              const reading = mounted._tag === "Unavailable"
                ? mounted :
                yield* recover(mounted.reader.queue(query))
              return Option.isSome(origin) ? { ...reading, ownerUi: origin.value } : reading
            })),
          moduleReadRoute("/detail", CodeTargetQuery, CodeDetail, ({ ref }) =>
            mounted._tag === "Unavailable"
              ? Effect.succeed(mounted) :
              recover(mounted.reader.detail(ref))),
          moduleReadRoute("/review", CodeTargetQuery, CodeReviewResult, ({ ref }, caller) => {
            if (mounted._tag === "Unavailable") return Effect.succeed(mounted)
            return recover(
              mounted.reader.review(ref, caller).pipe(
                Effect.map((reading): CodeReviewResult => ({ _tag: "Ready", reading }))
              )
            )
          }),
          moduleReadRoute("/diff", CodeTargetQuery, CodeDiffResult, ({ ref }, caller) => {
            if (mounted._tag === "Unavailable") return Effect.succeed(mounted)
            return recover(
              mounted.reader.diff(ref, caller).pipe(Effect.map((diff): CodeDiffResult => ({ _tag: "Ready", diff })))
            )
          }),
          moduleReadRoute("/diff-content", CodeDiffContentQuery, CodeDiffContentResult, (query, caller) => {
            if (mounted._tag === "Unavailable") return Effect.succeed(mounted)
            return recover(
              mounted.reader.diffContent(query, caller).pipe(
                Effect.map((content): CodeDiffContentResult => ({ _tag: "Ready", content }))
              )
            )
          })
        ]
      }
    })
  )
})

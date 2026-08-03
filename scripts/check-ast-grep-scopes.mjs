import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { ESLint } from "eslint"
import { URL } from "node:url"

const suppression = "ast-grep-ignore: no-unowned-detached-fiber"
const eslintSuppression = "eslint-disable-line local-rules/no-unowned-detached-fiber"

class AstGrepScopeCheckError extends Data.TaggedError("AstGrepScopeCheckError") {
  get message() {
    return this.reason
  }
}

const AstGrepFindingsJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ lines: Schema.String })))

const fail = (reason, cause) => Effect.fail(new AstGrepScopeCheckError({ reason, cause }))

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const script = yield* path.fromFileUrl(new URL(import.meta.url))
  const workspaceRoot = path.dirname(path.dirname(script))
  const astGrep = path.join(workspaceRoot, "node_modules", ".bin", "ast-grep")
  const eslint = new ESLint({ cwd: workspaceRoot })
  const detachedFiberRule = path.join(workspaceRoot, "ast-grep", "rules", "effect", "no-unowned-detached-fiber.yml")
  const serverLifecycle = path.join(
    workspaceRoot,
    "packages",
    "control-center",
    "src",
    "server",
    "runtime",
    "ServerLifecycle.ts"
  )

  const source = yield* fs.readFileString(serverLifecycle).pipe(
    Effect.mapError(
      (cause) =>
        new AstGrepScopeCheckError({
          cause,
          reason: "Could not read ServerLifecycle for suppression verification"
        })
    )
  )
  const suppressionCount = source.split(suppression).length - 1
  if (suppressionCount !== 1) {
    return yield* fail(`ServerLifecycle must contain exactly one ${suppression} comment; found ${suppressionCount}`)
  }
  const eslintSuppressionCount = source.split(eslintSuppression).length - 1
  if (eslintSuppressionCount !== 1) {
    return yield* fail(
      `ServerLifecycle must contain exactly one ${eslintSuppression} comment; found ${eslintSuppressionCount}`
    )
  }

  const scan = Effect.fn("AstGrepScopeCheck.scan")(function* (input) {
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(astGrep, ["scan", "--stdin", "--rule", detachedFiberRule, "--json=compact"], {
          cwd: workspaceRoot,
          stdin: {
            endOnDone: true,
            stream: Stream.make(input).pipe(Stream.encodeText)
          }
        })
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new AstGrepScopeCheckError({
              cause,
              reason: "Could not start ast-grep scope fixture"
            })
        )
      )
    const [stdout, status] = yield* Effect.all(
      [Stream.decodeText(handle.stdout).pipe(Stream.mkString), handle.exitCode],
      { concurrency: "unbounded" }
    ).pipe(
      Effect.mapError(
        (cause) =>
          new AstGrepScopeCheckError({
            cause,
            reason: "Could not collect ast-grep scope fixture result"
          })
      )
    )
    const findings = yield* Schema.decodeUnknownEffect(AstGrepFindingsJson)(stdout).pipe(
      Effect.mapError(
        (cause) =>
          new AstGrepScopeCheckError({
            cause,
            reason: "ast-grep scope fixture returned malformed JSON"
          })
      )
    )
    return { findings, status }
  })

  const withoutSuppressionTokens = (input) => input.replaceAll(suppression, "").replaceAll(eslintSuppression, "")
  const scanDetachedWithEslint = Effect.fn("AstGrepScopeCheck.scanDetachedWithEslint")(function* (input) {
    const results = yield* Effect.tryPromise({
      try: () => eslint.lintText(input, { filePath: serverLifecycle, warnIgnored: true }),
      catch: (cause) =>
        new AstGrepScopeCheckError({
          cause,
          reason: "Could not run the binding-aware detached-fiber ESLint check"
        })
    })
    return results.flatMap((result) =>
      result.messages.filter((message) => message.ruleId === "local-rules/no-unowned-detached-fiber")
    )
  })

  const sourceWithoutSuppressions = withoutSuppressionTokens(source)
  const actualDetachedCalls = yield* scan(sourceWithoutSuppressions)
  if (
    actualDetachedCalls.status !== ChildProcessSpawner.ExitCode(1) ||
    actualDetachedCalls.findings.length !== 1 ||
    !actualDetachedCalls.findings[0]?.lines.includes("runDrainHooks.pipe(Effect.forkDetach)")
  ) {
    return yield* fail(
      `ServerLifecycle's audited suppression line must contain exactly one canonical detached fiber; found ${actualDetachedCalls.findings.length}`
    )
  }
  const actualEslintDetachedCalls = yield* scanDetachedWithEslint(sourceWithoutSuppressions)
  const actualEslintLine = actualEslintDetachedCalls[0]?.line
  if (
    actualEslintDetachedCalls.length !== 1 ||
    actualEslintLine === undefined ||
    !sourceWithoutSuppressions.split("\n")[actualEslintLine - 1]?.includes("runDrainHooks.pipe(Effect.forkDetach)")
  ) {
    return yield* fail(
      `ServerLifecycle's audited suppression line must contain exactly one binding-aware detached fiber; found ${actualEslintDetachedCalls.length}`
    )
  }

  const auditedOnly = yield* scan(`
const audited = runDrainHooks.pipe(Effect.forkDetach) // ${suppression}
`)
  if (auditedOnly.status !== ChildProcessSpawner.ExitCode(0) || auditedOnly.findings.length !== 0) {
    return yield* fail("The audited detached lifecycle drain suppression is not line-scoped and effective")
  }

  const withSecondDetach = yield* scan(`
const audited = runDrainHooks.pipe(Effect.forkDetach) // ${suppression}
const leaked = anotherWorker.pipe(Effect.forkDetach)
`)
  if (
    withSecondDetach.status !== ChildProcessSpawner.ExitCode(1) ||
    withSecondDetach.findings.length !== 1 ||
    withSecondDetach.findings[0]?.lines !== "const leaked = anotherWorker.pipe(Effect.forkDetach)"
  ) {
    return yield* fail("A second detached fiber beside the audited lifecycle drain must fail the ast-grep scan")
  }

  const sameLineSecondDetach = yield* scan(
    withoutSuppressionTokens(`
const audited = runDrainHooks.pipe(Effect.forkDetach); const leaked = anotherWorker.pipe(Effect.forkDetach) // ${eslintSuppression} -- ${suppression}
`)
  )
  if (sameLineSecondDetach.status !== ChildProcessSpawner.ExitCode(1) || sameLineSecondDetach.findings.length !== 2) {
    return yield* fail("A second detached fiber on the audited suppression line must fail the scope contract")
  }

  const sameLineAliasDetach = yield* scanDetachedWithEslint(
    withoutSuppressionTokens(`
import * as Effect from "effect/Effect"
const { forkDetach: detach } = Effect
const audited = [runDrainHooks.pipe(Effect.forkDetach), detach(anotherWorker)] // ${eslintSuppression} -- ${suppression}
`)
  )
  if (sameLineAliasDetach.length !== 2) {
    return yield* fail(
      `A destructured detached-fiber alias on the audited suppression line must fail the binding-aware scope contract; found ${sameLineAliasDetach.length}`
    )
  }
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

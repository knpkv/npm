import { ESLint } from "eslint"
import { fileURLToPath, URL } from "node:url"
import fixture from "./fixtures/eslint/invalid-component.mjs"

const eslint = new ESLint()
const fixturePaths = ["packages/codecommit-web/src/invalid-component.tsx", "packages/rly/src/invalid-component.tsx"]

for (const filePath of fixturePaths) {
  const [result] = await eslint.lintText(fixture, { filePath, warnIgnored: true })

  if (result === undefined) {
    throw new Error(`ESLint returned no result for the React discovery fixture at ${filePath}`)
  }

  const explicitAnyViolation = result.messages.some(
    (message) => message.ruleId === "@typescript-eslint/no-explicit-any"
  )

  if (!explicitAnyViolation) {
    throw new Error(`React source linting did not report no-explicit-any at ${filePath}`)
  }
}

const assertRuleDiagnostics = async ({ code, eslintInstance = eslint, expected, filePath, ruleId }) => {
  const [result] = await eslintInstance.lintText(code, { filePath, warnIgnored: true })
  if (result === undefined) throw new Error(`ESLint returned no result for ${filePath}`)
  const diagnostics = result.messages.filter((message) => message.ruleId === ruleId)
  if (diagnostics.length !== expected) {
    const locations = diagnostics.map((message) => `${message.line}:${message.column}`).join(", ")
    throw new Error(
      `${ruleId} reported ${diagnostics.length} diagnostics instead of ${expected} for ${filePath} (${locations})`
    )
  }
}

await assertRuleDiagnostics({
  code: `
    import * as Fx from "effect/Effect"
    import { Effect as RootFx } from "effect"
    import { runPromise as run } from "effect/Effect"
    Fx.runPromise(program).catch(() => {})
    Fx.runPromise(program).catch(() => void 0)
    Fx.runPromise(program).then(undefined, () => undefined)
    RootFx.runPromise(program).catch(() => undefined)
    run(program).catch(function () { return })
  `,
  expected: 5,
  filePath: "packages/control-center/src/client/eslint-run-promise-invalid.ts",
  ruleId: "local-rules/no-silent-run-promise-rejection"
})

await assertRuleDiagnostics({
  code: `
    import * as Fx from "effect/Effect"
    Fx.runPromiseExit(program).then(handleExit)
    Fx.runPromise(program).catch(reportFailure)
    Fx.runPromise(program).catch((failure) => void reportFailure(failure))
    Fx.runPromise(program).catch((failure) => void setState(failure))
  `,
  expected: 0,
  filePath: "packages/control-center/src/client/eslint-run-promise-valid.ts",
  ruleId: "local-rules/no-silent-run-promise-rejection"
})

await assertRuleDiagnostics({
  code: `
    import * as S from "effect/Schema"
    import * as Effect from "effect"
    import { NumberFromString as UnsafeNumber } from "effect/Schema"
    export { NumberFromString as UnsafeExport } from "effect/Schema"
    S["NumberFromString"]
    const { NumberFromString: unsafe } = Effect.Schema
  `,
  expected: 4,
  filePath: "packages/control-center/src/api/eslint-number-from-string-invalid.ts",
  ruleId: "local-rules/no-number-from-string-in-control-center-api"
})

await assertRuleDiagnostics({
  code: `
    import * as Process from "effect/unstable/process/ChildProcess"
    import { ChildProcess as AliasedProcess } from "effect/unstable/process"
    import { make as makeProcess } from "effect/unstable/process/ChildProcess"
    import * as BarrelProcess from "effect/unstable/process"
    Process.make("codex", ["exec"], {
      metadata: { env: options.environment, extendEnv: false },
      stdout: "pipe"
    })
    AliasedProcess.make("codex", ["exec"], {
      env: options.environment,
      extendEnv: false,
      ...unsafeOptions
    })
    makeProcess("codex", ["exec"], dynamicOptions)
    BarrelProcess.ChildProcess.make("codex", ["exec"], dynamicOptions)
    const makeIndirectly = Process.make
    makeIndirectly("codex", ["exec"], dynamicOptions)
    Process.make.call(undefined, "codex", ["exec"], dynamicOptions)
    function shadowed(options) {
      return Process.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
    export { ChildProcess } from "effect/unstable/process"
    const dynamicallyLoaded = import("effect/unstable/process/ChildProcess")
    const templateLoaded = import(\`effect/unstable/process/ChildProcess\`)
    const moduleName = "effect/unstable/process/ChildProcess"
    const computedLoaded = import(moduleName)
    import { createRequire as makeRequire } from "node:module"
    const require = makeRequire(import.meta.url)
    const required = require("effect/unstable/process/ChildProcess")
  `,
  expected: 9,
  filePath: "packages/ai-codex/src/eslint-agent-environment-invalid.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { createRequire as makeRequire } from "module"
    const require = makeRequire(import.meta.url)
    const ChildProcess = require("effect/unstable/process/ChildProcess")
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/commonjs-import-invalid.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    export { createRequire } from "node:module"
    export * from "module"
  `,
  expected: 2,
  filePath: "packages/ai-codex/src/commonjs-export-invalid.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    const nodeModule = import("node:module")
    const legacyModule = import("module")
  `,
  expected: 2,
  filePath: "packages/ai-codex/src/commonjs-dynamic-invalid.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { builtinModules as nodeBuiltins } from "node:module"
    import { builtinModules as legacyBuiltins } from "module"
    export { builtinModules } from "node:module"
    import type { Module as NodeModule } from "node:module"
    export type { Module as LegacyModule } from "module"
    export type * from "node:module"
    type ModuleNamespace = typeof import("node:module")
  `,
  expected: 0,
  filePath: "packages/ai-codex/src/commonjs-safe.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    const Process = await import("node:process")
    const Module = Process.getBuiltinModule("module")
    const require = Module.createRequire(import.meta.url)
    const ChildProcess = require("effect/unstable/process/ChildProcess")
    const runtime = process
    runtime.getBuiltinModule("module")
  `,
  expected: 2,
  filePath: "packages/ai-codex/src/raw-process-invalid.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import type { Process } from "node:process"
    export type { Process as LegacyProcess } from "process"
    export type * from "node:process"
    const process = { getBuiltinModule: () => undefined }
    process.getBuiltinModule()
    type ProcessNamespace = typeof import("node:process")
  `,
  expected: 0,
  filePath: "packages/ai-codex/src/raw-process-safe.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) =>
      ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/tmp/packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

const aiCodexEslint = new ESLint({
  cwd: fileURLToPath(new URL("../packages/ai-codex/", import.meta.url))
})
const aiClaudeEslint = new ESLint({
  cwd: fileURLToPath(new URL("../packages/ai-claude/", import.meta.url))
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    export type { ChildProcess }
    const makeCommand = (options, arguments_) =>
      Object.freeze(ChildProcess.make("codex", Object.freeze([...arguments_]), Object.freeze({
        env: Object.freeze({ ...options.environment }),
        extendEnv: false
      })))
  `,
  eslintInstance: aiCodexEslint,
  expected: 0,
  filePath: "src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options, arguments_) =>
      Object.freeze(ChildProcess.make("codex", arguments_, Object.freeze({
        env: Object.freeze({ ...options.environment }),
        extendEnv: false
      })))
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { Stream } from "effect"
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options, arguments_) =>
      Object.freeze(ChildProcess.make("codex", Object.freeze([...arguments_]), Object.freeze({
        env: Object.freeze({ ...options.environment }),
        extendEnv: false,
        stdin: { stream: Stream.make(options.prompt).pipe(Stream.encodeText), endOnDone: true }
      })))
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      const command = Object.freeze(ChildProcess.make("codex", ["exec"], Object.freeze({
        env: Object.freeze({ ...options.environment }),
        extendEnv: false
      })))
      Object.assign(command.options, { extendEnv: true })
      Object.assign(command.options.env, unsafeEnvironment)
      return command
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      Object.assign(options["environ" + "ment"], unsafeEnvironment)
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      Object.assign(options[environmentKey], unsafeEnvironment)
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) =>
      ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false,
        ["stdout"]: "pipe"
      })
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      options.environment.SECRET = "leak"
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      Object.assign(options.environment, unsafeEnvironment)
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      const environment = options.environment
      Object.assign(environment, unsafeEnvironment)
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) =>
      ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
  `,
  eslintInstance: aiCodexEslint,
  expected: 1,
  filePath: "src/tmp/packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const makeCommand = (options, arguments_) =>
      Object.freeze(ChildProcess.make("claude", Object.freeze([...arguments_]), Object.freeze({
        env: Object.freeze({ ...options.environment }),
        extendEnv: false
      })))
  `,
  eslintInstance: aiClaudeEslint,
  expected: 0,
  filePath: "src/runner.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      options.environment = unsafeEnvironment
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false,
        [inheritanceKey]: true
      })
      ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false,
        [environmentKey]: unsafeEnvironment
      })
    }
  `,
  expected: 2,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const wrapper = () => {
      const makeCommand = (options) =>
        ChildProcess.make("codex", ["exec"], {
          env: options.environment,
          extendEnv: false
        })
      return makeCommand
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      options = unsafeOptions
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      ChildProcess.make("codex", ["exec"], {
        metadata: { env: options.environment, extendEnv: false }
      })
      const makeIndirectly = ChildProcess.make
      makeIndirectly("codex", ["exec"], dynamicOptions)
      ChildProcess.make.call(undefined, "codex", ["exec"], dynamicOptions)
    }
    function shadowed(options) {
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 4,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options, arguments_) =>
      Object.freeze(ChildProcess.make("codex", Object.freeze([...arguments_]), Object.freeze({
        env: Object.freeze({ ...options.environment } as typeof options.environment),
        extendEnv: false,
        stdout: "pipe"
      })))
    const localHelper = import("./known-local-helper.js")
  `,
  expected: 0,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
    const makeCommand = (options, arguments_) =>
      Object.freeze(ChildProcess.make("claude", Object.freeze([...arguments_]), Object.freeze({
        extendEnv: false,
        env: Object.freeze({ ...options.environment })
      })))
  `,
  expected: 0,
  filePath: "packages/ai-claude/src/runner.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    export type { Command } from "effect/unstable/process/ChildProcess"
    export type * from "effect/unstable/process/ChildProcess"
    export { ChildProcessSpawner } from "effect/unstable/process"
    import type { Module } from "node:module"
  `,
  expected: 0,
  filePath: "packages/ai-codex/src/type-exports.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    import * as Result from "effect/Result"
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      assert.strictEqual(result.failure.operation, "read-manifest")
    }
  `,
  expected: 1,
  filePath: "packages/control-center/test/eslint-result-tag-invalid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { expect } from "@effect/vitest"
    import * as Result from "effect/Result"
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      expect(result.failure.operation).toBe("read-manifest")
    }
  `,
  expected: 1,
  filePath: "packages/control-center/test/eslint-result-tag-expect-invalid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import * as Vitest from "vitest"
    import { Result } from "effect"
    if (Result.isFailure(result)) {
      Vitest.expect(result.failure._tag).toBe("BackupStorageError")
    }
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      Vitest.expect(result.failure.operation).toEqual("read-manifest")
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-expect-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import * as Result from "effect/Result"
    const expect = (value) => ({ toBe: () => value })
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      expect(result.failure.operation).toBe("read-manifest")
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-local-expect-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { expect } from "@effect/vitest"
    import * as Result from "effect/Result"
    const assert = { strictEqual: () => undefined }
    assert.strictEqual(result.failure._tag, "BackupStorageError")
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      expect(result.failure.operation).toBe("read-manifest")
    }
  `,
  expected: 1,
  filePath: "packages/control-center/test/eslint-result-tag-local-assert-invalid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import * as Result from "effect/Result"
    const assert = { strictEqual: () => undefined }
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      assert.strictEqual(result.failure.operation, "read-manifest")
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-local-assert-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { assert as verify } from "@effect/vitest"
    import * as Result from "effect/Result"
    verify.strictEqual(result.failure._tag, "BackupStorageError")
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      verify.strictEqual(result.failure.operation, "read-manifest")
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-aliased-assert-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    import * as Result from "effect/Result"
    assert.notStrictEqual(result.failure._tag, "BackupStorageError")
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      assert.strictEqual(result.failure.operation, "read-manifest")
    }
  `,
  expected: 1,
  filePath: "packages/control-center/test/eslint-result-tag-negative-assert-invalid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    import * as Result from "effect/Result"
    assert(result.failure._tag, "BackupStorageError")
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      assert.strictEqual(result.failure.operation, "read-manifest")
    }
  `,
  expected: 1,
  filePath: "packages/control-center/test/eslint-result-tag-direct-assert-invalid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    import * as Result from "effect/Result"
    assert.strictEqual(strictResult.failure._tag, "BackupStorageError")
    if (Result.isFailure(strictResult) && strictResult.failure._tag === "BackupStorageError") {
      assert.strictEqual(strictResult.failure.operation, "read-manifest")
    }
    assert.equal(equalResult.failure._tag, "BackupStorageError")
    if (Result.isFailure(equalResult) && equalResult.failure._tag === "BackupStorageError") {
      assert.equal(equalResult.failure.operation, "read-manifest")
    }
    assert.deepEqual(deepResult.failure._tag, "BackupStorageError")
    if (Result.isFailure(deepResult) && deepResult.failure._tag === "BackupStorageError") {
      assert.deepEqual(deepResult.failure.operation, "read-manifest")
    }
    assert.deepStrictEqual(deepStrictResult.failure._tag, "BackupStorageError")
    if (Result.isFailure(deepStrictResult) && deepStrictResult.failure._tag === "BackupStorageError") {
      assert.deepStrictEqual(deepStrictResult.failure.operation, "read-manifest")
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-assert-equality-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import * as Vitest from "vitest"
    import * as Result from "effect/Result"
    Vitest.assert.strictEqual(result.failure._tag, "BackupStorageError")
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      Vitest.assert.strictEqual(result.failure.operation, "read-manifest")
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-namespaced-assert-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    import { Result } from "effect"
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) {
      assert.strictEqual(result.failure._tag, "BackupStorageError")
    }
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      assert.strictEqual(result.failure.operation, "read-manifest")
    }
    if (
      Result.isFailure(other) &&
      (other.failure._tag === "BackupInputError" || other.failure._tag === "BackupStorageError")
    ) {
      assert.include(["BackupInputError", "BackupStorageError"], other.failure._tag)
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `export const layerFactory = () => ({ service: "auth" })`,
  expected: 1,
  filePath: "packages/control-center/src/server/auth/Auth.ts",
  ruleId: "@typescript-eslint/explicit-module-boundary-types"
})

await assertRuleDiagnostics({
  code: `export const layerFactory = () => ({ service: "application" })`,
  expected: 0,
  filePath: "packages/control-center/src/server/application/not-reviewed.ts",
  ruleId: "@typescript-eslint/explicit-module-boundary-types"
})

await assertRuleDiagnostics({
  code: `
    import * as Effect from "effect/Effect"
    import { Auth } from "../auth/Auth.js"
    import { CurrentSession } from "../../api/session.js"
    import { PluginAdministration } from "./ApplicationServices.js"
    import { FutureStableService } from "./FutureService.js"
    import * as Services from "./FutureServices.js"
    const AliasedStableService = FutureStableService
    handlers
      .handle("first", () => Effect.gen(function*() {
        const auth = yield* Auth
        const session = yield* CurrentSession
        return { auth, session }
      }))
      .handle("second", function() {
        return Effect.gen(function*() {
          return yield* PluginAdministration
        })
      })
      .handle("future", () => Effect.gen(function*() {
        return yield* FutureStableService
      }))
      .handle("namespace", () => Effect.gen(function*() {
        return yield* Services.FutureStableService
      }))
      .handle("alias", () => Effect.gen(function*() {
        return yield* AliasedStableService
      }))
  `,
  expected: 5,
  filePath: "packages/control-center/src/server/api/Handlers.ts",
  ruleId: "local-rules/no-stable-service-yield-in-http-handler"
})

await assertRuleDiagnostics({
  code: `
    import * as Effect from "effect/Effect"
    import { Auth } from "../auth/Auth.js"
    import { CurrentSession as RequestSession } from "../../api/session.js"
    import * as SessionServices from "../../api/session.js"
    import { PluginAdministration } from "./ApplicationServices.js"
    const AliasedRequestSession = RequestSession
    Effect.gen(function*() {
      const auth = yield* Auth
      const plugins = yield* PluginAdministration
      return handlers.handle("first", () => Effect.gen(function*() {
        const session = yield* RequestSession
        const aliasedSession = yield* AliasedRequestSession
        const namespaceSession = yield* SessionServices.CurrentSession
        return { aliasedSession, auth, namespaceSession, plugins, session }
      }))
    })
  `,
  expected: 0,
  filePath: "packages/control-center/src/server/api/Handlers.ts",
  ruleId: "local-rules/no-stable-service-yield-in-http-handler"
})

await assertRuleDiagnostics({
  code: `
    import * as CanonicalSchemas from "./canonical-wire.js"
    export { type NumberFromString } from "effect/Schema"
    export type { NumberFromString as NumberFromStringType } from "effect/Schema"
    CanonicalSchemas.NumberFromString
  `,
  expected: 0,
  filePath: "packages/control-center/src/api/eslint-number-from-string-valid.ts",
  ruleId: "local-rules/no-number-from-string-in-control-center-api"
})

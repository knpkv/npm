/**
 * Behavioral tests for profile-scoped child environments.
 *
 * These spawn a real child process rather than asserting on the options object,
 * because the invariant depends on two mechanisms the type system cannot show:
 *
 * 1. `extendEnv: true` must still deliver the inherited `PATH`, otherwise every
 *    PATH-resolved executable fails with `NotFound: ChildProcess.spawn (...)`.
 * 2. Mapping a variable to `undefined` must *remove* it from the child rather
 *    than pass the string `"undefined"`. A stringified value would look like a
 *    valid credential to the AWS chain and still outrank `AWS_PROFILE`.
 *
 * Asserting on a mock would confirm neither.
 *
 * Mechanism 2 is runtime-specific, and this CLI ships on both Node and Bun — the
 * TUI's `assume` path runs under Bun. The clearing cases therefore run against
 * each available runtime. Bun is not installed in CI, so its case reports as
 * skipped there rather than passing vacuously; that skip is visible in the
 * runner output instead of being hidden inside a conditional assertion.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { fileURLToPath } from "node:url"
import { afterEach, vi } from "vitest"
import * as ChildEnv from "../src/ChildEnv.js"

const decodeEnvironment = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
)

/**
 * Reads the child's own environment back as JSON, under the given runtime.
 *
 * `-e` with an explicit stdout write is used rather than `-p` because it behaves
 * identically on both runtimes.
 */
const childEnvironmentUnder = (runtime: string) => (env: Record<string, string | undefined>) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const output = yield* spawner.string(
      ChildProcess.make(runtime, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
        env,
        extendEnv: true
      })
    )
    return yield* decodeEnvironment(output)
  })

const childEnvironment = childEnvironmentUnder("node")

/**
 * Resolved from this module rather than the working directory.
 *
 * `fileURLToPath` rather than `.pathname`, which leaves percent-escapes in place
 * and would break on a checkout path containing a space.
 */
const BUN_FIXTURE = fileURLToPath(new URL("./fixtures/bunChildEnv.ts", import.meta.url))

/**
 * Resolved at collection time so the Bun case can be genuinely skipped rather
 * than degrading into a test that asserts nothing.
 */
const bunAvailable = await Effect.runPromise(
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) => spawner.exitCode(ChildProcess.make("bun", ["--version"]))),
    Effect.map((code) => code === 0),
    Effect.catchIf(() => true, () => Effect.succeed(false)),
    Effect.scoped,
    Effect.provide(NodeServices.layer)
  )
)

describe("ChildEnv.profileScopedEnv", () => {
  // Registered as a hook rather than trailing each test: a thrown assertion or
  // spawn error would skip success-path cleanup and leak the stubbed ambient
  // credentials into later cases, which assert on those variables being absent.
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.effect("drops ambient static credentials that would outrank the requested profile", () =>
    Effect.gen(function*() {
      vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAAMBIENTEXAMPLE")
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret")
      vi.stubEnv("AWS_SESSION_TOKEN", "ambient-token")
      vi.stubEnv("AWS_SECURITY_TOKEN", "ambient-legacy-token")
      vi.stubEnv("AWS_CREDENTIAL_EXPIRATION", "2030-01-01T00:00:00Z")

      const env = yield* childEnvironment(
        ChildEnv.profileScopedEnv({ AWS_PROFILE: "target-profile", AWS_DEFAULT_REGION: "eu-central-1" })
      )

      // Absent, not the literal string "undefined" — the AWS chain would accept that.
      assert.isFalse("AWS_ACCESS_KEY_ID" in env)
      assert.isFalse("AWS_SECRET_ACCESS_KEY" in env)
      assert.isFalse("AWS_SESSION_TOKEN" in env)
      assert.isFalse("AWS_SECURITY_TOKEN" in env)
      assert.isFalse("AWS_CREDENTIAL_EXPIRATION" in env)

      assert.strictEqual(env.AWS_PROFILE, "target-profile")
      assert.strictEqual(env.AWS_DEFAULT_REGION, "eu-central-1")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("drops the ambient web-identity provider, not just static credentials", () =>
    Effect.gen(function*() {
      // AWS_ROLE_ARN plus AWS_WEB_IDENTITY_TOKEN_FILE activate a second
      // environment credential provider that also outranks the profile.
      vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::111122223333:role/ambient-web-identity")
      vi.stubEnv("AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/secrets/ambient-token")
      vi.stubEnv("AWS_ROLE_SESSION_NAME", "ambient-session")

      const env = yield* childEnvironment(
        ChildEnv.profileScopedEnv({ AWS_PROFILE: "target-profile", AWS_DEFAULT_REGION: "eu-central-1" })
      )

      assert.isFalse("AWS_ROLE_ARN" in env)
      assert.isFalse("AWS_WEB_IDENTITY_TOKEN_FILE" in env)
      assert.isFalse("AWS_ROLE_SESSION_NAME" in env)

      assert.strictEqual(env.AWS_PROFILE, "target-profile")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps the config-file locators the parent resolved the profile against", () =>
    Effect.gen(function*() {
      // These select *which* file the profile is read from and resolve below the
      // environment tier, so clearing them would break custom config locations.
      vi.stubEnv("AWS_CONFIG_FILE", "/custom/config")
      vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/custom/credentials")

      const env = yield* childEnvironment(ChildEnv.profileScopedEnv({ AWS_PROFILE: "target-profile" }))

      assert.strictEqual(env.AWS_CONFIG_FILE, "/custom/config")
      assert.strictEqual(env.AWS_SHARED_CREDENTIALS_FILE, "/custom/credentials")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("lets an explicitly requested region outrank both ambient region variables", () =>
    Effect.gen(function*() {
      vi.stubEnv("AWS_REGION", "us-west-1")
      vi.stubEnv("AWS_DEFAULT_REGION", "us-west-1")

      const env = yield* childEnvironment(
        ChildEnv.profileScopedEnv({
          AWS_PROFILE: "target-profile",
          AWS_DEFAULT_REGION: "eu-central-1",
          AWS_REGION: "eu-central-1"
        })
      )

      assert.strictEqual(env.AWS_REGION, "eu-central-1")
      assert.strictEqual(env.AWS_DEFAULT_REGION, "eu-central-1")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("clears both region variables when the caller requests none", () =>
    Effect.gen(function*() {
      // The `assume` spawns pass no region, so the profile's configured region
      // must win. Clearing only one of the two would leave the outcome dependent
      // on which variable the caller's shell happens to export.
      vi.stubEnv("AWS_REGION", "us-west-1")
      vi.stubEnv("AWS_DEFAULT_REGION", "us-west-1")

      const env = yield* childEnvironment(
        ChildEnv.profileScopedEnv({ GRANTED_ALIAS_CONFIGURED: "true" })
      )

      assert.isFalse("AWS_REGION" in env)
      assert.isFalse("AWS_DEFAULT_REGION" in env)
    }).pipe(Effect.provide(NodeServices.layer)))

  // Bun is the runtime behind the TUI's `assume` path. Spawning `bun` from this
  // Node-hosted suite would only prove that Node's spawner clears the variables
  // before handing them to a Bun child. The fixture runs the spawner under Bun
  // itself, against Bun's own `node:child_process` reimplementation, and reports
  // its grandchild's environment. If Bun passed the string "undefined" instead of
  // dropping the variable, every other case here would still pass while the
  // shipped binary leaked.
  it.effect.skipIf(!bunAvailable)(
    "clears the same variables with the spawner hosted on Bun",
    () =>
      Effect.gen(function*() {
        vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAAMBIENTEXAMPLE")
        vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret")
        vi.stubEnv("AWS_SESSION_TOKEN", "ambient-token")
        vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::111122223333:role/ambient-web-identity")
        vi.stubEnv("AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/secrets/ambient-token")
        vi.stubEnv("AWS_REGION", "us-west-1")
        vi.stubEnv("AWS_DEFAULT_REGION", "us-west-1")

        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const output = yield* spawner.string(
          ChildProcess.make("bun", [BUN_FIXTURE], { extendEnv: true })
        )
        const env = yield* decodeEnvironment(output)

        assert.isFalse("AWS_ACCESS_KEY_ID" in env)
        assert.isFalse("AWS_SECRET_ACCESS_KEY" in env)
        assert.isFalse("AWS_SESSION_TOKEN" in env)
        assert.isFalse("AWS_ROLE_ARN" in env)
        assert.isFalse("AWS_WEB_IDENTITY_TOKEN_FILE" in env)
        assert.isFalse("AWS_REGION" in env)
        assert.isFalse("AWS_DEFAULT_REGION" in env)

        assert.strictEqual(env.AWS_PROFILE, "target-profile")
        assert.isTrue((env.PATH ?? "").length > 0)
        assert.isTrue("HOME" in env)
      }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("preserves the inherited PATH so the executable still resolves", () =>
    Effect.gen(function*() {
      const env = yield* childEnvironment(
        ChildEnv.profileScopedEnv({ GRANTED_ALIAS_CONFIGURED: "true" })
      )

      assert.isTrue((env.PATH ?? "").length > 0)
      assert.strictEqual(env.GRANTED_ALIAS_CONFIGURED, "true")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps non-AWS host variables the child may rely on", () =>
    Effect.gen(function*() {
      const env = yield* childEnvironment(ChildEnv.profileScopedEnv({ AWS_PROFILE: "target-profile" }))

      // `git` and `aws` read HOME to locate ~/.gitconfig and ~/.aws.
      assert.isTrue("HOME" in env)
    }).pipe(Effect.provide(NodeServices.layer)))
})

import assert from "node:assert/strict"
import test, { after } from "node:test"
import { fileURLToPath, URL } from "node:url"

import { NodeServices } from "@effect/platform-node"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Stream from "effect/Stream"
import { parseDocument } from "yaml"

const runtime = ManagedRuntime.make(NodeServices.layer)
after(() => runtime.dispose())

const actionText = await runtime.runPromise(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    return yield* fileSystem.readFileString(
      fileURLToPath(new URL("../.github/actions/setup/action.yaml", import.meta.url))
    )
  })
)
const install = parseDocument(actionText)
  .toJS()
  .runs.steps.find((step) => step.name === "Install dependencies")

// Stand-ins for Socket Firewall and pnpm. `sfw` logs its call and runs its arguments; a scenario's `sfw-results`
// lines decide whether that call fails (the firewall refusing). `pnpm install --offline` is the completeness check:
// its `offline-results` lines decide each answer, one line per call, the way a partial node_modules fails it.
const fakes = {
  sfw: `#!/usr/bin/env bash
echo sfw >> "$FAKE_LOG"
code=$(sed -n "$(grep -c sfw "$FAKE_LOG")p" "$FAKE_DIR/sfw-results")
[ "\${code:-0}" = 0 ] || exit "$code"
exec "$@"
`,
  pnpm: `#!/usr/bin/env bash
case " $* " in
  *" --offline "*)
    echo offline >> "$FAKE_LOG"
    exit "$(sed -n "$(grep -c offline "$FAKE_LOG")p" "$FAKE_DIR/offline-results")" ;;
  *) echo install >> "$FAKE_LOG" ;;
esac
`
}

/** Runs the step's script the way a composite `shell: bash` step does, with the fakes first on PATH. */
const runInstall = (scenario) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "setup-action-" })
      for (const [name, body] of Object.entries(fakes)) {
        yield* fileSystem.writeFileString(path.join(dir, name), body)
        yield* fileSystem.chmod(path.join(dir, name), 0o755)
      }
      yield* fileSystem.writeFileString(path.join(dir, "sfw-results"), (scenario.sfw ?? []).join("\n") + "\n")
      yield* fileSystem.writeFileString(path.join(dir, "offline-results"), scenario.offline.join("\n") + "\n")
      const log = path.join(dir, "log")
      yield* fileSystem.writeFileString(log, "")
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const inheritedPath = yield* Config.String("PATH")
      const handle = yield* spawner.spawn(
        ChildProcess.make("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", install.run], {
          cwd: dir,
          env: { PATH: `${dir}:${inheritedPath}`, FAKE_DIR: dir, FAKE_LOG: log },
          extendEnv: true
        })
      )
      const [stdout, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: "unbounded" }
      )
      const calls = (yield* fileSystem.readFileString(log)).split("\n").filter((line) => line.length > 0)
      return { calls, exitCode, stdout }
    }).pipe(Effect.scoped)
  )

test("the install step runs through Socket Firewall and checks the result offline", () => {
  assert.equal(install.shell, "bash")
  assert.match(install.run, /sfw pnpm install --frozen-lockfile/u)
  assert.match(install.run, /pnpm install --frozen-lockfile --offline/u)
})

test("a complete install passes on the first attempt", async () => {
  const result = await runInstall({ offline: [0] })
  assert.equal(result.exitCode, ChildProcessSpawner.ExitCode(0))
  assert.deepEqual(result.calls, ["sfw", "install", "offline"])
})

// Socket Firewall can crash mid-install ("TypeError: fetch failed") and still exit 0, leaving a partial
// node_modules; later steps then fail as `Command "playwright" not found`.
test("an install the firewall cut short is retried, then passes", async () => {
  const result = await runInstall({ offline: [1, 0] })
  assert.equal(result.exitCode, ChildProcessSpawner.ExitCode(0))
  assert.deepEqual(result.calls, ["sfw", "install", "offline", "sfw", "install", "offline"])
  assert.match(result.stdout, /::warning title=Dependency install incomplete::/u)
})

test("an install that stays incomplete fails the step after three attempts", async () => {
  const result = await runInstall({ offline: [1, 1, 1] })
  assert.equal(result.exitCode, ChildProcessSpawner.ExitCode(1))
  assert.equal(result.calls.filter((call) => call === "sfw").length, 3)
  assert.match(result.stdout, /::error title=Dependency install failed::/u)
})

// The firewall refusing a package is not a flake: it fails the same way three times and the step fails.
test("a firewall refusal fails the step without a completeness check passing it", async () => {
  const result = await runInstall({ sfw: [1, 1, 1], offline: [] })
  assert.equal(result.exitCode, ChildProcessSpawner.ExitCode(1))
  assert.deepEqual(result.calls, ["sfw", "sfw", "sfw"])
})

import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import type { FileSystem as FileSystemType } from "effect"
import { Deferred, Effect, Fiber, FileSystem, Path, Ref, Result, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { createServer } from "node:net"

import {
  decodeControlCenterDataPaths,
  prepareControlCenterDataRoot,
  resolvePreparedControlCenterDataRoot
} from "../../src/server/cliConfiguration.js"
import { createOfflineVerifiedBackup, restoreBackup, verifyBackup } from "../../src/server/persistence/backup/index.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { CURRENT_SCHEMA_VERSION } from "../../src/server/persistence/schema.js"

interface RegularFileSnapshot {
  readonly bytes: Uint8Array
  readonly metadata: Omit<FileSystemType.File.Info, "atime">
  readonly name: string
}

const stableFileMetadata = (info: FileSystemType.File.Info): Omit<FileSystemType.File.Info, "atime"> => ({
  // Reading the comparison bytes necessarily advances atime on strict-atime filesystems.
  birthtime: info.birthtime,
  blksize: info.blksize,
  blocks: info.blocks,
  dev: info.dev,
  gid: info.gid,
  ino: info.ino,
  mode: info.mode,
  mtime: info.mtime,
  nlink: info.nlink,
  rdev: info.rdev,
  size: info.size,
  type: info.type,
  uid: info.uid
})

const snapshotRegularFiles = Effect.fn("OfflineBackupTest.snapshotRegularFiles")(function*(
  fileSystem: FileSystemType.FileSystem,
  path: Path.Path,
  root: string,
  names: ReadonlyArray<string>
) {
  const snapshots: Array<RegularFileSnapshot> = []
  for (const name of [...names].sort()) {
    const filePath = path.join(root, name)
    const info = yield* fileSystem.stat(filePath)
    assert.strictEqual(info.type, "File")
    const bytes = yield* fileSystem.readFile(filePath)
    snapshots.push({ bytes, metadata: stableFileMetadata(yield* fileSystem.stat(filePath)), name })
  }
  return snapshots
})

const leaveHotRollbackJournal = Effect.fn("OfflineBackupTest.leaveHotRollbackJournal")(function*(
  databaseFile: string
) {
  const fileSystem = yield* FileSystem.FileSystem
  const databaseSizeBefore = Number((yield* fileSystem.stat(databaseFile)).size)
  const fixtureScript = `
    import { DatabaseSync } from "node:sqlite"
    import { argv } from "node:process"

    let database = new DatabaseSync(argv[1])
    database.exec(\`
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      BEGIN IMMEDIATE;
      INSERT INTO workspaces(
        workspace_id, display_name, revision, created_at, updated_at
      ) VALUES (
        'crash-recovery-probe', 'committed', 1,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      COMMIT;
    \`)
    database.close()
    database = new DatabaseSync(argv[1])
    database.exec(\`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      PRAGMA cache_size=1;
      BEGIN IMMEDIATE;
      UPDATE workspaces
      SET display_name = 'uncommitted', updated_at = '2026-01-02T00:00:00.000Z'
      WHERE workspace_id = 'crash-recovery-probe';
      CREATE TABLE crash_recovery_spill(id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
      WITH RECURSIVE rows(id) AS (
        VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < 512
      )
      INSERT INTO crash_recovery_spill(id, payload) SELECT id, randomblob(4096) FROM rows;
    \`)
    console.log("READY")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  `
  const handle = yield* ChildProcess.make(
    "node",
    ["--no-warnings", "--input-type=module", "--eval", fixtureScript, databaseFile]
  )
  const stderrFiber = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runFold(() => "", (output, chunk) => output + chunk),
    Effect.forkScoped
  )
  const readyOutput = yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.takeUntil((chunk) => chunk.includes("READY")),
    Stream.runFold(() => "", (output, chunk) => output + chunk)
  )
  if (!readyOutput.includes("READY")) {
    yield* handle.exitCode
    const stderr = yield* Fiber.join(stderrFiber)
    return yield* Effect.fail(`node:sqlite crash fixture exited before readiness: ${stderr.trim()}`)
  }
  const journalFile = `${databaseFile}-journal`
  const databaseInfo = yield* fileSystem.stat(databaseFile)
  assert.isAbove(Number(databaseInfo.size), databaseSizeBefore + 1_000_000)
  yield* fileSystem.stat(journalFile)
  yield* handle.kill({ killSignal: "SIGKILL" })
  yield* handle.exitCode.pipe(Effect.result)
  assert.strictEqual((yield* Fiber.join(stderrFiber)).trim(), "")
  return journalFile
})

const readCrashRecoveryProbe = Effect.fn("OfflineBackupTest.readCrashRecoveryProbe")(function*(
  databaseFile: string
) {
  const queryScript = `
    import { DatabaseSync } from "node:sqlite"
    import { argv } from "node:process"

    const database = new DatabaseSync(argv[1], { readOnly: true })
    const row = database.prepare(\`
      SELECT display_name AS value
      FROM workspaces
      WHERE workspace_id = 'crash-recovery-probe'
    \`).get()
    console.log(row.value)
  `
  const handle = yield* ChildProcess.make(
    "node",
    ["--no-warnings", "--input-type=module", "--eval", queryScript, databaseFile]
  )
  const [stdout, stderr, exitCode] = yield* Effect.all([
    handle.stdout.pipe(Stream.decodeText(), Stream.runFold(() => "", (output, chunk) => output + chunk)),
    handle.stderr.pipe(Stream.decodeText(), Stream.runFold(() => "", (output, chunk) => output + chunk)),
    handle.exitCode
  ], { concurrency: "unbounded" })
  assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0), stderr)
  return stdout.trim()
})

const makePreparedRoot = Effect.fn("OfflineBackupTest.makePreparedRoot")(function*(prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix })
  const configuredRoot = path.join(parent, "data")
  const configured = yield* decodeControlCenterDataPaths(configuredRoot)
  const prepared = yield* prepareControlCenterDataRoot(configured)
  yield* Effect.gen(function*() {
    const database = yield* Database
    yield* database.validateSchema
  }).pipe(Effect.provide(databaseLayer(prepared.persistenceConfig)), Effect.scoped)
  return { configured, configuredRoot, parent, prepared }
})

const inactiveTelemetryEnvironment = {
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  OTEL_LOGS_EXPORTER: "none",
  OTEL_SDK_DISABLED: "false",
  OTEL_TRACES_EXPORTER: "none"
}

const runBuiltCli = Effect.fn("OfflineBackupTest.runBuiltCli")(function*(
  cliEntry: string,
  args: ReadonlyArray<string>,
  configuredDataRoot: string,
  port?: number,
  extraEnvironment: Readonly<Record<string, string>> = {}
) {
  const handle = yield* ChildProcess.make("node", [cliEntry, ...args], {
    env: {
      ...inactiveTelemetryEnvironment,
      ...extraEnvironment,
      CONTROL_CENTER_DATA_ROOT: configuredDataRoot,
      ...(port === undefined ? {} : { CONTROL_CENTER_PORT: String(port) })
    },
    extendEnv: true
  })
  const [stdout, stderr, exitCode] = yield* Effect.all([
    handle.stdout.pipe(
      Stream.decodeText(),
      Stream.runFold(() => "", (output, chunk) => output + chunk)
    ),
    handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runFold(() => "", (output, chunk) => output + chunk)
    ),
    handle.exitCode
  ], { concurrency: "unbounded" })
  return { exitCode, stderr, stdout }
})

const removeProviderOwnershipTables = Effect.fn(
  "OfflineBackupTest.removeProviderOwnershipTables"
)(function*(databaseFile: string) {
  const fixtureScript = `
    import { DatabaseSync } from "node:sqlite"
    import { argv } from "node:process"

    const database = new DatabaseSync(argv[1])
    database.exec(\`
      PRAGMA foreign_keys=OFF;
      DROP TABLE followed_resources;
      DROP TABLE provider_accounts;
    \`)
    database.close()
  `
  const handle = yield* ChildProcess.make(
    "node",
    ["--no-warnings", "--input-type=module", "--eval", fixtureScript, databaseFile]
  )
  const [stdout, stderr, exitCode] = yield* Effect.all([
    handle.stdout.pipe(
      Stream.decodeText(),
      Stream.runFold(() => "", (output, chunk) => output + chunk)
    ),
    handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runFold(() => "", (output, chunk) => output + chunk)
    ),
    handle.exitCode
  ], { concurrency: "unbounded" })
  assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0), stderr)
  assert.strictEqual(stdout, "")
})

const acquireEphemeralPort = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolve, reject) => {
      const probe = createServer()
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address()
        if (address === null || typeof address === "string") {
          probe.close()
          reject(new Error("ephemeral listener did not expose an internet port"))
          return
        }
        probe.close((error) => error === undefined ? resolve(address.port) : reject(error))
      })
    }),
  catch: (cause) => new Error("could not reserve an ephemeral test port", { cause })
})

describe("offline backup commands", () => {
  it.effect("resolves an already-prepared root without changing its claim or marker", () =>
    Effect.gen(function*() {
      const { configured, configuredRoot, prepared } = yield* makePreparedRoot(
        "control-center-offline-resolve-"
      )
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const claimBefore = yield* fileSystem.readLink(configuredRoot)
      const markerPath = path.join(prepared.dataRoot, ".control-center-root")
      const markerBefore = yield* fileSystem.readFile(markerPath)
      const entriesBefore = (yield* fileSystem.readDirectory(prepared.dataRoot)).sort()

      const resolved = yield* resolvePreparedControlCenterDataRoot(configured)

      assert.strictEqual(resolved.dataRoot, prepared.dataRoot)
      assert.strictEqual(yield* fileSystem.readLink(configuredRoot), claimBefore)
      assert.deepStrictEqual(yield* fileSystem.readFile(markerPath), markerBefore)
      assert.deepStrictEqual((yield* fileSystem.readDirectory(prepared.dataRoot)).sort(), entriesBefore)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects missing, unprepared, and legacy roots without adopting or cleaning them", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-offline-reject-" })
      const missing = path.join(parent, "missing")
      const missingResult = yield* resolvePreparedControlCenterDataRoot(
        yield* decodeControlCenterDataPaths(missing)
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(missingResult))
      assert.isFalse(yield* fileSystem.exists(missing))

      const fixtures: ReadonlyArray<"unprepared" | "legacy-v1"> = ["unprepared", "legacy-v1"]
      for (const fixture of fixtures) {
        const root = path.join(parent, fixture)
        yield* fileSystem.makeDirectory(root, { mode: 0o700 })
        yield* fileSystem.writeFileString(path.join(root, "sentinel"), "preserve", { mode: 0o600 })
        if (fixture === "legacy-v1") {
          yield* fileSystem.writeFileString(
            path.join(root, ".control-center-root"),
            "@knpkv/control-center:data-root:v1\n",
            { mode: 0o600 }
          )
        }
        const before = (yield* fileSystem.readDirectory(root)).sort()
        const result = yield* resolvePreparedControlCenterDataRoot(
          yield* decodeControlCenterDataPaths(root)
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        assert.deepStrictEqual((yield* fileSystem.readDirectory(root)).sort(), before)
        assert.strictEqual(yield* fileSystem.readFileString(path.join(root, "sentinel")), "preserve")
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("creates, verifies, and restores an archive without the migrating database layer", () =>
    Effect.gen(function*() {
      const { configured, parent } = yield* makePreparedRoot("control-center-offline-roundtrip-")
      const path = yield* Path.Path
      const source = yield* resolvePreparedControlCenterDataRoot(configured)
      const archiveRoot = path.join(parent, "archive")

      const published = yield* createOfflineVerifiedBackup({
        destination: archiveRoot,
        persistenceConfig: source.persistenceConfig
      })
      const verified = yield* verifyBackup(archiveRoot)
      assert.strictEqual(published.verification._tag, "Complete")
      assert.strictEqual(verified._tag, "Complete")
      assert.strictEqual(verified.manifest.schemaVersion, CURRENT_SCHEMA_VERSION)

      const configuredDataRoot = path.join(parent, "restored")
      const restored = yield* restoreBackup({ archiveRoot, configuredDataRoot })
      assert.strictEqual(restored.configuredDataRoot, configuredDataRoot)
      assert.strictEqual(restored.verification._tag, "Complete")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("backs up a crash-recovery database without touching the stopped source", () =>
    Effect.gen(function*() {
      const { configured, configuredRoot, parent, prepared } = yield* makePreparedRoot(
        "control-center-offline-crash-recovery-"
      )
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const databaseFile = path.join(prepared.dataRoot, "control-center.db")
      const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "control-center-crash-fixture-"
      })
      const fixtureDatabase = path.join(fixtureRoot, "control-center.db")
      yield* fileSystem.copyFile(databaseFile, fixtureDatabase)
      for (const suffix of ["-wal", "-journal"]) {
        const sourceSidecar = `${databaseFile}${suffix}`
        if (yield* fileSystem.exists(sourceSidecar)) {
          yield* fileSystem.copyFile(sourceSidecar, `${fixtureDatabase}${suffix}`)
        }
      }
      const fixtureJournal = yield* leaveHotRollbackJournal(fixtureDatabase)
      assert.isFalse(yield* fileSystem.exists(`${fixtureDatabase}-wal`))
      const journalFile = `${databaseFile}-journal`
      yield* fileSystem.remove(databaseFile)
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        yield* fileSystem.remove(`${databaseFile}${suffix}`, { force: true })
      }
      yield* fileSystem.copyFile(fixtureDatabase, databaseFile)
      yield* fileSystem.copyFile(fixtureJournal, journalFile)
      yield* fileSystem.chmod(databaseFile, 0o600)
      yield* fileSystem.chmod(journalFile, 0o600)
      assert.isTrue(yield* fileSystem.exists(journalFile))

      const markerName = ".control-center-root"
      const sourceNames = (yield* fileSystem.readDirectory(prepared.dataRoot))
        .filter((name) => name === markerName || name.startsWith("control-center.db"))
        .sort()
      assert.include(sourceNames, "control-center.db")
      assert.include(sourceNames, "control-center.db-journal")
      const sourceBefore = yield* snapshotRegularFiles(
        fileSystem,
        path,
        prepared.dataRoot,
        sourceNames
      )
      const claimBefore = yield* fileSystem.readLink(configuredRoot)

      const source = yield* resolvePreparedControlCenterDataRoot(configured)
      const archiveRoot = path.join(parent, "archive")
      const published = yield* createOfflineVerifiedBackup({
        destination: archiveRoot,
        persistenceConfig: source.persistenceConfig
      })

      assert.strictEqual(published.verification._tag, "Complete")
      assert.strictEqual(
        yield* readCrashRecoveryProbe(path.join(archiveRoot, "control-center.db")),
        "committed"
      )
      assert.strictEqual(yield* fileSystem.readLink(configuredRoot), claimBefore)
      assert.deepStrictEqual(
        (yield* fileSystem.readDirectory(prepared.dataRoot))
          .filter((name) => name === markerName || name.startsWith("control-center.db"))
          .sort(),
        sourceNames
      )
      assert.deepStrictEqual(
        yield* snapshotRegularFiles(fileSystem, path, prepared.dataRoot, sourceNames),
        sourceBefore
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped), { timeout: 30_000 })

  it.effect("runs the built CLI backup, verify, and restore commands", () =>
    Effect.gen(function*() {
      const { configuredRoot, parent } = yield* makePreparedRoot("control-center-built-cli-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cliEntry = yield* path.fromFileUrl(
        new URL("../../dist/server/server/cli.js", import.meta.url)
      )
      assert.isTrue(
        yield* fileSystem.exists(cliEntry),
        "built CLI is missing; run pnpm --filter @knpkv/control-center build before this test"
      )

      const unsupported = yield* runBuiltCli(cliEntry, ["unsupported"], configuredRoot)
      assert.strictEqual(unsupported.exitCode, ChildProcessSpawner.ExitCode(1))
      assert.strictEqual(unsupported.stdout, "")
      assert.strictEqual(
        unsupported.stderr,
        "Usage: control-center [recover-owner | backup <archive> | verify-backup <archive> | restore <archive>]\n"
      )

      const missingArchive = yield* runBuiltCli(
        cliEntry,
        ["verify-backup", path.join(parent, "missing-archive")],
        configuredRoot
      )
      assert.strictEqual(missingArchive.exitCode, ChildProcessSpawner.ExitCode(1))
      assert.strictEqual(missingArchive.stdout, "")
      assert.strictEqual(
        missingArchive.stderr,
        "Control Center command failed (BackupInputError).\n"
      )

      const archiveRoot = path.join(parent, "archive")
      const backup = yield* runBuiltCli(cliEntry, ["backup", archiveRoot], configuredRoot)
      assert.strictEqual(backup.exitCode, ChildProcessSpawner.ExitCode(0))
      assert.strictEqual(backup.stdout, "Backup created.\n")
      assert.strictEqual(backup.stderr, "")

      const invalidDataRoot = path.join(parent, ".control-center-incoming-invalid")
      const verified = yield* runBuiltCli(
        cliEntry,
        ["verify-backup", archiveRoot],
        invalidDataRoot
      )
      assert.strictEqual(verified.exitCode, ChildProcessSpawner.ExitCode(0))
      assert.strictEqual(verified.stdout, "Backup verified.\n")
      assert.strictEqual(verified.stderr, "")
      assert.isFalse(yield* fileSystem.exists(invalidDataRoot))

      const restoredRoot = path.join(parent, "restored")
      const restored = yield* runBuiltCli(cliEntry, ["restore", archiveRoot], restoredRoot)
      assert.strictEqual(restored.exitCode, ChildProcessSpawner.ExitCode(0))
      assert.strictEqual(restored.stdout, "Backup restored.\n")
      assert.strictEqual(restored.stderr, "")
      const restoredTarget = path.join(parent, yield* fileSystem.readLink(restoredRoot))
      assert.isTrue(yield* fileSystem.exists(restoredRoot))
      assert.isTrue(yield* fileSystem.exists(path.join(restoredTarget, "control-center.db")))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped), { timeout: 60_000 })

  it.effect("starts the built CLI from a fresh data root and drains on SIGTERM", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-built-drain-" })
      const configuredRoot = path.join(parent, "data")
      const cliEntry = yield* path.fromFileUrl(
        new URL("../../dist/server/server/cli.js", import.meta.url)
      )
      assert.isTrue(
        yield* fileSystem.exists(cliEntry),
        "built CLI is missing; run pnpm --filter @knpkv/control-center build before this test"
      )
      const port = yield* acquireEphemeralPort
      const handle = yield* ChildProcess.make("node", [cliEntry], {
        env: {
          ...inactiveTelemetryEnvironment,
          CONTROL_CENTER_DATA_ROOT: configuredRoot,
          CONTROL_CENTER_PORT: String(port)
        },
        extendEnv: true
      })
      const stdout = yield* Ref.make("")
      const stderr = yield* Ref.make("")
      const listening = yield* Deferred.make<void>()
      const stdoutFiber = yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.updateAndGet(stdout, (current) => current + chunk).pipe(
            Effect.flatMap((current) =>
              current.includes("Control Center listening at")
                ? Deferred.succeed(listening, undefined)
                : Effect.void
            )
          )
        ),
        Effect.forkScoped
      )
      const stderrFiber = yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderr, (current) => current + chunk)),
        Effect.forkScoped
      )

      yield* Deferred.await(listening).pipe(Effect.timeout("15 seconds"))
      yield* handle.kill({ killSignal: "SIGTERM" })
      const exitCode = yield* handle.exitCode
      yield* Fiber.join(stdoutFiber)
      yield* Fiber.join(stderrFiber)

      const output = yield* Ref.get(stdout)
      assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(130), yield* Ref.get(stderr))
      assert.include(output, `Control Center listening at http://127.0.0.1:${port}\n`)
      assert.include(output, "Pairing code: ")
      assert.include(output, "Control Center draining.\n")
      assert.include(output, "Control Center drained.\n")
      assert.strictEqual(yield* Ref.get(stderr), "")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped), { timeout: 30_000 })

  it.effect(
    "flushes OTLP before reporting the server drained",
    () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-built-otel-drain-" })
        const configuredRoot = path.join(parent, "data")
        const flushSentinel = path.join(parent, "collector-flush-complete")
        const cliEntry = yield* path.fromFileUrl(
          new URL("../../dist/server/server/cli.js", import.meta.url)
        )
        assert.isTrue(
          yield* fileSystem.exists(cliEntry),
          "built CLI is missing; run pnpm --filter @knpkv/control-center build before this test"
        )

        const collectorPort = yield* acquireEphemeralPort
        const collectorScript = `
          import { writeFileSync } from "node:fs"
          import { createServer } from "node:http"
          import { argv } from "node:process"

          const server = createServer((request, response) => {
            request.resume()
            request.on("end", () => {
              console.log("REQUEST_RECEIVED")
              setTimeout(() => {
                writeFileSync(argv[2], "flushed")
                response.writeHead(200, { "content-type": "application/json" })
                response.end("{}")
                console.log("RESPONSE_SENT")
              }, 250)
            })
          })
          server.listen(Number(argv[1]), "127.0.0.1", () => console.log("READY"))
        `
        const collector = yield* ChildProcess.make(
          "node",
          [
            "--no-warnings",
            "--input-type=module",
            "--eval",
            collectorScript,
            String(collectorPort),
            flushSentinel
          ]
        )
        yield* Effect.addFinalizer(() => collector.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore))
        const collectorOutput = yield* Ref.make("")
        const collectorError = yield* Ref.make("")
        const collectorReady = yield* Deferred.make<void>()
        const collectorStdoutFiber = yield* collector.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Ref.updateAndGet(collectorOutput, (current) => current + chunk).pipe(
              Effect.flatMap((current) =>
                current.includes("READY") ? Deferred.succeed(collectorReady, undefined) : Effect.void
              )
            )
          ),
          Effect.forkScoped
        )
        const collectorStderrFiber = yield* collector.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => Ref.update(collectorError, (current) => current + chunk)),
          Effect.forkScoped
        )
        yield* Deferred.await(collectorReady).pipe(Effect.timeout("5 seconds"))

        const serverPort = yield* acquireEphemeralPort
        const server = yield* ChildProcess.make("node", [cliEntry], {
          env: {
            ...inactiveTelemetryEnvironment,
            CONTROL_CENTER_DATA_ROOT: configuredRoot,
            CONTROL_CENTER_PORT: String(serverPort),
            OTEL_BSP_EXPORT_TIMEOUT: "1000",
            OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "512",
            OTEL_BSP_SCHEDULE_DELAY: "60000",
            OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${collectorPort}/v1/traces`,
            OTEL_TRACES_EXPORTER: "otlp"
          },
          extendEnv: true
        })
        yield* Effect.addFinalizer(() => server.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore))
        const stdout = yield* Ref.make("")
        const stderr = yield* Ref.make("")
        const listening = yield* Deferred.make<void>()
        const drained = yield* Deferred.make<void>()
        const drainedAfterFlush = yield* Ref.make<boolean | null>(null)
        const stdoutFiber = yield* server.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.gen(function*() {
              const current = yield* Ref.updateAndGet(stdout, (output) => output + chunk)
              if (current.includes("Control Center listening at")) {
                yield* Deferred.succeed(listening, undefined)
              }
              if (current.includes("Control Center drained.") && (yield* Ref.get(drainedAfterFlush)) === null) {
                yield* Ref.set(drainedAfterFlush, yield* fileSystem.exists(flushSentinel))
                yield* Deferred.succeed(drained, undefined)
              }
            })
          ),
          Effect.forkScoped
        )
        const stderrFiber = yield* server.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => Ref.update(stderr, (current) => current + chunk)),
          Effect.forkScoped
        )

        yield* Deferred.await(listening).pipe(Effect.timeout("15 seconds"))
        const request = yield* ChildProcess.make(
          "curl",
          [
            "--fail",
            "--max-time",
            "5",
            "--output",
            "/dev/null",
            "--silent",
            `http://127.0.0.1:${serverPort}`
          ]
        )
        const [requestError, requestExitCode] = yield* Effect.all([
          request.stderr.pipe(Stream.decodeText(), Stream.runFold(() => "", (output, chunk) => output + chunk)),
          request.exitCode
        ], { concurrency: "unbounded" })
        assert.strictEqual(requestExitCode, ChildProcessSpawner.ExitCode(0), requestError)
        assert.notInclude(yield* Ref.get(collectorOutput), "REQUEST_RECEIVED")

        const terminateFiber = yield* server.kill({ killSignal: "SIGTERM" }).pipe(Effect.forkChild)
        yield* Deferred.await(drained).pipe(Effect.timeout("5 seconds"))
        const exitCode = yield* server.exitCode
        yield* Fiber.join(terminateFiber)
        yield* Fiber.join(stdoutFiber)
        yield* Fiber.join(stderrFiber)

        yield* collector.kill({ killSignal: "SIGTERM" })
        yield* collector.exitCode.pipe(Effect.result)
        yield* Fiber.join(collectorStdoutFiber)
        yield* Fiber.join(collectorStderrFiber)
        const serverError = yield* Ref.get(stderr)
        const capturedCollectorOutput = yield* Ref.get(collectorOutput)

        assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(130), serverError)
        assert.strictEqual(yield* Ref.get(drainedAfterFlush), true)
        assert.include(capturedCollectorOutput, "REQUEST_RECEIVED")
        assert.include(capturedCollectorOutput, "RESPONSE_SENT")
        assert.strictEqual(serverError, "")
        assert.strictEqual(yield* Ref.get(collectorError), "")
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    { timeout: 30_000 }
  )

  it.effect(
    "keeps usage and offline backup commands independent from active OTLP configuration",
    () =>
      Effect.gen(function*() {
        const { configured, configuredRoot, parent } = yield* makePreparedRoot(
          "control-center-built-otel-command-scope-"
        )
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cliEntry = yield* path.fromFileUrl(
          new URL("../../dist/server/server/cli.js", import.meta.url)
        )
        assert.isTrue(
          yield* fileSystem.exists(cliEntry),
          "built CLI is missing; run pnpm --filter @knpkv/control-center build before this test"
        )
        const source = yield* resolvePreparedControlCenterDataRoot(configured)
        const archiveRoot = path.join(parent, "archive")
        yield* createOfflineVerifiedBackup({
          destination: archiveRoot,
          persistenceConfig: source.persistenceConfig
        })
        const invalidActiveTelemetry = {
          OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
          OTEL_LOGS_EXPORTER: "otlp",
          OTEL_SDK_DISABLED: "false"
        }

        const verified = yield* runBuiltCli(
          cliEntry,
          ["verify-backup", archiveRoot],
          configuredRoot,
          undefined,
          invalidActiveTelemetry
        )
        assert.strictEqual(verified.exitCode, ChildProcessSpawner.ExitCode(0))
        assert.strictEqual(verified.stdout, "Backup verified.\n")
        assert.strictEqual(verified.stderr, "")

        const unsupported = yield* runBuiltCli(
          cliEntry,
          ["unsupported"],
          configuredRoot,
          undefined,
          invalidActiveTelemetry
        )
        assert.strictEqual(unsupported.exitCode, ChildProcessSpawner.ExitCode(1))
        assert.strictEqual(unsupported.stdout, "")
        assert.strictEqual(
          unsupported.stderr,
          "Usage: control-center [recover-owner | backup <archive> | verify-backup <archive> | restore <archive>]\n"
        )

        const server = yield* runBuiltCli(cliEntry, [], configuredRoot, undefined, invalidActiveTelemetry)
        assert.strictEqual(server.exitCode, ChildProcessSpawner.ExitCode(1))
        assert.strictEqual(server.stdout, "")
        assert.include(server.stderr, "Control Center command failed")
        assert.notInclude(server.stderr, "grpc")
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    { timeout: 30_000 }
  )

  it.effect(
    "reports active OTLP configuration failures without exposing configuration values",
    () =>
      Effect.gen(function*() {
        const { configuredRoot } = yield* makePreparedRoot("control-center-built-otel-failure-")
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cliEntry = yield* path.fromFileUrl(
          new URL("../../dist/server/server/cli.js", import.meta.url)
        )
        assert.isTrue(
          yield* fileSystem.exists(cliEntry),
          "built CLI is missing; run pnpm --filter @knpkv/control-center build before this test"
        )

        const result = yield* runBuiltCli(cliEntry, [], configuredRoot, undefined, {
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "not-a-url",
          OTEL_LOGS_EXPORTER: "otlp",
          OTEL_SDK_DISABLED: "false",
          OTEL_TRACES_EXPORTER: "none"
        })

        assert.strictEqual(result.exitCode, ChildProcessSpawner.ExitCode(1))
        assert.strictEqual(result.stdout, "")
        assert.include(result.stderr, "Control Center command failed")
        assert.notInclude(result.stderr, "not-a-url")
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    { timeout: 30_000 }
  )

  it.effect("explains pre-stable schema drift without recreating the database", () =>
    Effect.gen(function*() {
      const { configuredRoot, prepared } = yield* makePreparedRoot("control-center-built-schema-drift-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cliEntry = yield* path.fromFileUrl(
        new URL("../../dist/server/server/cli.js", import.meta.url)
      )
      assert.isTrue(
        yield* fileSystem.exists(cliEntry),
        "built CLI is missing; run pnpm --filter @knpkv/control-center build before this test"
      )
      yield* removeProviderOwnershipTables(path.join(prepared.dataRoot, "control-center.db"))
      const port = yield* acquireEphemeralPort

      const result = yield* runBuiltCli(cliEntry, [], configuredRoot, port)

      assert.strictEqual(result.exitCode, ChildProcessSpawner.ExitCode(1))
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "Control Center command failed (DatabaseInitializationError: verify-schema).\n" +
          "The database schema does not match this pre-stable build. Back up the data root if needed, " +
          "then explicitly recreate local development data or choose a new CONTROL_CENTER_DATA_ROOT. " +
          "Automatic migrations are disabled until schema stability.\n"
      )
      const verification = yield* runBuiltCli(cliEntry, [], configuredRoot, port)
      assert.strictEqual(verification.exitCode, ChildProcessSpawner.ExitCode(1))
      assert.strictEqual(verification.stderr, result.stderr)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped), { timeout: 30_000 })

  it.effect("fails before creating an archive when the configured database is absent", () =>
    Effect.gen(function*() {
      const { configured, parent, prepared } = yield* makePreparedRoot(
        "control-center-offline-missing-db-"
      )
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fileSystem.remove(path.join(prepared.dataRoot, "control-center.db"))
      const source = yield* resolvePreparedControlCenterDataRoot(configured)
      const archiveRoot = path.join(parent, "archive")

      const result = yield* createOfflineVerifiedBackup({
        destination: archiveRoot,
        persistenceConfig: source.persistenceConfig
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      assert.isFalse(yield* fileSystem.exists(archiveRoot))
      assert.isFalse(yield* fileSystem.exists(path.join(prepared.dataRoot, "control-center.db")))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("uses path segments when rejecting backup and restore overlap", () =>
    Effect.gen(function*() {
      const { configured, parent } = yield* makePreparedRoot("control-center-offline-overlap-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const source = yield* resolvePreparedControlCenterDataRoot(configured)
      for (const nestedName of ["nested-archive", "..archive"]) {
        const nestedArchive = path.join(source.dataRoot, nestedName)
        const result = yield* createOfflineVerifiedBackup({
          destination: nestedArchive,
          persistenceConfig: source.persistenceConfig
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure._tag, "BackupInputError")
          if (result.failure._tag === "BackupInputError") {
            assert.strictEqual(result.failure.reason, "overlap")
          }
        }
        assert.isFalse(yield* fileSystem.exists(nestedArchive))
      }

      const siblingArchive = path.join(parent, "..archive")
      const published = yield* createOfflineVerifiedBackup({
        destination: siblingArchive,
        persistenceConfig: source.persistenceConfig
      })
      assert.strictEqual(published.verification._tag, "Complete")

      const nestedRestore = path.join(siblingArchive, "..restored")
      const restored = yield* restoreBackup({
        archiveRoot: siblingArchive,
        configuredDataRoot: nestedRestore
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(restored))
      if (Result.isFailure(restored)) {
        assert.strictEqual(restored.failure._tag, "BackupInputError")
        if (restored.failure._tag === "BackupInputError") {
          assert.strictEqual(restored.failure.reason, "overlap")
        }
      }
      assert.isFalse(yield* fileSystem.exists(nestedRestore))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})

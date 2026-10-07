import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { agentConnectTarget, JobHash, JobRecord, JobStore } from "@knpkv/herdr-fleet"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startedWorker } from "../src/internal/started-worker.js"

const worker = { host: "SER8", agentId: "agent-7", name: "hc-work-7", paneId: "w1:p7" }

const openStore = (root: string) =>
  Effect.acquireRelease(JobStore.open(join(root, "jobs.sqlite")), (store) => Effect.sync(() => store.close()))

const baseRecord = (id: string) => ({
  acceptedReceipt: null,
  actor: "owner",
  approvalNonce: null,
  approvedBy: null,
  createdAt: 1_000,
  error: null,
  hash: Schema.decodeUnknownSync(JobHash)("a".repeat(64)),
  id,
  payload: { kind: "agent.delegate", mode: "work", prompt: "ship", repository: "/repo" },
  result: null,
  status: "running",
  updatedAt: 1_000
})

/** A running delegate job, with its started worker when `started`. */
const record = (id: string, started: boolean) =>
  Schema.decodeUnknownEffect(JobRecord)(
    started
      ? { ...baseRecord(id), worker, connectTarget: agentConnectTarget(worker) }
      : baseRecord(id)
  )

it.layer(NodeServices.layer)("startedWorker", (it) => {
  it.effect("answers the worker Fleet recorded for a job, and null for a job that started none or doesn't exist", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "herdr-started-worker-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const store = yield* openStore(root)
      yield* store.put(yield* record("job-started", true))
      yield* store.put(yield* record("job-waiting", false))
      expect(yield* startedWorker(store, "job-started")).toEqual(worker)
      expect(yield* startedWorker(store, "job-waiting")).toBeNull()
      expect(yield* startedWorker(store, "job-missing")).toBeNull()
    })))

  it.effect("fails when the store can't be read, rather than answering that no worker started", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "herdr-started-worker-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      // Opened outside the scope, so closing it here is its only close.
      const store = yield* JobStore.open(join(root, "jobs.sqlite"))
      yield* store.put(yield* record("job-started", true))
      store.close()
      const result = yield* Effect.flip(startedWorker(store, "job-started"))
      expect(result._tag).toBe("FleetStoreError")
    })))
})

import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { PushDeliveryError } from "../src/errors.js"
import type { PushSubscriptionRecord } from "../src/model.js"
import { runPushPass } from "../src/push-worker.js"
import { ApprovalAppStore } from "../src/store.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const subscription: PushSubscriptionRecord = {
  endpoint: "https://push.example.test/subscription-1",
  expirationTime: null,
  keys: { auth: "auth_key", p256dh: "p256dh_key" }
}

describe("push delivery retries", () => {
  it.effect("converges concurrent VAPID initialization on the persisted winner", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-vapid-race-test-"))
    const path = join(root, "approval.sqlite")
    const firstKeys = { privateKey: "first_private", publicKey: "first_public" }
    const secondKeys = { privateKey: "second_private", publicKey: "second_public" }
    return Effect.scoped(Effect.gen(function*() {
      const first = yield* Effect.acquireRelease(
        ApprovalAppStore.open(path),
        (store) => Effect.sync(() => store.close())
      )
      const second = yield* Effect.acquireRelease(
        ApprovalAppStore.open(path),
        (store) => Effect.sync(() => store.close())
      )
      const competing = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(path)),
        (database) => Effect.sync(() => database.close())
      )
      const firstResult = yield* first.getOrCreateVapidKeys(() => {
        competing.prepare(
          "INSERT INTO vapid_keys (id, record) VALUES (1, ?)"
        ).run(JSON.stringify(secondKeys))
        return firstKeys
      })
      expect(firstResult).toEqual(secondKeys)
      let secondGenerated = 0
      const secondResult = yield* second.getOrCreateVapidKeys(() => {
        secondGenerated += 1
        return firstKeys
      })
      expect(secondResult).toEqual(secondKeys)
      expect(secondGenerated).toBe(0)

      const reopened = yield* Effect.acquireRelease(
        ApprovalAppStore.open(path),
        (store) => Effect.sync(() => store.close())
      )
      let generated = 0
      expect(
        yield* reopened.getOrCreateVapidKeys(() => {
          generated += 1
          return firstKeys
        })
      ).toEqual(secondKeys)
      expect(generated).toBe(0)
    })).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("rolls back compound subscription mutations when their second statement fails", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-push-transaction-test-"))
    const path = join(root, "approval.sqlite")
    return Effect.acquireUseRelease(
      ApprovalAppStore.open(path),
      (store) =>
        Effect.scoped(Effect.gen(function*() {
          yield* store.putSubscription(subscription, "alice@example.com")
          yield* store.recordDelivery("SER8", "job-1", subscription.endpoint, 1_000)
          const database = yield* Effect.acquireRelease(
            Effect.sync(() => new DatabaseSync(path)),
            (connection) => Effect.sync(() => connection.close())
          )
          database.exec(`
            CREATE TRIGGER fail_subscription_update
            BEFORE UPDATE ON push_subscriptions
            BEGIN SELECT RAISE(ABORT, 'blocked update'); END;
          `)
          expect(
            yield* Effect.result(
              store.putSubscription(subscription, "bob@example.com")
            )
          ).toMatchObject({ failure: { operation: "subscription.put" } })
          expect(yield* store.hasSubscription(subscription.endpoint, "alice@example.com")).toBe(true)
          expect(yield* store.hasDelivered("SER8", "job-1", subscription.endpoint)).toBe(true)
          database.exec("DROP TRIGGER fail_subscription_update")
          database.exec(`
            CREATE TRIGGER fail_subscription_delete
            BEFORE DELETE ON push_subscriptions
            BEGIN SELECT RAISE(ABORT, 'blocked delete'); END;
          `)
          expect(
            yield* Effect.result(
              store.deleteOwnedSubscription(subscription.endpoint, "alice@example.com")
            )
          ).toMatchObject({ failure: { operation: "subscription.deleteOwned" } })
          expect(
            yield* Effect.result(
              store.deleteSubscriptionPrivileged(subscription.endpoint)
            )
          ).toMatchObject({ failure: { operation: "subscription.delete" } })
          expect(yield* store.hasSubscription(subscription.endpoint, "alice@example.com")).toBe(true)
          expect(yield* store.hasDelivered("SER8", "job-1", subscription.endpoint)).toBe(true)
          database.exec("DROP TRIGGER fail_subscription_delete")
          expect(yield* store.deleteOwnedSubscription(subscription.endpoint, "alice@example.com")).toBe(true)
          expect(yield* store.hasDelivered("SER8", "job-1", subscription.endpoint)).toBe(false)
        })),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("retains the newest concurrent delivery timestamp", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-push-delivery-race-test-"))
    const path = join(root, "approval.sqlite")
    return Effect.acquireUseRelease(
      ApprovalAppStore.open(path),
      (store) =>
        Effect.scoped(Effect.gen(function*() {
          const database = yield* Effect.acquireRelease(
            Effect.sync(() => new DatabaseSync(path)),
            (connection) => Effect.sync(() => connection.close())
          )
          database.exec(`
            CREATE TRIGGER insert_newer_delivery
            BEFORE INSERT ON push_deliveries
            WHEN NEW.job_id = 'job-race'
            BEGIN
              INSERT INTO push_deliveries (host, job_id, endpoint, delivered_at)
              VALUES (NEW.host, NEW.job_id, NEW.endpoint, NEW.delivered_at + 1);
            END;
          `)
          yield* store.recordDelivery(
            "SER8",
            "job-race",
            subscription.endpoint,
            1_000
          )
          expect(
            yield* store.hasDelivered(
              "ser8",
              "job-race",
              subscription.endpoint,
              1_001
            )
          ).toBe(true)
          expect(
            yield* store.hasDelivered(
              "ser8",
              "job-race",
              subscription.endpoint,
              1_002
            )
          ).toBe(false)
          yield* store.recordDelivery(
            "SeR8",
            "job-race",
            subscription.endpoint,
            1_000
          )
          expect(
            yield* store.hasDelivered(
              "ser8",
              "job-race",
              subscription.endpoint,
              1_001
            )
          ).toBe(true)
          yield* store.recordDelivery(
            "ser8",
            "job-race",
            subscription.endpoint,
            1_002
          )
          expect(
            yield* store.hasDelivered(
              "SER8",
              "job-race",
              subscription.endpoint,
              1_002
            )
          ).toBe(true)
        })),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("does not recreate delivery state for a removed subscription", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-push-expired-test-"))
    return Effect.acquireUseRelease(
      ApprovalAppStore.open(join(root, "approval.sqlite")),
      (store) =>
        Effect.gen(function*() {
          yield* store.putSubscription(subscription, "alice@example.com")
          yield* runPushPass({
            allowedPushOrigins: ["https://push.example.test"],
            allowedUsers: ["alice@example.com"],
            loadCandidates: () => Effect.succeed([{ host: "SER8", jobId: "job-expired" }]),
            send: () => store.deleteSubscriptionPrivileged(subscription.endpoint),
            store
          })
          expect(yield* store.listSubscriptions()).toEqual([])
          expect(
            yield* store.hasDelivered(
              "SER8",
              "job-expired",
              subscription.endpoint
            )
          ).toBe(false)
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("retries an accepted delivery after its push TTL", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-push-ttl-test-"))
    let sends = 0
    const pass = (store: ApprovalAppStore) =>
      runPushPass({
        allowedPushOrigins: ["https://push.example.test"],
        allowedUsers: ["alice@example.com"],
        loadCandidates: () => Effect.succeed([{ host: "SER8", jobId: "job-ttl" }]),
        now: Effect.succeed(61_001),
        send: () =>
          Effect.sync(() => {
            sends += 1
          }),
        store
      })
    return Effect.acquireUseRelease(
      ApprovalAppStore.open(join(root, "approval.sqlite")),
      (store) =>
        Effect.gen(function*() {
          yield* store.putSubscription(subscription, "alice@example.com")
          yield* store.recordDelivery(
            "SER8",
            "job-ttl",
            subscription.endpoint,
            1_000
          )
          yield* pass(store)
          yield* pass(store)
          expect(sends).toBe(1)
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("does not send a persisted endpoint outside the configured origins", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-push-origin-test-"))
    let sends = 0
    return Effect.acquireUseRelease(
      ApprovalAppStore.open(join(root, "approval.sqlite")),
      (store) =>
        Effect.gen(function*() {
          yield* store.putSubscription(
            {
              ...subscription,
              endpoint: "https://untrusted.example.test/subscription"
            },
            "alice@example.com"
          )
          yield* runPushPass({
            allowedPushOrigins: ["https://push.example.test"],
            allowedUsers: ["alice@example.com"],
            loadCandidates: () => Effect.succeed([{ host: "SER8", jobId: "job-1" }]),
            send: () =>
              Effect.sync(() => {
                sends += 1
              }),
            store
          })
          expect(sends).toBe(0)
          expect(yield* store.listSubscriptions()).toEqual([])
          expect(
            yield* store.hasSubscription(
              "https://untrusted.example.test/subscription",
              "alice@example.com"
            )
          ).toBe(false)
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("deletes subscriptions whose owner is no longer allowed", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-push-owner-test-"))
    const sent: Array<string> = []
    return Effect.acquireUseRelease(
      ApprovalAppStore.open(join(root, "approval.sqlite")),
      (store) =>
        Effect.gen(function*() {
          yield* store.putSubscription(subscription, "alice@example.com")
          yield* store.putSubscription(
            { ...subscription, endpoint: "https://push.example.test/revoked" },
            "bob@example.com"
          )
          expect(
            yield* store.hasSubscription(
              subscription.endpoint,
              "alice@example.com"
            )
          ).toBe(true)
          expect(
            yield* store.hasSubscription(
              subscription.endpoint,
              "bob@example.com"
            )
          ).toBe(false)
          expect(
            yield* store.deleteOwnedSubscription(
              subscription.endpoint,
              "bob@example.com"
            )
          ).toBe(false)
          expect(
            yield* store.hasSubscription(
              subscription.endpoint,
              "alice@example.com"
            )
          ).toBe(true)
          yield* runPushPass({
            allowedPushOrigins: ["https://push.example.test"],
            allowedUsers: ["alice@example.com"],
            loadCandidates: () => Effect.succeed([{ host: "SER8", jobId: "job-1" }]),
            now: Effect.succeed(1_000),
            send: (target) =>
              Effect.sync(() => {
                sent.push(target.endpoint)
              }),
            store
          })
          expect(sent).toEqual([subscription.endpoint])
          expect((yield* store.listSubscriptions()).map(({ endpoint }) => endpoint))
            .toEqual([subscription.endpoint])
          expect(
            yield* store.deleteOwnedSubscription(
              subscription.endpoint,
              "alice@example.com"
            )
          ).toBe(true)
          expect(yield* store.listSubscriptions()).toEqual([])
          yield* store.putSubscription(subscription, "alice@example.com")
          yield* store.deleteSubscriptionPrivileged(subscription.endpoint)
          expect(yield* store.listSubscriptions()).toEqual([])
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("keeps approval credentials and SQLite sidecars private", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-approval-mode-test-"))
    const stateDirectory = join(root, "state")
    const databasePath = join(stateDirectory, "approval.sqlite")
    mkdirSync(stateDirectory, { mode: 0o755 })
    return Effect.acquireUseRelease(
      ApprovalAppStore.open(databasePath),
      (store) =>
        Effect.gen(function*() {
          yield* store.putSubscription(subscription, "alice@example.com")
          if (platform() === "win32") return
          expect(statSync(stateDirectory).mode & 0o777).toBe(0o700)
          for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
            if (existsSync(path)) expect(statSync(path).mode & 0o777).toBe(0o600)
          }
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("retries missing and failed deliveries, then suppresses success", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-push-worker-test-"))
    let attempts = 0
    let failNext = true
    return Effect.acquireUseRelease(
      ApprovalAppStore.open(join(root, "approval.sqlite")),
      (store) => {
        const pass = runPushPass({
          allowedPushOrigins: ["https://push.example.test"],
          allowedUsers: ["alice@example.com"],
          loadCandidates: () => Effect.succeed([{ host: "SER8", jobId: "job-1" }]),
          now: Effect.succeed(1_000),
          send: () =>
            Effect.suspend(() => {
              attempts += 1
              if (failNext) {
                failNext = false
                return Effect.fail(
                  new PushDeliveryError({
                    cause: "temporary outage",
                    operation: "test.send",
                    statusCode: null
                  })
                )
              }
              return Effect.void
            }),
          store
        })
        return Effect.gen(function*() {
          failNext = false
          yield* pass
          expect(attempts).toBe(0)

          yield* store.putSubscription(subscription, "alice@example.com")
          failNext = true
          yield* pass
          expect(attempts).toBe(1)

          yield* pass
          expect(attempts).toBe(2)

          yield* pass
          expect(attempts).toBe(2)
        })
      },
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("suppresses delivery when only the host casing changes", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-push-host-case-test-"))
    let attempts = 0
    return Effect.acquireUseRelease(
      ApprovalAppStore.open(join(root, "approval.sqlite")),
      (store) =>
        Effect.gen(function*() {
          yield* store.putSubscription(subscription, "alice@example.com")
          yield* store.recordDelivery(
            "SER8",
            "job-1",
            subscription.endpoint,
            1_000
          )
          yield* runPushPass({
            allowedPushOrigins: ["https://push.example.test"],
            allowedUsers: ["alice@example.com"],
            loadCandidates: () =>
              Effect.succeed([
                { host: "ser8", jobId: "job-1" },
                { host: "ser8", jobId: "job-2" },
                { host: "pi", jobId: "job-1" }
              ]),
            now: Effect.succeed(1_001),
            send: () =>
              Effect.sync(() => {
                attempts += 1
              }),
            store
          })
          expect(attempts).toBe(2)
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })
})

import { Effect, FileSystem, Path, Schema } from "effect"
import { DatabaseSync, type SQLOutputValue } from "node:sqlite"
import { ApprovalAppStoreError } from "./errors.js"
import {
  PushSubscriptionRecord,
  type PushSubscriptionRecord as PushSubscriptionRecordType,
  VapidKeyPair,
  type VapidKeyPair as VapidKeyPairType
} from "./model.js"

const storeError = (operation: string) => (cause: unknown) =>
  new ApprovalAppStoreError({ operation, detail: String(cause), cause })

const immediateTransaction = <Value>(
  database: DatabaseSync,
  operation: () => Value
): Value => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const value = operation()
    database.exec("COMMIT")
    return value
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

const decodeJson = <A>(
  operation: string,
  schema: Schema.Codec<A, unknown, never, never>,
  encoded: string
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(JSON.parse(encoded)),
    catch: storeError(operation)
  })

const StoredJsonRow = Schema.Struct({ record: Schema.String })
const StoredPushSubscription = Schema.Struct({
  ...PushSubscriptionRecord.fields,
  owner: Schema.optionalKey(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))
  )
})
type StoredPushSubscription = typeof StoredPushSubscription.Type

const decodeRow = <A>(
  operation: string,
  schema: Schema.Codec<A, unknown, never, never>,
  row: Readonly<Record<string, SQLOutputValue>> | undefined
) =>
  Schema.decodeUnknownEffect(StoredJsonRow)(row).pipe(
    Effect.mapError(storeError(operation)),
    Effect.flatMap(({ record }) => decodeJson(operation, schema, record))
  )

export class ApprovalAppStore {
  readonly #database: DatabaseSync
  readonly #fileSystem: FileSystem.FileSystem
  readonly path: string

  private constructor(path: string, fileSystem: FileSystem.FileSystem) {
    this.path = path
    this.#fileSystem = fileSystem
    this.#database = new DatabaseSync(path)
    try {
      this.#database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS vapid_keys (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          record TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint TEXT PRIMARY KEY,
          record TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS push_deliveries (
          host TEXT NOT NULL,
          job_id TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          delivered_at INTEGER NOT NULL,
          PRIMARY KEY (host, job_id, endpoint)
        );
      `)
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  static readonly open = Effect.fn("ApprovalAppStore.open")(function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const directory = paths.dirname(path)
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(storeError("open.makeDirectory"))
    )
    yield* fileSystem.chmod(directory, 0o700).pipe(
      Effect.mapError(storeError("open.secureDirectory"))
    )
    const store = yield* Effect.try({
      try: () => new ApprovalAppStore(path, fileSystem),
      catch: storeError("open.database")
    })
    yield* store.secureFiles()
    return store
  })

  readonly getOrCreateVapidKeys = Effect.fn("ApprovalAppStore.getOrCreateVapidKeys")(function*(
    this: ApprovalAppStore,
    generate: () => VapidKeyPairType
  ) {
    const database = this.#database
    const existing = yield* Effect.try({
      try: () => database.prepare("SELECT record FROM vapid_keys WHERE id = 1").get(),
      catch: storeError("vapid.get")
    })
    if (existing !== undefined) {
      return yield* decodeRow("vapid.decode", VapidKeyPair, existing)
    }
    const generated = yield* Effect.try({
      try: generate,
      catch: storeError("vapid.generate")
    })
    const keys = yield* Schema.decodeUnknownEffect(VapidKeyPair)(
      generated
    ).pipe(Effect.mapError(storeError("vapid.validate")))
    yield* Effect.try({
      try: () =>
        database
          .prepare("INSERT OR IGNORE INTO vapid_keys (id, record) VALUES (1, ?)")
          .run(JSON.stringify(keys)),
      catch: storeError("vapid.put")
    })
    yield* this.secureFiles()
    const persisted = yield* Effect.try({
      try: () => database.prepare("SELECT record FROM vapid_keys WHERE id = 1").get(),
      catch: storeError("vapid.get.persisted")
    })
    return yield* decodeRow("vapid.decode.persisted", VapidKeyPair, persisted)
  })

  readonly putSubscription = Effect.fn("ApprovalAppStore.putSubscription")(function*(
    this: ApprovalAppStore,
    subscription: PushSubscriptionRecordType,
    owner: string
  ) {
    const database = this.#database
    yield* Effect.try({
      try: () => {
        immediateTransaction(database, () => {
          database
            .prepare("DELETE FROM push_deliveries WHERE endpoint = ?")
            .run(subscription.endpoint)
          database
            .prepare(
              "INSERT INTO push_subscriptions (endpoint, record) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET record = excluded.record"
            )
            .run(subscription.endpoint, JSON.stringify({ ...subscription, owner }))
        })
      },
      catch: storeError("subscription.put")
    })
    yield* this.secureFiles()
  })

  readonly deleteSubscriptionPrivileged = Effect.fn("ApprovalAppStore.deleteSubscriptionPrivileged")(function*(
    this: ApprovalAppStore,
    endpoint: string
  ) {
    const database = this.#database
    yield* Effect.try({
      try: () => {
        immediateTransaction(database, () => {
          database
            .prepare("DELETE FROM push_deliveries WHERE endpoint = ?")
            .run(endpoint)
          database
            .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
            .run(endpoint)
        })
      },
      catch: storeError("subscription.delete")
    })
    yield* this.secureFiles()
  })

  readonly deleteOwnedSubscription = Effect.fn("ApprovalAppStore.deleteOwnedSubscription")(function*(
    this: ApprovalAppStore,
    endpoint: string,
    owner: string
  ) {
    const database = this.#database
    const deleted = yield* Effect.try({
      try: () => {
        return immediateTransaction(database, () => {
          const row = database
            .prepare("SELECT record FROM push_subscriptions WHERE endpoint = ?")
            .get(endpoint)
          if (row === undefined) return false
          const encoded = Schema.decodeUnknownSync(StoredJsonRow)(row)
          const stored = Schema.decodeUnknownSync(StoredPushSubscription)(
            JSON.parse(encoded.record)
          )
          if (stored.owner !== owner) return false
          database
            .prepare("DELETE FROM push_deliveries WHERE endpoint = ?")
            .run(endpoint)
          database
            .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
            .run(endpoint)
          return true
        })
      },
      catch: storeError("subscription.deleteOwned")
    })
    if (deleted) yield* this.secureFiles()
    return deleted
  })

  readonly hasSubscription = Effect.fn("ApprovalAppStore.hasSubscription")(function*(
    this: ApprovalAppStore,
    endpoint: string,
    owner: string
  ) {
    const database = this.#database
    const row = yield* Effect.try({
      try: () =>
        database
          .prepare("SELECT record FROM push_subscriptions WHERE endpoint = ?")
          .get(endpoint),
      catch: storeError("subscription.has")
    })
    if (row === undefined) return false
    const stored = yield* decodeRow(
      "subscription.has.decode",
      StoredPushSubscription,
      row
    )
    return stored.owner === owner
  })

  readonly listSubscriptions = Effect.fn("ApprovalAppStore.listSubscriptions")(function*(
    this: ApprovalAppStore
  ) {
    const database = this.#database
    const rows = yield* Effect.try({
      try: () =>
        database
          .prepare(
            "SELECT record FROM push_subscriptions ORDER BY endpoint ASC"
          )
          .all(),
      catch: storeError("subscription.list")
    })
    return yield* Effect.forEach(rows, (row) => decodeRow("subscription.decode", StoredPushSubscription, row))
  })

  readonly hasDelivered = Effect.fn("ApprovalAppStore.hasDelivered")(function*(
    this: ApprovalAppStore,
    host: string,
    jobId: string,
    endpoint: string,
    deliveredAfter = Number.MIN_SAFE_INTEGER
  ) {
    const database = this.#database
    return yield* Effect.try({
      try: () =>
        database
          .prepare(
            "SELECT 1 FROM push_deliveries WHERE host = ? AND job_id = ? AND endpoint = ? AND delivered_at >= ?"
          )
          .get(host, jobId, endpoint, deliveredAfter) !== undefined,
      catch: storeError("delivery.has")
    })
  })

  readonly recordDelivery = Effect.fn("ApprovalAppStore.recordDelivery")(function*(
    this: ApprovalAppStore,
    host: string,
    jobId: string,
    endpoint: string,
    deliveredAt: number
  ) {
    const database = this.#database
    yield* Effect.try({
      try: () => {
        database
          .prepare(
            `INSERT INTO push_deliveries (host, job_id, endpoint, delivered_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(host, job_id, endpoint) DO UPDATE SET
               delivered_at = excluded.delivered_at`
          )
          .run(host, jobId, endpoint, deliveredAt)
      },
      catch: storeError("delivery.record")
    })
    yield* this.secureFiles()
  })

  private secureFiles() {
    const fileSystem = this.#fileSystem
    const files = [this.path, `${this.path}-wal`, `${this.path}-shm`]
    return Effect.forEach(
      files,
      (path) =>
        fileSystem.exists(path).pipe(
          Effect.mapError(storeError("secure.exists")),
          Effect.flatMap((exists) =>
            exists
              ? fileSystem.chmod(path, 0o600).pipe(
                Effect.mapError(storeError("secure.chmod"))
              )
              : Effect.void
          )
        ),
      { discard: true }
    )
  }

  close(): void {
    this.#database.close()
  }
}

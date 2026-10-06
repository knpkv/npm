/**
 * Pi Durable's portable SQLite core over `@libsql/client`, so Relay sessions use the same SQLite
 * driver as codecommit-core and run under both Node and Bun.
 *
 * **Mental model**
 *
 * - **One queue per connection.** Pi requires that unrelated operations wait while a transaction is
 *   open. Every operation and every transaction runs through one promise queue, in call order.
 * - **Rows are plain objects.** libsql rows also carry positional keys; Pi reads columns by name, so each
 *   row is rebuilt from the result's column list.
 *
 * This module is a Promise boundary by design: Pi calls it, not Effect.
 *
 * @module
 */
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite"
import type { Client, InStatement, ResultSet, Transaction } from "@libsql/client"
import { Predicate } from "effect"

const toObjects = <T extends object>(result: ResultSet): Array<T> =>
  result.rows.map((row) =>
    // SAFETY: Pi's `get<T>`/`all<T>` contract names the row shape its own SQL selects; this adapter only
    // rebuilds each row by column name and cannot check `T`.
    // ast-grep-ignore: no-type-assertion
    Object.fromEntries(result.columns.map((column, index) => [column, row[index]])) as T
  )

const statement = (sql: string, params: ReadonlyArray<SqliteValue>): InStatement => ({
  sql,
  args: params.map((value) => (Predicate.isUint8Array(value) ? value.slice().buffer : value))
})

const executorOver = (
  execute: (sql: string, params: ReadonlyArray<SqliteValue>) => Promise<ResultSet>,
  multiple: (sql: string) => Promise<void>
): SqliteExecutor => ({
  exec: multiple,
  run: async (sql, ...params) => {
    await execute(sql, params)
  },
  get: async <T extends object>(sql: string, ...params: Array<SqliteValue>) =>
    toObjects<T>(await execute(sql, params))[0],
  all: async <T extends object>(sql: string, ...params: Array<SqliteValue>) => toObjects<T>(await execute(sql, params))
})

/** Wrap an open libsql client as Pi's `SqliteDatabase`. The client is closed with it. */
export const libsqlDatabase = (client: Client): SqliteDatabase => {
  let tail: Promise<void> = Promise.resolve()
  const queued = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
  const direct = executorOver(
    (sql, params) => queued(() => client.execute(statement(sql, params))),
    (sql) => queued(() => client.executeMultiple(sql))
  )
  const inside = (transaction: Transaction): SqliteExecutor =>
    executorOver(
      (sql, params) => transaction.execute(statement(sql, params)),
      (sql) => transaction.executeMultiple(sql)
    )
  return {
    ...direct,
    transaction: <T>(callback: (transaction: SqliteExecutor) => Promise<T>) =>
      queued(async () => {
        const transaction = await client.transaction("write")
        try {
          const value = await callback(inside(transaction))
          await transaction.commit()
          return value
        } catch (error) {
          try {
            await transaction.rollback()
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "Relay session transaction failed and did not roll back", {
              cause: rollbackError
            })
          }
          throw error
        } finally {
          transaction.close()
        }
      }),
    close: () => queued(async () => client.close())
  }
}

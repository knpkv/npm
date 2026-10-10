/**
 * The part of Bun's built-in SQLite the store lock uses. Bun provides the module at runtime; Node never loads
 * it (the lock tries `node:sqlite` first), so Relay needs no Bun types to build.
 */
declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string)
    exec(sql: string): void
    close(): void
  }
}

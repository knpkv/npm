/**
 * Token storage for OAuth credentials.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FileSystemError } from "../ConfluenceError.js"
import { type OAuthConfig, OAuthConfigSchema, type OAuthToken, OAuthTokenSchema } from "../Schemas.js"

const TOKEN_DIR = path.join(os.homedir(), ".confluence")
const TOKEN_PATH = path.join(TOKEN_DIR, "auth.json")
const CONFIG_PATH = path.join(TOKEN_DIR, "config.json")

/**
 * Load stored OAuth token from disk.
 *
 * @returns The stored token or null if not found/invalid
 *
 * @category Token Storage
 */
export const loadToken = (): Effect.Effect<OAuthToken | null, FileSystemError> =>
  Effect.gen(function*() {
    const exists = fs.existsSync(TOKEN_PATH)
    if (!exists) {
      return null
    }

    const content = yield* Effect.tryPromise({
      try: () => fs.promises.readFile(TOKEN_PATH, "utf-8"),
      catch: (cause) => new FileSystemError({ operation: "read", path: TOKEN_PATH, cause })
    })

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return null
    }

    const decoded = yield* Schema.decodeUnknown(OAuthTokenSchema)(parsed).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    )

    return decoded
  })

/**
 * Save OAuth token to disk with secure permissions.
 *
 * @param token - The token to save
 *
 * @category Token Storage
 */
export const saveToken = (token: OAuthToken): Effect.Effect<void, FileSystemError> =>
  Effect.gen(function*() {
    yield* Effect.tryPromise({
      try: () => fs.promises.mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 }),
      catch: (cause) => new FileSystemError({ operation: "mkdir", path: TOKEN_DIR, cause })
    })

    yield* Effect.tryPromise({
      try: () => fs.promises.writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 }),
      catch: (cause) => new FileSystemError({ operation: "write", path: TOKEN_PATH, cause })
    })
  })

/**
 * Delete stored OAuth token.
 *
 * @category Token Storage
 */
export const deleteToken = (): Effect.Effect<void, FileSystemError> =>
  Effect.tryPromise({
    try: () => fs.promises.unlink(TOKEN_PATH).catch(() => undefined),
    catch: (cause) => new FileSystemError({ operation: "delete", path: TOKEN_PATH, cause })
  })

/**
 * Load OAuth client configuration from disk.
 *
 * @returns The stored config or null if not found/invalid
 *
 * @category OAuth Config
 */
export const loadOAuthConfig = (): Effect.Effect<OAuthConfig | null, FileSystemError> =>
  Effect.gen(function*() {
    const exists = fs.existsSync(CONFIG_PATH)
    if (!exists) {
      return null
    }

    const content = yield* Effect.tryPromise({
      try: () => fs.promises.readFile(CONFIG_PATH, "utf-8"),
      catch: (cause) => new FileSystemError({ operation: "read", path: CONFIG_PATH, cause })
    })

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return null
    }

    const decoded = yield* Schema.decodeUnknown(OAuthConfigSchema)(parsed).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    )

    return decoded
  })

/**
 * Save OAuth client configuration to disk with secure permissions.
 *
 * @param config - The config to save
 *
 * @category OAuth Config
 */
export const saveOAuthConfig = (config: OAuthConfig): Effect.Effect<void, FileSystemError> =>
  Effect.gen(function*() {
    yield* Effect.tryPromise({
      try: () => fs.promises.mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 }),
      catch: (cause) => new FileSystemError({ operation: "mkdir", path: TOKEN_DIR, cause })
    })

    yield* Effect.tryPromise({
      try: () => fs.promises.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }),
      catch: (cause) => new FileSystemError({ operation: "write", path: CONFIG_PATH, cause })
    })
  })

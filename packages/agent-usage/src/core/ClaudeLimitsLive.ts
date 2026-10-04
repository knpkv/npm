/**
 * The live token and endpoint behind {@link pollClaudeLimits}.
 *
 * Linux keeps Claude Code's credentials in `<secure storage dir>/.credentials.json`; macOS keeps them
 * in the login Keychain. The file is tried first and the Keychain second, so no platform check is
 * needed: on Linux the `security` binary does not exist and the lookup reports the missing file.
 *
 * The Keychain item is the one Claude Code itself reads: its service name carries a hash of a
 * non-default config directory and the account is the user (see `ClaudeCredentialsLocation`).
 * `security`'s exit code tells a missing item (44) from one this process may not read, such as a
 * locked Keychain or a session without a GUI, so neither shows up as "not signed in".
 *
 * The executable provides `FetchHttpClient.layer`; redirects are refused so the token cannot
 * follow one off Anthropic's host.
 *
 * @module
 */
import { Duration, Effect, FileSystem, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  type ClaudeUsageDeps,
  CredentialsMissing,
  CredentialsUnreadable,
  KeychainDenied,
  tokenFromCredentials,
  USAGE_URL,
  UsageFetchFailed
} from "./ClaudeLimits.js"

const TIMEOUT = Duration.seconds(5)

/** `security`'s exit code for an item that does not exist (errSecItemNotFound). */
const ITEM_NOT_FOUND = 44

/** How long `security` may take: a locked Keychain or a password prompt can wait forever. */
export const KEYCHAIN_DEADLINE = Duration.seconds(10)

/** A Keychain lookup bounded by {@link KEYCHAIN_DEADLINE}, so a hung lookup cannot stall polling. */
export const withKeychainDeadline = <A, E, R>(lookup: Effect.Effect<A, E, R>) =>
  lookup.pipe(
    Effect.timeoutOrElse({
      duration: KEYCHAIN_DEADLINE,
      orElse: () => Effect.fail(new KeychainDenied({ exitCode: null }))
    })
  )

/** A failed read of the credentials file: only a missing file sends the lookup on to the Keychain. */
export const credentialsFileFailure = (reason: string): CredentialsMissing | CredentialsUnreadable =>
  reason === "NotFound" ? new CredentialsMissing({ where: "file" }) : new CredentialsUnreadable({ reason })

/** Where Claude Code's credentials live; built by the configuration. */
export interface ClaudeCredentialsPlaces {
  readonly file: string
  readonly keychainService: string
  readonly keychainAccount: string
}

/** The `security` arguments that print Claude Code's own Keychain item. */
export const keychainArgs = (
  places: Pick<ClaudeCredentialsPlaces, "keychainService" | "keychainAccount">
): ReadonlyArray<string> => [
  "find-generic-password",
  "-a",
  places.keychainAccount,
  "-w",
  "-s",
  places.keychainService
]

/** What a finished `security` lookup means: the item's contents, or why there are none. */
export const keychainOutcome = (
  exitCode: number,
  stdout: string,
  service: string
): Effect.Effect<string, CredentialsMissing | KeychainDenied> =>
  exitCode === 0
    ? Effect.succeed(stdout)
    : exitCode === ITEM_NOT_FOUND
    ? Effect.fail(new CredentialsMissing({ where: `keychain:${service}` }))
    : Effect.fail(new KeychainDenied({ exitCode }))

/** Builds the live dependencies for where Claude Code keeps its credentials. */
export const liveClaudeUsageDeps = (places: ClaudeCredentialsPlaces) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const client = yield* HttpClient.HttpClient

    const fromFile = fs.readFileString(places.file).pipe(
      Effect.mapError((error) => credentialsFileFailure(error.reason._tag))
    )
    const fromKeychain = withKeychainDeadline(Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* spawner.spawn(ChildProcess.make("security", keychainArgs(places)))
        const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout))
        const exitCode = yield* handle.exitCode
        return yield* keychainOutcome(exitCode, stdout, places.keychainService)
      })
    )).pipe(
      // No `security` binary (Linux) or no way to run it: the file was the only place to look.
      Effect.catchTag("PlatformError", () => Effect.fail(new CredentialsMissing({ where: "file" })))
    )

    const deps: ClaudeUsageDeps = {
      readToken: fromFile.pipe(
        Effect.catchTag("CredentialsMissing", () => fromKeychain),
        Effect.flatMap(tokenFromCredentials)
      ),
      get: (token) =>
        client.execute(
          HttpClientRequest.get(USAGE_URL).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.setHeaders({ "anthropic-beta": "oauth-2025-04-20", "User-Agent": "agent-usage" })
          )
        ).pipe(
          Effect.flatMap((response) => Effect.map(response.text, (body) => ({ status: response.status, body }))),
          Effect.timeout(TIMEOUT),
          // A redirect would carry the bearer token to another host; refuse to follow one.
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          // Only the failure's kind is kept: the request it came from carries the token.
          Effect.mapError((error) => new UsageFetchFailed({ cause: error._tag }))
        )
    }
    return deps
  })

/**
 * The live token and endpoint behind {@link pollClaudeLimits}.
 *
 * Linux keeps Claude Code's credentials in `<config>/.credentials.json`; macOS keeps them in the
 * login Keychain. The file is tried first and the Keychain second, so no platform check is needed:
 * on Linux the `security` binary does not exist and the lookup fails as missing credentials.
 *
 * The executable provides `FetchHttpClient.layer`; redirects are refused so the token cannot
 * follow one off Anthropic's host.
 *
 * @module
 */
import { Duration, Effect, FileSystem, Path } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  type ClaudeUsageDeps,
  CredentialsMissing,
  tokenFromCredentials,
  USAGE_URL,
  UsageFetchFailed
} from "./ClaudeLimits.js"

const TIMEOUT = Duration.seconds(5)

/** Builds the live dependencies for a Claude config directory (`CLAUDE_CONFIG_DIR` or `~/.claude`). */
export const liveClaudeUsageDeps = (claudeConfigDir: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const client = yield* HttpClient.HttpClient

    const fromFile = fs.readFileString(path.join(claudeConfigDir, ".credentials.json")).pipe(
      Effect.mapError(() => new CredentialsMissing())
    )
    const fromKeychain = spawner.string(
      ChildProcess.make("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"])
    ).pipe(Effect.mapError(() => new CredentialsMissing()))

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

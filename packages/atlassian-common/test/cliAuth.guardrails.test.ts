/** @effect-diagnostics strictEffectProvide:skip-file */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import confluenceIntegration from "../../confluence-to-markdown/vitest.config.integration.js"
import confluence from "../../confluence-to-markdown/vitest.config.js"
import jiraIntegration from "../../jira-cli/vitest.config.integration.js"
import jira from "../../jira-cli/vitest.config.js"
import clockify from "../../jira-clockify/vitest.config.js"

const configs = { jira, jiraIntegration, confluence, confluenceIntegration, clockify }
const Findings = Schema.fromJsonString(Schema.Array(Schema.Struct({ file: Schema.String })))

describe("CLI auth guardrails", () => {
  for (const [name, config] of Object.entries(configs)) {
    it(`${name} resolves CLI auth from source rather than stale build output`, () => {
      const aliases = config.resolve?.alias
      const entries = Array.isArray(aliases) ? aliases : []
      const specifier = "@knpkv/atlassian-common/cli-auth"
      const cliAuth = entries.find(({ find }) => Predicate.isString(find) ? find === specifier : find.test(specifier))
      expect(cliAuth?.replacement).toBe(new URL("../src/cli-auth/index.ts", import.meta.url).pathname)
    })
  }

  it.effect("limits the reimplementation guard to the Jira and Confluence CLIs", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
      const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "cli-auth-guard-" })
      yield* fs.writeFileString(
        path.join(fixture, "sgconfig.yml"),
        "ruleDirs: []\nlanguageGlobs:\n  tsx:\n    - \"**/*.ts\"\n"
      )
      // The same callback-server name and endpoint namespace are legitimate in
      // another integration. Only the two delegated CLI implementations are banned.
      const source = [
        "import * as Auth from \"@knpkv/atlassian-common/auth\"",
        "import { refreshToken } from \"@knpkv/atlassian-common/auth\"",
        "const authUrl = Auth.buildAuthUrl({ clientId: \"client\" })",
        "function startCallbackServer(state: string) { return state }"
      ].join("\n")
      for (const name of ["jira-cli", "confluence-to-markdown", "other-oauth"]) {
        const directory = path.join(fixture, "packages", name, "src")
        yield* fs.makeDirectory(directory, { recursive: true })
        yield* fs.writeFileString(path.join(directory, "auth.ts"), source)
      }
      const handle = yield* spawner.spawn(ChildProcess.make(
        path.join(root, "node_modules", ".bin", "ast-grep"),
        [
          "scan",
          "--rule",
          path.join(root, "ast-grep", "rules", "packaging", "no-atlassian-cli-auth-reimplementation.yml"),
          "--json=compact",
          "packages"
        ],
        { cwd: fixture }
      ))
      const { exitCode, stderr, stdout } = yield* Effect.all({
        exitCode: handle.exitCode,
        stdout: Stream.decodeText(handle.stdout).pipe(Stream.mkString),
        stderr: Stream.decodeText(handle.stderr).pipe(Stream.mkString)
      }, { concurrency: "unbounded" })
      expect(exitCode, `${fixture}: ${stdout} ${stderr}`).toBe(1)
      const findings = yield* Schema.decodeUnknownEffect(Findings)(stdout)
      expect(findings.map(({ file }) => file).sort()).toEqual([
        ...Array<string>(3).fill("packages/confluence-to-markdown/src/auth.ts"),
        ...Array<string>(3).fill("packages/jira-cli/src/auth.ts")
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

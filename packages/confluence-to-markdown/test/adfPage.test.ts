/**
 * ADF-level page commands.
 *
 * These are the only remote-write paths that bypass the markdown projection, so
 * the checks that keep them safe — concurrency, input validation and the base
 * URL the API token is sent to — are worth pinning down.
 *
 * The layer stack below is bespoke, so passing here says nothing about whether
 * the CLI can actually run these commands: it once provided `AdfSchemaValidator`
 * that the real `FetchLayer` did not, and every command died on startup while
 * this file stayed green. That coverage is asserted at compile time in
 * `commands/layers.ts`; do not read a passing run here as proof of wiring.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Terminal from "effect/Terminal"
import { Command } from "effect/unstable/cli"
import { fileURLToPath } from "node:url"
import { layer as AdfSchemaValidatorLayer } from "../src/AdfSchemaValidator.js"
import { layer as AtlaskitTransformersLayer } from "../src/AtlaskitTransformers.js"
import { makePageCreateCommand, makePagePatchCommand, makePagePutCommand } from "../src/commands/adfPage.js"
import { ConfluenceAuth } from "../src/ConfluenceAuth.js"
import { ConfluenceClient } from "../src/ConfluenceClient.js"
import type { PageResponse } from "../src/Schemas.js"

const PAGE_ID = "2333334354"

const adf = (text: string) =>
  JSON.stringify({
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  })

const pageAt = (version: number, text: string): PageResponse => ({
  id: PAGE_ID,
  title: "Patched Page",
  version: { number: version },
  body: { atlas_doc_format: { representation: "atlas_doc_format", value: adf(text) } }
})

interface UpdateCall {
  readonly version: number
}

const AuthLayer = Layer.succeed(
  ConfluenceAuth,
  ConfluenceAuth.of({
    configure: () => Effect.void,
    isConfigured: () => Effect.succeed(true),
    login: () => Effect.void,
    logout: () => Effect.void,
    getAccessToken: () => Effect.succeed("access-token"),
    getCloudId: () => Effect.succeed("cloud-id"),
    getCurrentUser: () => Effect.succeed(null),
    getActiveProfile: () => Effect.succeed(null),
    listProfiles: () => Effect.succeed([]),
    switchProfile: () => Effect.succeed(null),
    removeProfile: () => Effect.succeed(null),
    isLoggedIn: () => Effect.succeed(true)
  })
)

const CaptureTerminalLayer = (stdout: Ref.Ref<string>) =>
  Layer.succeed(
    Terminal.Terminal,
    Terminal.Terminal.of({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.die("readInput should not be called"),
      readLine: Effect.die("readLine should not be called"),
      display: (text) => Ref.update(stdout, (output) => output + text)
    })
  )

/**
 * A page that is edited by someone else between the read and the write — the
 * race `page patch` has to lose loudly rather than win silently.
 */
const ConcurrentlyEditedClientLayer = (updates: Ref.Ref<ReadonlyArray<UpdateCall>>) => {
  let reads = 0
  return Layer.succeed(
    ConfluenceClient,
    ConfluenceClient.of({
      getPage: () => {
        reads += 1
        return Effect.succeed(reads === 1 ? pageAt(7, "before") : pageAt(8, "someone else's edit"))
      },
      updatePage: (request) =>
        Ref.update(updates, (calls) => [...calls, { version: request.version.number }]).pipe(
          Effect.as(pageAt(request.version.number, "written"))
        ),
      getChildren: () => Effect.die("unused"),
      getAllChildren: () => Effect.die("unused"),
      createPage: () => Effect.die("unused"),
      deletePage: () => Effect.die("unused"),
      getPageVersions: () => Effect.die("unused"),
      getPageAttachments: () => Effect.die("unused"),
      uploadAttachmentToPage: () => Effect.die("unused"),
      getUser: () => Effect.die("unused"),
      getSpaceId: () => Effect.die("unused"),
      setEditorVersion: () => Effect.die("unused")
    })
  )
}

const NeverCalledClientLayer = Layer.succeed(
  ConfluenceClient,
  ConfluenceClient.of({
    getPage: () => Effect.die("the command must fail before reading the page"),
    updatePage: () => Effect.die("the command must fail before writing the page"),
    createPage: () => Effect.die("the command must fail before writing the page"),
    getChildren: () => Effect.die("unused"),
    getAllChildren: () => Effect.die("unused"),
    deletePage: () => Effect.die("unused"),
    getPageVersions: () => Effect.die("unused"),
    getPageAttachments: () => Effect.die("unused"),
    uploadAttachmentToPage: () => Effect.die("unused"),
    getUser: () => Effect.die("unused"),
    getSpaceId: () => Effect.die("unused"),
    setEditorVersion: () => Effect.die("unused")
  })
)

/** A page sitting at version 9 — ahead of anything a caller read earlier. */
const MovedOnClientLayer = (updates: Ref.Ref<ReadonlyArray<UpdateCall>>) =>
  Layer.succeed(
    ConfluenceClient,
    ConfluenceClient.of({
      getPage: () => Effect.succeed(pageAt(9, "someone else's edit")),
      updatePage: (request) =>
        Ref.update(updates, (calls) => [...calls, { version: request.version.number }]).pipe(
          Effect.as(pageAt(request.version.number, "written"))
        ),
      getChildren: () => Effect.die("unused"),
      getAllChildren: () => Effect.die("unused"),
      createPage: () => Effect.die("unused"),
      deletePage: () => Effect.die("unused"),
      getPageVersions: () => Effect.die("unused"),
      getPageAttachments: () => Effect.die("unused"),
      uploadAttachmentToPage: () => Effect.die("unused"),
      getUser: () => Effect.die("unused"),
      getSpaceId: () => Effect.die("unused"),
      setEditorVersion: () => Effect.die("unused")
    })
  )

const runCommand = (
  command:
    | ReturnType<typeof makePagePatchCommand>
    | ReturnType<typeof makePageCreateCommand>
    | ReturnType<typeof makePagePutCommand>,
  args: ReadonlyArray<string>
) =>
  Effect.gen(function*() {
    const stdout = yield* Ref.make("")
    const cli = Command.runWith(command, { version: "0.0.0-test" })
    const exit = yield* cli(args).pipe(
      Effect.provide(Layer.mergeAll(
        AuthLayer,
        CaptureTerminalLayer(stdout),
        AdfSchemaValidatorLayer.pipe(Layer.provide(AtlaskitTransformersLayer)),
        NodePath.layer,
        NodeFileSystem.layer
      )),
      Effect.exit
    )
    return { exit, stdout: yield* Ref.get(stdout) }
  })

const pageUrl = `https://example.atlassian.net/wiki/spaces/PROJ/pages/${PAGE_ID}`
/**
 * A body authored offline, the shape `page put` exists for.
 *
 * Resolved against this file, not the process cwd: the workspace-root `vitest`
 * run has a different cwd from `vitest` inside the package, and a relative path
 * silently passes in one and fails in the other.
 */
const adfFixture = fileURLToPath(new URL("./fixtures/page-put.adf.json", import.meta.url))

describe("page patch", () => {
  // Re-reading the page at write time would number the update one ahead of the
  // concurrent edit, so Confluence would accept it and the other edit would be
  // gone. Writing base+1 is what turns the race into a visible 409.
  it.effect("writes the version it read, not a fresher one", () =>
    Effect.gen(function*() {
      const updates = yield* Ref.make<ReadonlyArray<UpdateCall>>([])
      const command = makePagePatchCommand({ makeClientLayer: () => ConcurrentlyEditedClientLayer(updates) })

      const { exit } = yield* runCommand(command, [
        "--url",
        pageUrl,
        "--replace",
        "before",
        "--with",
        "after"
      ])

      expect(exit._tag).toBe("Success")
      // 8, from the read the patched content was derived from — not 9, which a
      // refetch would have produced from the concurrent edit's version.
      expect(yield* Ref.get(updates)).toEqual([{ version: 8 }])
    }))

  // `includes("")` matches every string and `replaceAll("", x)` splices x
  // between every character, so this would rewrite the whole page.
  it.effect("rejects an empty --replace before touching the page", () =>
    Effect.gen(function*() {
      const command = makePagePatchCommand({ makeClientLayer: () => NeverCalledClientLayer })

      const { exit } = yield* runCommand(command, ["--url", pageUrl, "--replace", "", "--with", "x"])

      expect(exit._tag).toBe("Failure")
      // Specifically the validation error, not an incidental crash further in.
      expect(JSON.stringify(exit)).toContain("non-empty search string")
    }))

  // Previewing a destructive edit is the point of --dry-run, so it has to run
  // the same outgoing validation the real write does. `--delete-node` can
  // leave a document Confluence rejects, and returning before the check
  // reported success while deferring the failure to the real run.
  it.effect("--dry-run validates the patched document", () =>
    Effect.gen(function*() {
      const updates = yield* Ref.make<ReadonlyArray<UpdateCall>>([])
      const command = makePagePatchCommand({ makeClientLayer: () => ConcurrentlyEditedClientLayer(updates) })

      const { exit } = yield* runCommand(command, [
        "--url",
        pageUrl,
        "--delete-node",
        "doc",
        "--dry-run"
      ])

      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("schema validation failed (outgoing)")
      // Still a dry run: nothing was written.
      expect(yield* Ref.get(updates)).toEqual([])
    }))
})

describe("page put", () => {
  // The round-trip-unsafe refusal tells the user to `page get --format adf`,
  // edit, then `page put`. Without --if-version that write lands on whatever
  // the current version is, so an edit made in Confluence in between is gone
  // with no conflict — the exact loss `page patch` was built to surface.
  it.effect("--if-version refuses to overwrite a page that moved on", () =>
    Effect.gen(function*() {
      const updates = yield* Ref.make<ReadonlyArray<UpdateCall>>([])
      const command = makePagePutCommand({ makeClientLayer: () => MovedOnClientLayer(updates) })

      const { exit } = yield* runCommand(command, [
        "--url",
        pageUrl,
        "--adf",
        adfFixture,
        "--if-version",
        "7"
      ])

      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("is at version 9, not 7")
      // Nothing was written.
      expect(yield* Ref.get(updates)).toEqual([])
    }))

  // The nearby valid fixture: the flag is opt-in, and a matching version still
  // writes.
  it.effect("--if-version writes when the page is still where it was read", () =>
    Effect.gen(function*() {
      const updates = yield* Ref.make<ReadonlyArray<UpdateCall>>([])
      const command = makePagePutCommand({ makeClientLayer: () => MovedOnClientLayer(updates) })

      const { exit } = yield* runCommand(command, [
        "--url",
        pageUrl,
        "--adf",
        adfFixture,
        "--if-version",
        "9"
      ])

      expect(exit._tag).toBe("Success")
      expect(yield* Ref.get(updates)).toEqual([{ version: 10 }])
    }))

  // `--if-version` is a check, so the preview has to run it. Reporting that the
  // write would succeed at the exact moment the real command refuses is
  // misleading precisely for the workflow the flag was added to protect.
  it.effect("--dry-run still runs the --if-version check", () =>
    Effect.gen(function*() {
      const updates = yield* Ref.make<ReadonlyArray<UpdateCall>>([])
      const command = makePagePutCommand({ makeClientLayer: () => MovedOnClientLayer(updates) })

      const { exit } = yield* runCommand(command, [
        "--url",
        pageUrl,
        "--adf",
        adfFixture,
        "--if-version",
        "7",
        "--dry-run"
      ])

      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("is at version 9, not 7")
      expect(yield* Ref.get(updates)).toEqual([])
    }))

  // The nearby valid fixture: a matching version previews cleanly, and a dry
  // run still writes nothing.
  it.effect("--dry-run passes when the version matches, and writes nothing", () =>
    Effect.gen(function*() {
      const updates = yield* Ref.make<ReadonlyArray<UpdateCall>>([])
      const command = makePagePutCommand({ makeClientLayer: () => MovedOnClientLayer(updates) })

      const { exit } = yield* runCommand(command, [
        "--url",
        pageUrl,
        "--adf",
        adfFixture,
        "--if-version",
        "9",
        "--dry-run"
      ])

      expect(exit._tag).toBe("Success")
      expect(yield* Ref.get(updates)).toEqual([])
    }))
})

describe("page create", () => {
  // The client sends `Authorization: Basic <email:apiToken>` to whatever origin
  // it is handed, so an unvalidated --base-url leaks the token to that host.
  it.effect("rejects a --base-url outside Atlassian Cloud", () =>
    Effect.gen(function*() {
      const command = makePageCreateCommand({ makeClientLayer: () => NeverCalledClientLayer })

      const { exit } = yield* runCommand(command, [
        "--base-url",
        "https://not-atlassian.example",
        "--space",
        "123",
        "--title",
        "New page",
        "--adf",
        "does-not-matter.json"
      ])

      expect(exit._tag).toBe("Failure")
      // The host allowlist rejected it, rather than the run getting as far as
      // reading the ADF file and failing there for an unrelated reason.
      expect(JSON.stringify(exit)).toContain("Invalid Confluence URL")
    }))

  // `--space` goes straight through as the v2 `spaceId` and nothing resolves a
  // key to an id, so a key produces a remote 400 — after the ADF file has been
  // read and validated, with nothing pointing at the flag as the cause.
  it.effect("rejects a space key before reading the ADF file", () =>
    Effect.gen(function*() {
      const command = makePageCreateCommand({ makeClientLayer: () => NeverCalledClientLayer })

      const { exit } = yield* runCommand(command, [
        "--base-url",
        "https://example.atlassian.net",
        "--space",
        "PROJ",
        "--title",
        "New page",
        "--adf",
        "does-not-matter.json"
      ])

      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("numeric space id")
    }))

  // A trimmed-empty name matches no `{{name}}`, so the substitution silently
  // never happens and the unfilled slot is written to Confluence verbatim.
  it.effect("rejects a --set whose name is only whitespace", () =>
    Effect.gen(function*() {
      const command = makePageCreateCommand({ makeClientLayer: () => NeverCalledClientLayer })

      const { exit } = yield* runCommand(command, [
        "--base-url",
        "https://example.atlassian.net",
        "--space",
        "123",
        "--title",
        "New page",
        "--adf",
        "does-not-matter.json",
        "--set",
        " =value"
      ])

      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("Expected name=value")
    }))
})

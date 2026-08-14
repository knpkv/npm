/**
 * `folder get`, `folder children` and `folder create`.
 *
 * Folders are containers with no body, so none of the page commands address
 * them: `/pages/{id}` 404s on a folder id and vice versa. Release-style layouts
 * put a folder per release above the pages, which is why creating one and
 * listing what is already inside it need to be scriptable.
 *
 * @internal
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Command, Flag as Options } from "effect/unstable/cli"
import { ConfluenceClient, type ConfluenceClientConfig, layer as ConfluenceClientLayer } from "../ConfluenceClient.js"
import { ConfigError } from "../ConfluenceError.js"
import { validateBaseUrl } from "./pageInput.js"
import { assertSiteMatchesAuth, getAuth, originOf } from "./shared.js"

const makeClientLayer = (clientConfig: ConfluenceClientConfig) =>
  ConfluenceClientLayer(clientConfig).pipe(Layer.provide(NodeHttpClient.layerFetch))

const optionValue = (option: Option.Option<string>): string | undefined =>
  Option.isSome(option) ? option.value : undefined

/**
 * Pull the folder id out of a Confluence folder URL.
 *
 * Folder URLs look like
 * `https://site.atlassian.net/wiki/spaces/<key>/folder/<id>/<slug>`. Accepting
 * them matters because a folder id is otherwise invisible — it appears in no
 * page's front-matter, and `getConfluencePage` 404s on it, so the URL bar is
 * where people actually get it from.
 *
 * Returns `undefined` when `input` carries no folder segment, so callers can
 * fall through to treating it as a bare id.
 *
 * @category Utilities
 */
export const folderIdFromUrl = (input: string): string | undefined => {
  const match = /\/folder\/(\d+)(?:[/?#]|$)/.exec(input)
  return match?.[1]
}

/**
 * Pull a container id out of a `--parent` value.
 *
 * A folder's parent may be a page or another folder, and both are pasted as
 * URLs, so read the id out of either shape. Returns `undefined` for anything
 * else — a whole URL sent as `parentId` comes back as an opaque 400.
 *
 * @category Utilities
 */
export const parentIdFromInput = (input: string): string | undefined => {
  const trimmed = input.trim()
  const match = /\/(?:folder|pages)\/(\d+)(?:[/?#]|$)/.exec(trimmed)
  if (match?.[1] !== undefined) return match[1]
  return isBareId(trimmed) ? trimmed : undefined
}

/** A value that names no site at all, so `--base-url` is the only site input. */
const isBareId = (input: string): boolean => /^\d+$/.test(input.trim())

/**
 * Refuse a URL-shaped value whose site cannot be read.
 *
 * The id patterns match on the path alone, so `site.atlassian.net/wiki/.../pages/5`
 * — a URL pasted without its scheme — yields an id while `originOf` yields
 * nothing. Treating that as a bare id would silently skip the site comparison,
 * which is the one check standing between a pasted link and a write to the
 * wrong site.
 */
const originOfContentInput = (input: string, flag: string): Effect.Effect<string | undefined, ConfigError> => {
  if (isBareId(input)) return Effect.succeed(undefined)
  const origin = originOf(input)
  return origin !== undefined ? Effect.succeed(origin) : Effect.fail(
    new ConfigError({
      message: `Could not read the site from ${flag} ${JSON.stringify(input)}. ` +
        `Include the scheme (https://…) so the site can be checked, or pass the bare numeric id.`
    })
  )
}

/**
 * Resolve `--parent` to an id, refusing one pasted from another site.
 *
 * Content ids are per-site, so a parent URL from site A applied against site B
 * does not fail — it nests the new folder under whatever id `A`'s number happens
 * to name on `B`. Same reasoning as `resolveFolderTarget`'s origin check, and it
 * matters more here because this path writes.
 */
export const resolveParentId = (input: string, baseUrl: string): Effect.Effect<string, ConfigError> =>
  Effect.gen(function*() {
    const parentId = parentIdFromInput(input)
    if (parentId === undefined) {
      return yield* Effect.fail(
        new ConfigError({
          message: `Could not read a parent id from --parent ${JSON.stringify(input)}. ` +
            `Expected a numeric id or a URL containing /pages/<id>/ or /folder/<id>/.`
        })
      )
    }
    const parentOrigin = yield* originOfContentInput(input, "--parent")
    const targetOrigin = originOf(baseUrl)
    if (parentOrigin !== undefined && targetOrigin !== undefined && parentOrigin !== targetOrigin) {
      return yield* Effect.fail(
        new ConfigError({
          message: `--parent names ${parentOrigin} but the folder would be created on ${targetOrigin}. ` +
            `Content ids are per-site, so this would nest under an unrelated container. ` +
            `Pass a parent from ${targetOrigin}, or its bare id if that is what you meant.`
        })
      )
    }
    return parentId
  })

const folderIdFrom = (raw: string): Effect.Effect<string, ConfigError> => {
  const fromUrl = folderIdFromUrl(raw)
  if (fromUrl !== undefined) return Effect.succeed(fromUrl)
  if (/^\d+$/.test(raw)) return Effect.succeed(raw)
  return Effect.fail(
    new ConfigError({
      message: `Could not read a folder id from ${JSON.stringify(raw)}. ` +
        `Expected a numeric id or a URL containing /folder/<id>/.`
    })
  )
}

/**
 * Resolve `--folder-id` / `--url` / `--base-url` to a site and a folder id.
 *
 * Mirrors the page commands' input handling: either flag works, and a URL
 * pasted into `--folder-id` is accepted rather than failing on a value that
 * plainly contains the id. A folder URL carries its own site, so `--base-url`
 * is only needed alongside a bare id; a `--base-url` naming a *different* site
 * is refused rather than acting on another site's content.
 *
 * `--folder-id` together with `--url` is refused rather than silently preferring
 * one: the two can name different folders on different sites, and picking a
 * winner would act on content the caller did not ask for. `resolvePageInput`
 * rejects the same combination.
 *
 * @category Utilities
 */
export const resolveFolderTarget = (
  folderId: Option.Option<string>,
  url: Option.Option<string>,
  baseUrl: Option.Option<string>
): Effect.Effect<{ readonly baseUrl: string; readonly id: string }, ConfigError> =>
  Effect.gen(function*() {
    const folderIdRaw = optionValue(folderId)
    const urlRaw = optionValue(url)
    if (folderIdRaw !== undefined && urlRaw !== undefined) {
      return yield* Effect.fail(
        new ConfigError({ message: "Use either --url or --folder-id, not both." })
      )
    }
    const raw = folderIdRaw ?? urlRaw
    if (raw === undefined) {
      return yield* Effect.fail(new ConfigError({ message: "Pass --folder-id or --url." }))
    }
    const id = yield* folderIdFrom(raw)
    const flagBaseUrl = optionValue(baseUrl)
    const urlOrigin = yield* originOfContentInput(raw, folderIdRaw !== undefined ? "--folder-id" : "--url")

    if (urlOrigin === undefined) {
      if (flagBaseUrl === undefined) {
        return yield* Effect.fail(
          new ConfigError({ message: "Pass --base-url, or a folder URL that names the site." })
        )
      }
      return { baseUrl: yield* validateBaseUrl(flagBaseUrl), id }
    }

    const resolved = yield* validateBaseUrl(urlOrigin)
    if (flagBaseUrl !== undefined && (yield* validateBaseUrl(flagBaseUrl)) !== resolved) {
      return yield* Effect.fail(
        new ConfigError({
          message: `--base-url ${JSON.stringify(flagBaseUrl)} is a different site than the URL (${resolved}). ` +
            `The folder id belongs to the site in the URL.`
        })
      )
    }
    return { baseUrl: resolved, id }
  })

const folderIdOption = Options.string("folder-id").pipe(
  Options.withDescription("Confluence folder id (or a folder URL)"),
  Options.optional
)

const urlOption = Options.string("url").pipe(
  Options.withDescription("Confluence folder URL"),
  Options.optional
)

const baseUrlOption = Options.string("base-url").pipe(
  Options.withDescription("Confluence Cloud base URL (e.g., https://yoursite.atlassian.net)")
)

// Optional wherever a folder URL can supply the site itself.
const optionalBaseUrlOption = baseUrlOption.pipe(Options.optional)

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output as JSON"),
  Options.withDefault(false)
)

const spaceOption = Options.string("space").pipe(
  Options.withDescription("Numeric space id — the v2 API takes the id, not the space key")
)

const parentOption = Options.string("parent").pipe(
  Options.withDescription("Parent container id — a page or a folder"),
  Options.optional
)

const titleOption = Options.string("title").pipe(
  Options.withDescription("Folder title")
)

const dryRunOption = Options.boolean("dry-run").pipe(
  Options.withAlias("n"),
  Options.withDescription("Report what would change without writing to Confluence")
)

const validateSpaceId = (space: string) =>
  /^\d+$/.test(space) ? Effect.void : Effect.fail(
    new ConfigError({
      message: `--space expects the numeric space id, got ${JSON.stringify(space)}. ` +
        `Space keys are not accepted: read the id from _links or GET /wiki/api/v2/spaces?keys=${space}.`
    })
  )

export const folderGetCommand = Command.make(
  "get",
  { folderId: folderIdOption, url: urlOption, baseUrl: optionalBaseUrlOption, json: jsonOption },
  ({ baseUrl, folderId, json, url }) =>
    Effect.gen(function*() {
      // Under API-token auth the base URL is the routing input; under OAuth the
      // active profile is. Reconcile both before acting on a site.
      const { baseUrl: resolvedBaseUrl, id } = yield* resolveFolderTarget(folderId, url, baseUrl)
      const auth = yield* getAuth()
      yield* assertSiteMatchesAuth(auth, resolvedBaseUrl)

      const folder = yield* Effect.gen(function*() {
        const client = yield* ConfluenceClient
        return yield* client.getFolder(id)
      }).pipe(Effect.provide(makeClientLayer({ baseUrl: resolvedBaseUrl, auth })))

      if (json) {
        yield* Console.log(JSON.stringify(folder, null, 2))
        return
      }
      yield* Console.log(`# ${folder.title} (${folder.id})`)
      yield* Console.log(`type: ${folder.type ?? "-"}`)
      yield* Console.log(`status: ${folder.status ?? "-"}`)
      yield* Console.log(`parentId: ${folder.parentId ?? "-"}`)
      yield* Console.log(`spaceId: ${folder.spaceId ?? "-"}`)
      if (folder._links?.webui) yield* Console.log(`${resolvedBaseUrl}/wiki${folder._links.webui}`)
    })
).pipe(Command.withDescription("Read-only: get a Confluence folder by id"))

export const folderChildrenCommand = Command.make(
  "children",
  { folderId: folderIdOption, url: urlOption, baseUrl: optionalBaseUrlOption, json: jsonOption },
  ({ baseUrl, folderId, json, url }) =>
    Effect.gen(function*() {
      const { baseUrl: resolvedBaseUrl, id } = yield* resolveFolderTarget(folderId, url, baseUrl)
      const auth = yield* getAuth()
      yield* assertSiteMatchesAuth(auth, resolvedBaseUrl)

      const children = yield* Effect.gen(function*() {
        const client = yield* ConfluenceClient
        return yield* client.getFolderChildren(id)
      }).pipe(Effect.provide(makeClientLayer({ baseUrl: resolvedBaseUrl, auth })))

      if (json) {
        yield* Console.log(JSON.stringify(children, null, 2))
        return
      }
      if (children.length === 0) {
        yield* Console.log("(empty)")
        return
      }
      const sep = "  "
      yield* Console.log(["type", "id", "title"].join(sep))
      for (const child of children) {
        yield* Console.log([child.type ?? "-", child.id, child.title ?? "-"].join(sep))
      }
    })
).pipe(
  Command.withDescription(
    "Read-only: list a folder's direct children (pages, sub-folders, whiteboards, databases)"
  )
)

export const folderCreateCommand = Command.make(
  "create",
  {
    baseUrl: baseUrlOption,
    space: spaceOption,
    parent: parentOption,
    title: titleOption,
    json: jsonOption,
    dryRun: dryRunOption
  },
  ({ baseUrl, dryRun, json, parent, space, title }) =>
    Effect.gen(function*() {
      const resolvedBaseUrl = yield* validateBaseUrl(baseUrl)
      yield* validateSpaceId(space)

      // A parent may be given as a URL too — the id of the page or folder you
      // are nesting under comes from the same place as any other content id.
      const parentRaw = optionValue(parent)
      const parentId = parentRaw === undefined ? undefined : yield* resolveParentId(parentRaw, resolvedBaseUrl)

      // Resolve auth before the dry-run exit so the preview exercises the same
      // site checks as the write. The wrong-site case is the one a dry run is
      // for: under OAuth `--base-url` is ignored, so a preview that skipped this
      // would report a create the real run then refuses.
      const auth = yield* getAuth()
      yield* assertSiteMatchesAuth(auth, resolvedBaseUrl)

      if (dryRun) {
        yield* Console.log(
          `Would create folder "${title}" in space ${space}${parentId === undefined ? "" : ` under ${parentId}`}.`
        )
        return
      }

      const created = yield* Effect.gen(function*() {
        const client = yield* ConfluenceClient
        return yield* client.createFolder({
          spaceId: space,
          title,
          ...(!(parentId === undefined) && { parentId })
        })
      }).pipe(Effect.provide(makeClientLayer({ baseUrl: resolvedBaseUrl, auth })))

      if (json) {
        yield* Console.log(JSON.stringify(created, null, 2))
        return
      }
      yield* Console.log(`Created folder ${created.title} (${created.id})`)
      if (created._links?.webui) yield* Console.log(`${resolvedBaseUrl}/wiki${created._links.webui}`)
    })
).pipe(Command.withDescription("Create a Confluence folder under a page or another folder"))

export const folderCommand = Command.make(
  "folder",
  {},
  () => Console.log("Usage: confluence folder get|children|create")
).pipe(
  Command.withDescription("Confluence folder resource commands"),
  Command.withSubcommands([folderGetCommand, folderChildrenCommand, folderCreateCommand])
)

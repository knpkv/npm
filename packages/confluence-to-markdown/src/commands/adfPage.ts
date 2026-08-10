/**
 * Raw ADF page commands: `page create`, `page put` and `page patch`.
 *
 * All three write a page without ever going through the markdown projection. That
 * projection is lossy for datasource cards and extensions, so a page holding
 * one cannot be edited via `sync push` without corruption — these commands are
 * the supported way to change such a page, down to a one-word fix.
 *
 * @internal
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import { Command, Flag as Options } from "effect/unstable/cli"
import { AdfSchemaValidator } from "../AdfSchemaValidator.js"
import { PageId } from "../Brand.js"
import { ConfluenceClient, type ConfluenceClientConfig, layer as ConfluenceClientLayer } from "../ConfluenceClient.js"
import { ConfigError, FileSystemError } from "../ConfluenceError.js"
import { deleteAdfNodes, parseNodeSelector, replaceAdfText, structuralCensusDelta } from "../internal/adfNodes.js"
import { baseUrlFromWorkspace, resolvePageInputWithWorkspace, validateBaseUrl } from "./pageInput.js"
import { getAuth } from "./shared.js"

const urlOption = Options.string("url").pipe(
  Options.withDescription("Confluence page URL"),
  Options.optional
)

const pageIdOption = Options.string("page-id").pipe(
  Options.withDescription("Confluence page ID"),
  Options.optional
)

const baseUrlOption = Options.string("base-url").pipe(
  Options.withDescription("Confluence Cloud base URL (e.g., https://yoursite.atlassian.net)"),
  Options.optional
)

const adfOption = Options.file("adf").pipe(
  Options.withDescription("Path to the ADF document (JSON) to write")
)

const titleOption = Options.string("title").pipe(
  Options.withDescription("New page title (defaults to the current title)"),
  Options.optional
)

/**
 * Opt in to the same optimistic-concurrency check `page patch` always makes.
 *
 * `page put` writes onto whatever the current version is, which is right for a
 * body authored offline. It is wrong for the read-modify-write the
 * round-trip-unsafe refusal recommends — `page get --format adf > page.json`,
 * edit, `page put --adf page.json` — where an edit made in Confluence in
 * between would be overwritten with no conflict. Pass the version the file was
 * read at and a concurrent edit surfaces as a 409 instead.
 */
const ifVersionOption = Options.integer("if-version").pipe(
  Options.withDescription("Fail with a conflict unless the page is still at this version"),
  Options.optional
)

const messageOption = Options.string("message").pipe(
  Options.withAlias("m"),
  Options.withDescription("Version message recorded on the update"),
  Options.optional
)

const dryRunOption = Options.boolean("dry-run").pipe(
  Options.withAlias("n"),
  Options.withDescription("Report what would change without writing to Confluence")
)

const replaceOption = Options.string("replace").pipe(
  Options.withDescription("Literal text to find in the page's text nodes"),
  Options.optional
)

const withOption = Options.string("with").pipe(
  Options.withDescription("Replacement text for --replace"),
  Options.optional
)

const deleteNodeOption = Options.string("delete-node").pipe(
  Options.withDescription("Delete nodes matching a `type` or `type[index]` selector, e.g. blockCard[1]"),
  Options.optional
)

const setOption = Options.string("set").pipe(
  Options.withDescription(
    "Template substitution `name=value`, replacing every {{name}} in the ADF file (repeatable)"
  ),
  Options.atLeast(0)
)

const optionValue = (option: Option.Option<string>): string | undefined =>
  Option.isSome(option) ? option.value : undefined

/**
 * Substitute `{{name}}` slots in a raw ADF document.
 *
 * Applied to the JSON *text* before parsing so a slot can stand anywhere — a
 * text run, a `jql` string, a timestamp, a url. Values are JSON-escaped so a
 * quote or backslash in a release name cannot break the document.
 */
export const applyAdfTemplate = (
  raw: string,
  values: ReadonlyMap<string, string>
): { readonly rendered: string; readonly unresolved: ReadonlyArray<string> } => {
  const escape = (value: string): string => JSON.stringify(value).slice(1, -1)
  // Collect the slots from the *template*, before substitution. Scanning the
  // rendered text instead cannot tell a slot the author wrote from brace-brace
  // text inside a value — a title like `Use {{status}} macro` would be
  // reported as an unfilled `status` the user never declared.
  const declared = new Set([...raw.matchAll(/\{\{([A-Za-z0-9_.-]+)\}\}/g)].map(([, name]) => name!))
  // One pass over the *template*, for the same reason `declared` is collected
  // from it: substituting each value in turn re-scans text an earlier value
  // introduced, so `--set title='Release {{version}}' --set version=96` would
  // write `Release 96` instead of the literal the user passed.
  const rendered = raw.replace(
    /\{\{([A-Za-z0-9_.-]+)\}\}/g,
    (slot, name: string) => values.has(name) ? escape(values.get(name)!) : slot
  )
  const unresolved = [...declared].filter((name) => !values.has(name))
  return { rendered, unresolved }
}

const parseSetFlags = (entries: ReadonlyArray<string>): Effect.Effect<ReadonlyMap<string, string>, ConfigError> =>
  Effect.gen(function*() {
    const values = new Map<string, string>()
    for (const entry of entries) {
      const separator = entry.indexOf("=")
      // Validate the *trimmed* name against the placeholder grammar, not just
      // the separator position: `--set " =value"` trims to an empty key that
      // matches no `{{name}}`, so the substitution silently never happens and
      // the slot the user meant to fill is written to Confluence verbatim.
      const name = separator < 0 ? "" : entry.slice(0, separator).trim()
      if (separator < 0 || !/^[A-Za-z0-9_.-]+$/.test(name)) {
        return yield* Effect.fail(
          new ConfigError({ message: `Invalid --set ${JSON.stringify(entry)}. Expected name=value.` })
        )
      }
      values.set(name, entry.slice(separator + 1))
    }
    return values
  })

const readAdfFile = (path: string, values: ReadonlyMap<string, string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const raw = yield* fs.readFileString(path).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "read", path, cause }))
    )
    const { rendered, unresolved } = applyAdfTemplate(raw, values)
    if (unresolved.length > 0) {
      return yield* Effect.fail(
        new ConfigError({
          message: `${path} still has unfilled slots: ${
            unresolved.map((n) => `{{${n}}}`).join(", ")
          }. Pass them with --set name=value.`
        })
      )
    }
    return yield* parseAdf(rendered, path, "outgoing")
  })

/**
 * `direction` is not cosmetic: `AdfSchemaError` prints it, and it is the only
 * signal separating "Confluence handed us a document we cannot model"
 * (`incoming`) from "the document you are about to write is invalid"
 * (`outgoing`). A page read for `page patch` must report the former, or the
 * user goes looking for a mistake in their own edit.
 */
const parseAdf = (raw: string, source: string, direction: "incoming" | "outgoing") =>
  Effect.gen(function*() {
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(raw),
      catch: () => new ConfigError({ message: `${source} is not valid JSON.` })
    })
    const validator = yield* AdfSchemaValidator
    return yield* validator.check(parsed, direction)
  })

const makeDefaultClientLayer = (clientConfig: ConfluenceClientConfig) =>
  ConfluenceClientLayer(clientConfig).pipe(Layer.provide(NodeHttpClient.layerFetch))

/**
 * The `--if-version` check, shared by the write and its preview so the two
 * cannot disagree about whether a page has moved on.
 */
const checkExpectedVersion = (
  pageId: PageId,
  current: number,
  expected: number | undefined
): Effect.Effect<void, ConfigError> =>
  expected === undefined || expected === current ? Effect.void : Effect.fail(
    new ConfigError({
      message: `Page ${pageId} is at version ${current}, not ${expected}. ` +
        `Someone edited it since you read it — re-read it before writing, or drop --if-version to overwrite.`
    })
  )

/**
 * The page a read-modify-write was derived from.
 *
 * Threading it through is what keeps Confluence's optimistic-version check
 * meaningful: refetching at write time would number the update one ahead of a
 * *concurrent* edit, so the write would be accepted and silently erase it.
 */
interface PageBase {
  readonly version: number
  readonly title: string
}

/**
 * Write an ADF document to a page, bumping the version.
 *
 * Confluence rejects an update whose version is not exactly one ahead, which is
 * what makes a blind retry after a timeout return 409 rather than double-write.
 * That check only protects a caller that numbers the write from the read its
 * content came from: `base` for a read-modify-write such as `page patch`,
 * otherwise a fresh read here (`page put`, whose body is authored offline and
 * is meant to land on whatever the current version is).
 *
 * `expectedVersion` is how `page put --if-version` opts into the same
 * protection: the fresh read still happens, but a page that has moved on since
 * the caller read it fails here instead of silently overwriting that edit.
 */
const putAdf = (
  pageId: PageId,
  adfValue: string,
  options: {
    readonly title?: string | undefined
    readonly message?: string | undefined
    readonly base?: PageBase | undefined
    readonly expectedVersion?: number | undefined
  }
) =>
  Effect.gen(function*() {
    const client = yield* ConfluenceClient
    const current = options.base ?? (yield* Effect.map(
      client.getPage(pageId),
      (page): PageBase => ({ version: page.version.number, title: page.title })
    ))
    yield* checkExpectedVersion(pageId, current.version, options.expectedVersion)
    return yield* client.updatePage({
      id: pageId,
      title: options.title ?? current.title,
      status: "current",
      version: {
        number: current.version + 1,
        ...(options.message === undefined ? {} : { message: options.message })
      },
      body: { representation: "atlas_doc_format", value: adfValue }
    })
  })

const reportStructuralDrift = (before: unknown, after: unknown) =>
  Effect.gen(function*() {
    const deltas = structuralCensusDelta(before, after)
    if (deltas.length === 0) return
    yield* Console.log("Structural node changes:")
    for (const delta of deltas) {
      yield* Console.log(`  ${delta.type}: ${delta.before} -> ${delta.after}`)
    }
  })

export interface AdfPageCommandOptions {
  readonly makeClientLayer?: (config: ConfluenceClientConfig) => Layer.Layer<ConfluenceClient>
}

export const makePagePutCommand = (options: AdfPageCommandOptions = {}) => {
  const makeClientLayer = options.makeClientLayer ?? makeDefaultClientLayer

  return Command.make(
    "put",
    {
      url: urlOption,
      pageId: pageIdOption,
      baseUrl: baseUrlOption,
      adf: adfOption,
      title: titleOption,
      message: messageOption,
      ifVersion: ifVersionOption,
      set: setOption,
      dryRun: dryRunOption
    },
    ({ adf, baseUrl, dryRun, ifVersion, message, pageId, set, title, url }) =>
      Effect.gen(function*() {
        const input = yield* resolvePageInputWithWorkspace({
          url: optionValue(url),
          pageId: optionValue(pageId),
          baseUrl: optionValue(baseUrl)
        })
        const doc = yield* readAdfFile(adf, yield* parseSetFlags(set))
        const expected = Option.isSome(ifVersion) ? ifVersion.value : undefined

        // A plain dry run stays offline, but `--if-version` is a *check*, and a
        // preview that skips it reports the write would succeed at the exact
        // moment the real command refuses — misleading precisely for the
        // concurrency-safe workflow the flag exists to support.
        if (dryRun) {
          if (expected !== undefined) {
            const auth = yield* getAuth()
            yield* Effect.gen(function*() {
              const client = yield* ConfluenceClient
              const page = yield* client.getPage(PageId(input.pageId))
              yield* checkExpectedVersion(PageId(input.pageId), page.version.number, expected)
            }).pipe(Effect.provide(makeClientLayer({ baseUrl: input.baseUrl, auth })))
          }
          yield* Console.log(`Would write ${adf} to page ${input.pageId} (${input.baseUrl}).`)
          return
        }

        const auth = yield* getAuth()
        const clientLayer = makeClientLayer({ baseUrl: input.baseUrl, auth })
        const updated = yield* putAdf(PageId(input.pageId), JSON.stringify(doc), {
          title: optionValue(title),
          message: optionValue(message),
          ...(expected === undefined ? {} : { expectedVersion: expected })
        }).pipe(Effect.provide(clientLayer))

        yield* Console.log(`Updated ${updated.title} -> version ${updated.version.number}`)
        if (updated._links?.webui) {
          yield* Console.log(`${input.baseUrl}/wiki${updated._links.webui}`)
        }
      })
  ).pipe(
    Command.withDescription(
      "Write a raw ADF document to a page. Use for pages the markdown round-trip cannot represent."
    )
  )
}

export const makePagePatchCommand = (options: AdfPageCommandOptions = {}) => {
  const makeClientLayer = options.makeClientLayer ?? makeDefaultClientLayer

  return Command.make(
    "patch",
    {
      url: urlOption,
      pageId: pageIdOption,
      baseUrl: baseUrlOption,
      replace: replaceOption,
      with: withOption,
      deleteNode: deleteNodeOption,
      message: messageOption,
      dryRun: dryRunOption
    },
    ({ baseUrl, deleteNode, dryRun, message, pageId, replace, url, with: withText }) =>
      Effect.gen(function*() {
        const search = optionValue(replace)
        const replacement = optionValue(withText)
        const selector = optionValue(deleteNode)

        if (search !== undefined && replacement === undefined) {
          return yield* Effect.fail(new ConfigError({ message: "--replace requires --with." }))
        }
        if (search === undefined && replacement !== undefined) {
          return yield* Effect.fail(new ConfigError({ message: "--with requires --replace." }))
        }
        if (search === undefined && selector === undefined) {
          return yield* Effect.fail(
            new ConfigError({ message: "Nothing to do: pass --replace/--with or --delete-node." })
          )
        }
        // `includes("")` is true of every string and `replaceAll("", x)` splices
        // x between every character, so an empty search would rewrite the whole
        // page. An empty --with stays valid: that is how you delete matched text.
        if (search !== undefined && search.length === 0) {
          return yield* Effect.fail(
            new ConfigError({ message: "--replace needs a non-empty search string." })
          )
        }

        const input = yield* resolvePageInputWithWorkspace({
          url: optionValue(url),
          pageId: optionValue(pageId),
          baseUrl: optionValue(baseUrl)
        })
        const auth = yield* getAuth()
        const clientLayer = makeClientLayer({ baseUrl: input.baseUrl, auth })
        const id = PageId(input.pageId)

        const source = yield* Effect.gen(function*() {
          const client = yield* ConfluenceClient
          const page = yield* client.getPage(id)
          const raw = page.body?.atlas_doc_format?.value
          if (!raw) {
            return yield* Effect.fail(new ConfigError({ message: `Page ${id} did not include ADF content.` }))
          }
          const parsed = yield* parseAdf(raw, `page ${id}`, "incoming")
          return { doc: parsed, base: { version: page.version.number, title: page.title } }
        }).pipe(Effect.provide(clientLayer))

        const original = source.doc
        let doc: unknown = original

        if (search !== undefined && replacement !== undefined) {
          const result = replaceAdfText(doc, search, replacement)
          if (result.replacements === 0) {
            return yield* Effect.fail(
              new ConfigError({
                message: `No text node contains ${JSON.stringify(search)}. ADF splits a run at every mark boundary, ` +
                  `so a phrase crossing inline code or bold lives in several nodes — match a shorter span.`
              })
            )
          }
          yield* Console.log(`Replaced ${result.replacements} occurrence(s).`)
          doc = result.doc
        }

        if (selector !== undefined) {
          const parsed = parseNodeSelector(selector)
          if (parsed === null) {
            return yield* Effect.fail(
              new ConfigError({ message: `Invalid --delete-node selector: ${selector}. Expected type or type[index].` })
            )
          }
          const result = deleteAdfNodes(doc, parsed)
          if (result.deleted === 0) {
            return yield* Effect.fail(new ConfigError({ message: `No node matched ${selector}.` }))
          }
          yield* Console.log(`Deleted ${result.deleted} node(s) matching ${selector}.`)
          doc = result.doc
        }

        yield* reportStructuralDrift(original, doc)

        // Validate before the dry-run exit, so a preview exercises exactly what
        // the real write does. `--delete-node` can easily leave a document
        // Confluence rejects — an emptied `tableCell` or `bodiedExtension` —
        // and finding that out only on the real write defeats previewing a
        // destructive edit.
        const validated = yield* Effect.gen(function*() {
          const validator = yield* AdfSchemaValidator
          return yield* validator.check(doc, "outgoing")
        })

        if (dryRun) {
          yield* Console.log("Dry run — nothing written.")
          return
        }

        const updated = yield* putAdf(id, JSON.stringify(validated), {
          title: undefined,
          message: optionValue(message),
          // The version this patch was derived from — a concurrent edit must
          // surface as a 409, not be overwritten.
          base: source.base
        }).pipe(Effect.provide(clientLayer))

        yield* Console.log(`Updated ${updated.title} -> version ${updated.version.number}`)
      })
  ).pipe(
    Command.withDescription("Edit a page at the ADF level without a markdown round-trip")
  )
}

const spaceOption = Options.string("space").pipe(
  Options.withDescription("Numeric space id — the v2 API takes the id, not the space key")
)

/**
 * `createPage` sends this straight through as the v2 `spaceId`, and nothing
 * here resolves a key to an id. Catching a key locally turns a remote 400 —
 * raised only after the ADF file has been read and validated — into an
 * immediate message that says what to pass instead.
 */
const validateSpaceId = (space: string) =>
  /^\d+$/.test(space) ? Effect.void : Effect.fail(
    new ConfigError({
      message: `--space expects the numeric space id, got ${JSON.stringify(space)}. ` +
        `Space keys are not accepted: read the id from _links or GET /wiki/api/v2/spaces?keys=${space}.`
    })
  )

const parentOption = Options.string("parent").pipe(
  Options.withDescription("Parent container id — a page or a folder"),
  Options.optional
)

const createTitleOption = Options.string("title").pipe(
  Options.withDescription("Title for the new page")
)

const createBaseUrlOption = Options.string("base-url").pipe(
  Options.withDescription("Confluence Cloud base URL (e.g., https://yoursite.atlassian.net)"),
  Options.optional
)

/**
 * Create a page from a raw ADF document.
 *
 * The counterpart to `page put`. `page new` only drafts a markdown file inside
 * a cloned workspace, so before this there was no way to create a page whose
 * content markdown cannot express — which is every release-notes page carrying
 * a Jira issues table.
 */
export const makePageCreateCommand = (options: AdfPageCommandOptions = {}) => {
  const makeClientLayer = options.makeClientLayer ?? makeDefaultClientLayer

  return Command.make(
    "create",
    {
      baseUrl: createBaseUrlOption,
      space: spaceOption,
      parent: parentOption,
      title: createTitleOption,
      adf: adfOption,
      set: setOption,
      dryRun: dryRunOption
    },
    ({ adf, baseUrl, dryRun, parent, set, space, title }) =>
      Effect.gen(function*() {
        // Resolve the target before reading anything: the flag goes through
        // validateBaseUrl like every other entry point, because the client
        // sends `Authorization: Basic <email:apiToken>` to whatever origin it
        // is given, so an unchecked --base-url leaks the API token to an
        // arbitrary host. The workspace branch validates on its own.
        const baseUrlFlag = optionValue(baseUrl)
        const resolvedBaseUrl = baseUrlFlag === undefined
          ? yield* baseUrlFromWorkspace((yield* Path.Path).resolve("."))
          : yield* validateBaseUrl(baseUrlFlag)
        if (resolvedBaseUrl === undefined) {
          return yield* Effect.fail(
            new ConfigError({
              message: "--base-url is required (or run inside a cloned workspace)."
            })
          )
        }

        yield* validateSpaceId(space)

        const doc = yield* readAdfFile(adf, yield* parseSetFlags(set))

        if (dryRun) {
          yield* Console.log(`Would create "${title}" in space ${space} from ${adf}.`)
          return
        }

        const auth = yield* getAuth()
        const parentId = optionValue(parent)
        const created = yield* Effect.gen(function*() {
          const client = yield* ConfluenceClient
          const page = yield* client.createPage({
            spaceId: space,
            title,
            ...(parentId === undefined ? {} : { parentId }),
            body: { representation: "atlas_doc_format", value: JSON.stringify(doc) }
          })
          // Same follow-up `SyncEngine.pushFile` makes after every create: an
          // ADF-bodied page without the v2 marker can open in the legacy
          // editor, which is the corruption these commands exist to avoid.
          // Non-fatal, as there — the page itself is already written.
          yield* client.setEditorVersion(PageId(page.id), "v2").pipe(
            Effect.catchIf(() => true, (error) =>
              Effect.logWarning(`Failed to set editor v2 for page ${page.id}: ${error.message}`))
          )
          return page
        }).pipe(Effect.provide(makeClientLayer({ baseUrl: resolvedBaseUrl, auth })))

        yield* Console.log(`Created ${created.title} (${created.id})`)
        if (created._links?.webui) {
          yield* Console.log(`${resolvedBaseUrl}/wiki${created._links.webui}`)
        }
      })
  ).pipe(
    Command.withDescription("Create a page from a raw ADF document, with optional {{slot}} substitution")
  )
}

export const pagePutCommand = makePagePutCommand()
export const pagePatchCommand = makePagePatchCommand()
export const pageCreateCommand = makePageCreateCommand()

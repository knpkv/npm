/**
 * `confluence search --cql` — run a CQL query.
 *
 * CQL is the only way to find content by title or by parent: there is no
 * "children of X by title" endpoint, and folder ids are not discoverable from
 * page metadata. Kept at the top level rather than under `page` because CQL
 * matches any content type, folders and whiteboards included.
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
import type { CqlSearchHit } from "../Schemas.js"
import { validateBaseUrl } from "./pageInput.js"
import { assertSiteMatchesAuth, getAuth } from "./shared.js"

const makeClientLayer = (clientConfig: ConfluenceClientConfig) =>
  ConfluenceClientLayer(clientConfig).pipe(Layer.provide(NodeHttpClient.layerFetch))

const cqlOption = Options.string("cql").pipe(
  Options.withDescription(
    "CQL query, e.g. 'title ~ \"OOB 98\" AND type = page' or 'parent = 12345 AND type = page'"
  )
)

const baseUrlOption = Options.string("base-url").pipe(
  Options.withDescription("Confluence Cloud base URL (e.g., https://yoursite.atlassian.net)")
)

const limitOption = Options.integer("limit").pipe(
  Options.withDescription("Maximum number of results (default: Confluence's own, 25)"),
  Options.optional
)

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output as JSON"),
  Options.withDefault(false)
)

/**
 * The human-readable lines for one page of CQL hits.
 *
 * Pure so the reporting rules can be tested without a client: the command builds
 * its own layer from `--base-url`, which leaves no seam to inject one.
 *
 * The rule that matters is that an empty *page* is not an empty *result set* —
 * `--limit 0` returns no rows alongside a positive `totalSize`, and answering
 * "(no results)" there tells the caller the opposite of the truth.
 *
 * @category Utilities
 */
export const searchOutputLines = (
  response: { readonly results: ReadonlyArray<CqlSearchHit>; readonly totalSize?: number | undefined }
): ReadonlyArray<string> => {
  const hits = response.results
  const total = response.totalSize
  if (hits.length === 0) {
    return [
      total !== undefined && total > 0
        ? `${total} match(es), none shown — raise --limit`
        : "(no results)"
    ]
  }
  const sep = "  "
  const rows = hits.map((hit) =>
    [hit.content?.type ?? hit.entityType ?? "-", hit.content?.id ?? "-", hit.title].join(sep)
  )
  // One page only, so say when Confluence has more: a truncated list read as
  // complete sends a caller down the wrong branch.
  const more = total !== undefined && total > hits.length
    ? [`showing ${hits.length} of ${total} — raise --limit for more`]
    : []
  return [["type", "id", "title"].join(sep), ...rows, ...more]
}

export const searchCommand = Command.make(
  "search",
  { cql: cqlOption, baseUrl: baseUrlOption, limit: limitOption, json: jsonOption },
  ({ baseUrl, cql, json, limit }) =>
    Effect.gen(function*() {
      // Under API-token auth the base URL is the routing input; under OAuth the
      // active profile is. Reconcile both before acting on a site.
      const resolvedBaseUrl = yield* validateBaseUrl(baseUrl)
      const auth = yield* getAuth()
      yield* assertSiteMatchesAuth(auth, resolvedBaseUrl)

      const response = yield* Effect.gen(function*() {
        const client = yield* ConfluenceClient
        return yield* client.searchByCql(cql, Option.isSome(limit) ? { limit: limit.value } : undefined)
      }).pipe(Effect.provide(makeClientLayer({ baseUrl: resolvedBaseUrl, auth })))

      if (json) {
        yield* Console.log(JSON.stringify(response, null, 2))
        return
      }
      for (const line of searchOutputLines(response)) {
        yield* Console.log(line)
      }
    })
).pipe(Command.withDescription("Read-only: search Confluence content with CQL"))

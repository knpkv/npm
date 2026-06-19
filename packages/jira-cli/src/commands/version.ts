/**
 * `jira version` command — list / view Jira project versions (releases) with
 * Driver, Contributors and Approver fields resolved to display names, plus
 * mutations: edit the description and manage "Related work" links (the
 * Confluence pages surfaced on a release report).
 *
 * @internal
 */
import { Args, Command, Options } from "@effect/cli"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { JiraApiError } from "../JiraCliError.js"
import { VersionService } from "../VersionService.js"

/**
 * Jira version ids are numeric (e.g. `10042`). Passing a name/key 404s with an
 * opaque error, so validate early and emit a hint pointing at `version list`.
 */
const ensureNumericId = (id: string): Effect.Effect<void, JiraApiError> =>
  /^\d+$/.test(id)
    ? Effect.void
    : Effect.fail(
      new JiraApiError({
        message: `Invalid version id "${id}". The version id is numeric (e.g. 10042); ` +
          `use 'jira version list --project <KEY>' to find it.`
      })
    )

const projectOption = Options.text("project").pipe(
  Options.withAlias("p"),
  Options.withDescription("Jira project key (e.g. RPS)")
)
const releasedOption = Options.boolean("released").pipe(
  Options.withDescription("Only list released versions"),
  Options.withDefault(false)
)
const unreleasedOption = Options.boolean("unreleased").pipe(
  Options.withDescription("Only list unreleased versions"),
  Options.withDefault(false)
)
const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output as JSON"),
  Options.withDefault(false)
)
const customFieldOption = Options.text("custom-field").pipe(
  Options.withDescription(
    "Custom field display name to include on each ticket (repeatable, e.g. " +
      "--custom-field \"Security & Compliance Impact\"). Values are exposed in " +
      "ticket.customFields[<name>]."
  ),
  Options.repeated
)
const maxOption = Options.integer("max").pipe(
  Options.withAlias("m"),
  Options.withDescription("Maximum number of versions to fetch (default: all)"),
  Options.optional
)

const idArg = Args.text({ name: "id" }).pipe(Args.withDescription("Version id (numeric)"))

const listCommand = Command.make("list", {
  project: projectOption,
  released: releasedOption,
  unreleased: unreleasedOption,
  customFields: customFieldOption,
  max: maxOption,
  json: jsonOption
}, ({ customFields, json, max, project, released, unreleased }) =>
  Effect.gen(function*() {
    if (released && unreleased) {
      return yield* Effect.fail(
        new JiraApiError({
          message: "--released and --unreleased are mutually exclusive; pass at most one (omit both to list all)."
        })
      )
    }
    const service = yield* VersionService
    const versions = yield* service.listProjectVersions(project, {
      released,
      unreleased,
      ...(Option.isSome(max) ? { maxResults: max.value } : {}),
      customFieldNames: customFields
    })
    if (json) {
      yield* Console.log(JSON.stringify(versions, null, 2))
      return
    }
    const sep = "  "
    yield* Console.log(["id", "name", "released", "releaseDate", "driver", "contributors", "approvers"].join(sep))
    for (const v of versions) {
      yield* Console.log([
        v.id,
        v.name,
        String(v.released),
        v.releaseDate ?? "-",
        v.driver?.displayName ?? "-",
        v.contributors.map((c) => c.displayName).join("|") || "-",
        v.approvers.map((a) => `${a.person.displayName}:${a.status}`).join("|") || "-"
      ].join(sep))
    }
  })).pipe(Command.withDescription("List versions for a Jira project"))

const viewCommand = Command.make("view", { id: idArg, json: jsonOption }, ({ id, json }) =>
  Effect.gen(function*() {
    yield* ensureNumericId(id)
    const service = yield* VersionService
    const version = yield* service.getVersion(id)
    if (json) {
      // TODO(review #24): `version` here includes Person.emailAddress (PII) in the
      // JSON. Deferred: gate behind a --emails flag before emitting by default.
      yield* Console.log(JSON.stringify(version, null, 2))
      return
    }
    yield* Console.log(`# ${version.name} (${version.id})`)
    yield* Console.log(`released: ${version.released}`)
    yield* Console.log(`releaseDate: ${version.releaseDate ?? "-"}`)
    yield* Console.log(`driver: ${version.driver?.displayName ?? "-"}`)
    yield* Console.log(`contributors: ${version.contributors.map((c) => c.displayName).join(", ") || "-"}`)
    yield* Console.log(
      `approvers: ${version.approvers.map((a) => `${a.person.displayName}:${a.status}`).join(", ") || "-"}`
    )
    // TODO(review #28): version.tickets is collected but never surfaced in the human
    // view (only via --json). Deferred: render a ticket count/summary line here.
  })).pipe(Command.withDescription("Show a single Jira version"))

const descriptionOption = Options.text("description").pipe(
  Options.withAlias("d"),
  Options.withDescription("New version description")
)

const setCommand = Command.make("set", { id: idArg, description: descriptionOption, json: jsonOption }, ({
  description,
  id,
  json
}) =>
  Effect.gen(function*() {
    yield* ensureNumericId(id)
    const service = yield* VersionService
    const version = yield* service.updateVersion(id, { description })
    if (json) {
      yield* Console.log(JSON.stringify(version, null, 2))
      return
    }
    yield* Console.log(`Updated version ${version.name} (${version.id})`)
    yield* Console.log(`description: ${version.description ?? "-"}`)
  })).pipe(
    Command.withDescription("Update a version's description (requires manage:jira-project scope)")
  )

// === relatedwork ===

const titleOption = Options.text("title").pipe(
  Options.withAlias("t"),
  Options.withDescription("Related-work link title (e.g. \"Release notes\")")
)
const urlOption = Options.text("url").pipe(
  Options.withAlias("u"),
  Options.withDescription("Related-work link URL (e.g. a Confluence page)")
)
const categoryOption = Options.text("category").pipe(
  Options.withAlias("c"),
  Options.withDescription("Related-work category (Jira groups by this; e.g. Communication, Testing, Design)"),
  Options.withDefault("Communication")
)

const relatedWorkListCommand = Command.make(
  "list",
  { id: idArg, json: jsonOption },
  ({ id, json }) =>
    Effect.gen(function*() {
      yield* ensureNumericId(id)
      const service = yield* VersionService
      const items = yield* service.listRelatedWork(id)
      if (json) {
        yield* Console.log(JSON.stringify(items, null, 2))
        return
      }
      if (items.length === 0) {
        yield* Console.log("(no related work)")
        return
      }
      const sep = "  "
      yield* Console.log(["category", "title", "url"].join(sep))
      for (const w of items) {
        yield* Console.log([w.category || "-", w.title ?? "-", w.url ?? "-"].join(sep))
      }
    })
).pipe(Command.withDescription("List a version's related-work links"))

const relatedWorkAddCommand = Command.make("add", {
  id: idArg,
  title: titleOption,
  url: urlOption,
  category: categoryOption,
  json: jsonOption
}, ({ category, id, json, title, url }) =>
  Effect.gen(function*() {
    yield* ensureNumericId(id)
    const service = yield* VersionService
    const created = yield* service.addRelatedWork(id, { title, category, url })
    if (json) {
      yield* Console.log(JSON.stringify(created, null, 2))
      return
    }
    yield* Console.log(`Attached "${created.title ?? title}" (${created.category}) to version ${id}`)
    yield* Console.log(`url: ${created.url ?? url}`)
  })).pipe(
    Command.withDescription(
      "Attach a related-work link (e.g. a Confluence page) to a version (requires manage:jira-project scope)"
    )
  )

const relatedWorkCommand = Command.make("relatedwork").pipe(
  Command.withDescription("List or attach version related-work links (Confluence pages on the release report)"),
  Command.withSubcommands([relatedWorkListCommand, relatedWorkAddCommand])
)

export const versionCommand = Command.make("version").pipe(
  Command.withDescription("List, view, or edit Jira project versions (releases)"),
  Command.withSubcommands([listCommand, viewCommand, setCommand, relatedWorkCommand])
)

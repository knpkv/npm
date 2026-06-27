/**
 * `jira version` command — list / get Jira project versions (releases) with
 * Driver, Contributors and Approver fields resolved to display names, plus
 * mutations: edit the description and manage "Related work" links (the
 * Confluence pages surfaced on a release report).
 *
 * @internal
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli"
import { JiraApiError } from "../JiraCliError.js"
import type { Person, Version } from "../VersionService.js"
import { VersionService } from "../VersionService.js"

/**
 * Return a copy of `version` with every resolved {@link Person.emailAddress}
 * (PII) set to null — covering driver, contributors, approvers[].person and
 * tickets[].assignee. Used to keep emails out of `--json` output unless the
 * caller opts in with `--emails`.
 */
export const stripEmails = (version: Version): Version => {
  const stripPerson = <P extends Person>(person: P): P => ({ ...person, emailAddress: null })
  return {
    ...version,
    driver: version.driver ? stripPerson(version.driver) : null,
    contributors: version.contributors.map(stripPerson),
    approvers: version.approvers.map((a) => ({ ...a, person: stripPerson(a.person) })),
    tickets: version.tickets.map((t) => ({
      ...t,
      assignee: t.assignee ? stripPerson(t.assignee) : null
    }))
  }
}

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

const projectOption = Options.string("project").pipe(
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
const emailsOption = Options.boolean("emails").pipe(
  Options.withDescription("Include resolved user email addresses in --json output"),
  Options.withDefault(false)
)
const customFieldOption = Options.string("custom-field").pipe(
  Options.withDescription(
    "Custom field display name to include on each ticket (repeatable, e.g. " +
      "--custom-field \"Security & Compliance Impact\"). Values are exposed in " +
      "ticket.customFields[<name>]."
  ),
  Options.atLeast(0)
)
const maxOption = Options.integer("max").pipe(
  Options.withAlias("m"),
  Options.withDescription("Maximum number of versions to fetch (default: all)"),
  Options.optional
)

const idArg = Args.string("id").pipe(Args.withDescription("Version id (numeric)"))

const listCommand = Command.make("list", {
  project: projectOption,
  released: releasedOption,
  unreleased: unreleasedOption,
  customFields: customFieldOption,
  max: maxOption,
  json: jsonOption,
  emails: emailsOption
}, ({ customFields, emails, json, max, project, released, unreleased }) =>
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
      const output = emails ? versions : versions.map(stripEmails)
      yield* Console.log(JSON.stringify(output, null, 2))
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
  })).pipe(Command.withDescription("Read-only: list versions for a Jira project"))

/** Cap on the number of ticket keys listed in the human `get` output. */
const TICKET_KEYS_LIMIT = 20

const getCommand = Command.make(
  "get",
  { id: idArg, json: jsonOption, emails: emailsOption },
  ({ emails, id, json }) =>
    Effect.gen(function*() {
      yield* ensureNumericId(id)
      const service = yield* VersionService
      const version = yield* service.getVersion(id)
      if (json) {
        const output = emails ? version : stripEmails(version)
        yield* Console.log(JSON.stringify(output, null, 2))
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
      yield* Console.log(`tickets (${version.tickets.length}): ${formatTicketKeys(version.tickets)}`)
    })
).pipe(Command.withDescription("Read-only: get a single Jira version"))

/**
 * Render a version's ticket keys for the human `get`: the first
 * {@link TICKET_KEYS_LIMIT} keys, with a `(+M more)` suffix when truncated, or
 * `-` when there are none.
 */
const formatTicketKeys = (tickets: Version["tickets"]): string => {
  if (tickets.length === 0) return "-"
  const keys = tickets.map((t) => t.key)
  const shown = keys.slice(0, TICKET_KEYS_LIMIT).join(", ")
  const remaining = keys.length - TICKET_KEYS_LIMIT
  return remaining > 0 ? `${shown} (+${remaining} more)` : shown
}

const descriptionOption = Options.string("description").pipe(
  Options.withAlias("d"),
  Options.withDescription("New version description")
)

const updateCommand = Command.make("update", { id: idArg, description: descriptionOption, json: jsonOption }, ({
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
    Command.withDescription("Remote write: update a version's description (requires manage:jira-project scope)")
  )

// === related-work ===

const titleOption = Options.string("title").pipe(
  Options.withAlias("t"),
  Options.withDescription("Related-work link title (e.g. \"Release notes\")")
)
const urlOption = Options.string("url").pipe(
  Options.withAlias("u"),
  Options.withDescription("Related-work link URL (e.g. a Confluence page)")
)
const categoryOption = Options.string("category").pipe(
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
).pipe(Command.withDescription("Read-only: list a version's related-work links"))

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
      "Remote write: attach a related-work link (e.g. a Confluence page) to a version (requires manage:jira-project scope)"
    )
  )

const relatedWorkCommand = Command.make("related-work").pipe(
  Command.withDescription("List or attach version related-work links (Confluence pages on the release report)"),
  Command.withSubcommands([relatedWorkListCommand, relatedWorkAddCommand])
)

export const versionCommand = Command.make("version").pipe(
  Command.withDescription("Jira version commands"),
  Command.withSubcommands([listCommand, getCommand, updateCommand, relatedWorkCommand])
)

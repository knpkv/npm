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
import { planRelatedWorkSync, VersionService } from "../VersionService.js"

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
      ...((Option.isSome(max)) && { maxResults: max.value }),
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

// === create ===

/**
 * Jira accepts version dates only as ISO 8601 `yyyy-mm-dd`. Anything else — a
 * locale format, a timestamp — comes back as a generic 400 that does not name the
 * offending field, so reject it locally where the message can.
 */
export const isIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  // Reject real-looking but non-existent dates (2026-02-30): round-tripping
  // through Date is the cheapest calendar check.
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const ensureIsoDate = (flag: string, value: string): Effect.Effect<void, JiraApiError> =>
  isIsoDate(value) ? Effect.void : Effect.fail(
    new JiraApiError({ message: `Invalid --${flag} "${value}". Expected an ISO 8601 date (yyyy-mm-dd).` })
  )

// No `-n` alias: it means `--dry-run` everywhere else in these CLIs, and both
// `getLayerType` implementations route on `argv.includes("-n")`. Reusing it for
// a value on a remote-write command is the wrong default.
const nameOption = Options.string("name").pipe(
  Options.withDescription("Version name (e.g. \"OOB 100\")")
)
const optionalDescriptionOption = Options.string("description").pipe(
  Options.withAlias("d"),
  Options.withDescription("Version description"),
  Options.optional
)
const startDateOption = Options.string("start-date").pipe(
  Options.withDescription("Start date, ISO 8601 (yyyy-mm-dd)"),
  Options.optional
)
const releaseDateOption = Options.string("release-date").pipe(
  Options.withDescription("Release date, ISO 8601 (yyyy-mm-dd)"),
  Options.optional
)

const createCommand = Command.make("create", {
  project: projectOption,
  name: nameOption,
  description: optionalDescriptionOption,
  startDate: startDateOption,
  releaseDate: releaseDateOption,
  json: jsonOption
}, ({ description, json, name, project, releaseDate, startDate }) =>
  Effect.gen(function*() {
    if (Option.isSome(startDate)) yield* ensureIsoDate("start-date", startDate.value)
    if (Option.isSome(releaseDate)) yield* ensureIsoDate("release-date", releaseDate.value)

    const service = yield* VersionService
    const version = yield* service.createVersion({
      projectKey: project,
      name,
      ...((Option.isSome(description)) && { description: description.value }),
      ...((Option.isSome(startDate)) && { startDate: startDate.value }),
      ...((Option.isSome(releaseDate)) && { releaseDate: releaseDate.value })
    })
    if (json) {
      yield* Console.log(JSON.stringify(version, null, 2))
      return
    }
    yield* Console.log(`Created version ${version.name} (${version.id}) on ${project}`)
    yield* Console.log(`startDate: ${version.startDate ?? "-"}`)
    yield* Console.log(`releaseDate: ${version.releaseDate ?? "-"}`)
    yield* Console.log(`description: ${version.description ?? "-"}`)
  })).pipe(
    Command.withDescription(
      "Remote write: create a new unreleased version on a project (requires manage:jira-project scope)"
    )
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

const linkOption = Options.string("link").pipe(
  Options.withAlias("l"),
  Options.withDescription("Desired link as `title=url` (repeatable). Category comes from --category."),
  Options.atLeast(0)
)

const pruneOption = Options.boolean("prune").pipe(
  Options.withDescription("Also remove links in the category that are not in the desired set")
)

/**
 * Reconcile a version's related-work links against a desired set.
 *
 * Re-running a release scaffold should not pile up duplicate "Release notes"
 * links, which is what repeated `add` calls produce. Matching is by URL, the
 * only stable identity a link has — Jira assigns the id and the title is
 * editable.
 */
const relatedWorkSyncCommand = Command.make("sync", {
  id: idArg,
  link: linkOption,
  category: categoryOption,
  prune: pruneOption,
  json: jsonOption
}, ({ category, id, json, link, prune }) =>
  Effect.gen(function*() {
    yield* ensureNumericId(id)

    const desired: Array<{ readonly title: string; readonly url: string }> = []
    for (const raw of link) {
      const separator = raw.indexOf("=")
      // Check the trimmed halves, not the separator position: `" =url"` and
      // `"title= "` both put a non-empty span either side of the `=` and would
      // otherwise reach Jira as a link with an empty title or url.
      const title = separator < 0 ? "" : raw.slice(0, separator).trim()
      const url = separator < 0 ? "" : raw.slice(separator + 1).trim()
      if (separator < 0 || title.length === 0 || url.length === 0) {
        return yield* Effect.fail(
          new JiraApiError({ message: `Invalid --link ${JSON.stringify(raw)}. Expected title=url.` })
        )
      }
      desired.push({ title, url })
    }
    if (desired.length === 0) {
      return yield* Effect.fail(new JiraApiError({ message: "Pass at least one --link title=url." }))
    }

    const service = yield* VersionService
    const existing = yield* service.listRelatedWork(id)
    const plan = planRelatedWorkSync(existing, desired, { category, prune })

    for (const item of plan.toAdd) {
      yield* service.addRelatedWork(id, { title: item.title, category, url: item.url })
    }
    for (const item of plan.toRemove) {
      yield* service.deleteRelatedWork(id, item.relatedWorkId)
    }

    const added = plan.toAdd.map((d) => d.url)
    const removed = plan.toRemove.map((d) => d.url)
    if (json) {
      yield* Console.log(JSON.stringify({ added, kept: plan.kept, removed }, null, 2))
      return
    }
    yield* Console.log(
      `Version ${id} (${category}): ${added.length} added, ${plan.kept.length} unchanged, ${removed.length} removed`
    )
    for (const url of added) yield* Console.log(`  + ${url}`)
    for (const url of removed) yield* Console.log(`  - ${url}`)
  })).pipe(
    // The help text is what a user reads before a remote write, so it has to
    // say that pruning is opt-in: without --prune nothing is ever removed, and
    // "reconcile to exactly the given set" reads as a promise that stale links
    // were cleaned up.
    Command.withDescription(
      "Remote write: add any missing related-work links in a category, matched by URL (idempotent); " +
        "pass --prune to also remove links that are not in the given set"
    )
  )

const relatedWorkCommand = Command.make("related-work").pipe(
  Command.withDescription(
    "List, attach or reconcile version related-work links (Confluence pages on the release report)"
  ),
  Command.withSubcommands([relatedWorkListCommand, relatedWorkAddCommand, relatedWorkSyncCommand])
)

export const versionCommand = Command.make("version").pipe(
  Command.withDescription("Jira version commands"),
  Command.withSubcommands([listCommand, getCommand, createCommand, updateCommand, relatedWorkCommand])
)

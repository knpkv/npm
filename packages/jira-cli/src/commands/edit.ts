/**
 * `jira issue edit <key>` command — edit an issue's list-valued fields
 * (fixVersions, labels).
 *
 * Incremental flags (`--add-*`, `--remove-*`) are the ones to reach for: both
 * fields are sets, so the replacing form silently drops anything not listed.
 *
 * @internal
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli"
import { IssueService } from "../IssueService.js"

const keyArg = Args.string("key").pipe(
  Args.withDescription("Issue key (e.g., PROJ-123)")
)

const addFixVersionOption = Options.string("add-fix-version").pipe(
  Options.withDescription("Add a fix version by name, keeping existing ones (repeatable)"),
  Options.atLeast(0)
)
const removeFixVersionOption = Options.string("remove-fix-version").pipe(
  Options.withDescription("Remove a fix version by name (repeatable)"),
  Options.atLeast(0)
)
const fixVersionOption = Options.string("fix-version").pipe(
  Options.withDescription(
    "Replace the fix versions with exactly these names (repeatable). Drops any not listed — prefer --add-fix-version"
  ),
  Options.atLeast(0)
)
const addLabelOption = Options.string("add-label").pipe(
  Options.withDescription("Add a label, keeping existing ones (repeatable)"),
  Options.atLeast(0)
)
const removeLabelOption = Options.string("remove-label").pipe(
  Options.withDescription("Remove a label (repeatable)"),
  Options.atLeast(0)
)
const labelOption = Options.string("label").pipe(
  Options.withDescription(
    "Replace the labels with exactly these (repeatable). Drops any not listed — prefer --add-label"
  ),
  Options.atLeast(0)
)
const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output as JSON"),
  Options.withDefault(false)
)

export const editCommand = Command.make(
  "edit",
  {
    key: keyArg,
    addFixVersion: addFixVersionOption,
    removeFixVersion: removeFixVersionOption,
    fixVersion: fixVersionOption,
    addLabel: addLabelOption,
    removeLabel: removeLabelOption,
    label: labelOption,
    json: jsonOption
  },
  ({ addFixVersion, addLabel, fixVersion, json, key, label, removeFixVersion, removeLabel }) =>
    Effect.gen(function*() {
      const issueService = yield* IssueService
      const issue = yield* issueService.edit(key, {
        addFixVersions: addFixVersion,
        removeFixVersions: removeFixVersion,
        setFixVersions: fixVersion,
        addLabels: addLabel,
        removeLabels: removeLabel,
        setLabels: label
      })

      if (json) {
        yield* Console.log(JSON.stringify(issue, null, 2))
        return
      }
      yield* Console.log(`Updated ${issue.key}`)
      yield* Console.log(`fixVersions: ${issue.fixVersions.join(", ") || "-"}`)
      yield* Console.log(`labels: ${issue.labels.join(", ") || "-"}`)
    })
).pipe(
  Command.withDescription(
    "Remote write: edit an issue's fix versions and labels (requires write:jira-work scope)"
  )
)

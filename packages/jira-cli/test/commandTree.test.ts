import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Terminal from "effect/Terminal"
import { Command } from "effect/unstable/cli"
import { AttachmentService } from "../src/AttachmentService.js"
import { issueCommand } from "../src/commands/issue.js"
import { versionCommand } from "../src/commands/version.js"
import { type Issue, IssueService } from "../src/IssueService.js"
import { MarkdownWriter } from "../src/MarkdownWriter.js"
import { type RelatedWork, type Version, VersionService } from "../src/VersionService.js"

interface CommandCalls {
  readonly issueGet: number
  readonly issueSearch: number
  readonly issueAttachmentUpload: number
  readonly versionList: number
  readonly versionGet: number
  readonly versionUpdate: number
  readonly relatedWorkList: number
  readonly relatedWorkAdd: number
  readonly writeMulti: number
}

const emptyCalls: CommandCalls = {
  issueGet: 0,
  issueAttachmentUpload: 0,
  issueSearch: 0,
  relatedWorkAdd: 0,
  relatedWorkList: 0,
  versionGet: 0,
  versionList: 0,
  versionUpdate: 0,
  writeMulti: 0
}

const sampleIssue: Issue = {
  assignee: null,
  attachments: [],
  comments: [],
  components: [],
  created: new Date("2026-01-01T00:00:00.000Z"),
  description: "",
  fixVersions: [],
  id: "10000",
  key: "PROJ-123",
  labels: [],
  priority: null,
  reporter: null,
  status: "Done",
  summary: "Sample issue",
  type: "Task",
  updated: new Date("2026-01-01T00:00:00.000Z"),
  url: "https://example.atlassian.net/browse/PROJ-123"
}

const sampleAttachment = {
  id: "30001",
  filename: "evidence.png",
  url: "https://example.atlassian.net/rest/api/3/attachment/content/30001",
  mediaType: "image/png",
  mimeType: "image/png",
  size: 123
}

const sampleVersion: Version = {
  approvers: [],
  archived: false,
  contributors: [],
  description: null,
  driver: null,
  id: "10042",
  name: "1.0.0",
  releaseDate: null,
  released: false,
  startDate: null,
  tickets: [],
  url: "https://example.atlassian.net/projects/PROJ/versions/10042"
}

const sampleRelatedWork: RelatedWork = {
  category: "Communication",
  relatedWorkId: "20000",
  title: "Release notes",
  url: "https://example.atlassian.net/wiki/spaces/PROJ/pages/123"
}

const CaptureTerminalLayer = (stdout: Ref.Ref<string>) =>
  Layer.succeed(
    Terminal.Terminal,
    Terminal.Terminal.of({
      columns: Effect.succeed(100),
      rows: Effect.succeed(24),
      readInput: Effect.die("readInput should not be called"),
      readLine: Effect.die("readLine should not be called"),
      display: (text) => Ref.update(stdout, (output) => output + text)
    })
  )

const CommandServicesLayer = (calls: Ref.Ref<CommandCalls>) =>
  Layer.mergeAll(
    Layer.succeed(
      AttachmentService,
      AttachmentService.of({
        uploadToIssue: () =>
          Ref.update(calls, (state) => ({
            ...state,
            issueAttachmentUpload: state.issueAttachmentUpload + 1
          })).pipe(Effect.as(sampleAttachment))
      })
    ),
    Layer.succeed(
      IssueService,
      IssueService.of({
        getByKey: () =>
          Ref.update(calls, (state) => ({ ...state, issueGet: state.issueGet + 1 })).pipe(
            Effect.as(sampleIssue)
          ),
        search: () => Effect.die("IssueService.search should not be called"),
        searchAll: () =>
          Ref.update(calls, (state) => ({ ...state, issueSearch: state.issueSearch + 1 })).pipe(
            Effect.as([sampleIssue])
          )
      })
    ),
    Layer.succeed(
      MarkdownWriter,
      MarkdownWriter.of({
        writeMulti: () => Ref.update(calls, (state) => ({ ...state, writeMulti: state.writeMulti + 1 })),
        writeSingle: () => Effect.die("MarkdownWriter.writeSingle should not be called")
      })
    ),
    Layer.succeed(
      VersionService,
      VersionService.of({
        addRelatedWork: () =>
          Ref.update(calls, (state) => ({ ...state, relatedWorkAdd: state.relatedWorkAdd + 1 })).pipe(
            Effect.as(sampleRelatedWork)
          ),
        getVersion: () =>
          Ref.update(calls, (state) => ({ ...state, versionGet: state.versionGet + 1 })).pipe(
            Effect.as(sampleVersion)
          ),
        listProjectVersions: () =>
          Ref.update(calls, (state) => ({ ...state, versionList: state.versionList + 1 })).pipe(
            Effect.as([sampleVersion])
          ),
        listRelatedWork: () =>
          Ref.update(calls, (state) => ({ ...state, relatedWorkList: state.relatedWorkList + 1 })).pipe(
            Effect.as([sampleRelatedWork])
          ),
        updateVersion: () =>
          Ref.update(calls, (state) => ({ ...state, versionUpdate: state.versionUpdate + 1 })).pipe(
            Effect.as(sampleVersion)
          )
      })
    )
  )

const runJiraCommand = (
  args: ReadonlyArray<string>,
  calls: Ref.Ref<CommandCalls>,
  stdout: Ref.Ref<string>
) => {
  const command = Command.make("jira").pipe(
    Command.withDescription("Jira CLI commands"),
    Command.withSubcommands([issueCommand, versionCommand])
  )
  const cli = Command.runWith(command, { version: "0.0.0-test" })
  return cli(args).pipe(
    Effect.provide(Layer.merge(CommandServicesLayer(calls), CaptureTerminalLayer(stdout))),
    Effect.exit
  )
}

describe("Jira command tree", () => {
  it.effect("exposes canonical issue commands and removes top-level issue aliases", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(emptyCalls)
      const getOutput = yield* Ref.make("")
      const searchOutput = yield* Ref.make("")
      const uploadOutput = yield* Ref.make("")
      const legacyGetOutput = yield* Ref.make("")
      const legacySearchOutput = yield* Ref.make("")

      const getExit = yield* runJiraCommand(["issue", "get", "PROJ-123"], calls, getOutput)
      const searchExit = yield* runJiraCommand(["issue", "search", "project = PROJ"], calls, searchOutput)
      const uploadExit = yield* runJiraCommand(
        [
          "issue",
          "attachment",
          "upload",
          "PROJ-123",
          "./evidence.png",
          "--no-insert"
        ],
        calls,
        uploadOutput
      )
      const legacyGetExit = yield* runJiraCommand(["get", "PROJ-123"], calls, legacyGetOutput)
      const legacySearchExit = yield* runJiraCommand(["search", "project = PROJ"], calls, legacySearchOutput)

      expect(getExit._tag).toBe("Success")
      expect(searchExit._tag).toBe("Success")
      expect(uploadExit._tag).toBe("Success")
      expect(legacyGetExit._tag).toBe("Failure")
      expect(legacySearchExit._tag).toBe("Failure")

      expect(yield* Ref.get(calls)).toMatchObject({
        issueGet: 1,
        issueAttachmentUpload: 1,
        issueSearch: 1,
        writeMulti: 2
      })
      expect(sampleAttachment.mimeType).toBe(sampleAttachment.mediaType)
    }))

  it.effect("exposes canonical version commands and rejects legacy names", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(emptyCalls)
      const output = yield* Ref.make("")
      const legacyViewOutput = yield* Ref.make("")
      const legacySetOutput = yield* Ref.make("")
      const legacyRelatedWorkOutput = yield* Ref.make("")

      const listExit = yield* runJiraCommand(["version", "list", "--project", "PROJ"], calls, output)
      const getExit = yield* runJiraCommand(["version", "get", "10042"], calls, output)
      const updateExit = yield* runJiraCommand(
        [
          "version",
          "update",
          "10042",
          "--description",
          "Q3 release"
        ],
        calls,
        output
      )
      const relatedWorkListExit = yield* runJiraCommand(
        [
          "version",
          "related-work",
          "list",
          "10042"
        ],
        calls,
        output
      )
      const relatedWorkAddExit = yield* runJiraCommand(
        [
          "version",
          "related-work",
          "add",
          "10042",
          "--title",
          "Release notes",
          "--url",
          "https://example.atlassian.net/wiki/spaces/PROJ/pages/123"
        ],
        calls,
        output
      )
      const legacyViewExit = yield* runJiraCommand(["version", "view", "10042"], calls, legacyViewOutput)
      const legacySetExit = yield* runJiraCommand(
        [
          "version",
          "set",
          "10042",
          "--description",
          "Q3 release"
        ],
        calls,
        legacySetOutput
      )
      const legacyRelatedWorkExit = yield* runJiraCommand(
        [
          "version",
          "relatedwork",
          "list",
          "10042"
        ],
        calls,
        legacyRelatedWorkOutput
      )

      expect(listExit._tag).toBe("Success")
      expect(getExit._tag).toBe("Success")
      expect(updateExit._tag).toBe("Success")
      expect(relatedWorkListExit._tag).toBe("Success")
      expect(relatedWorkAddExit._tag).toBe("Success")
      expect(legacyViewExit._tag).toBe("Failure")
      expect(legacySetExit._tag).toBe("Failure")
      expect(legacyRelatedWorkExit._tag).toBe("Failure")

      expect(yield* Ref.get(calls)).toMatchObject({
        relatedWorkAdd: 1,
        relatedWorkList: 1,
        versionGet: 1,
        versionList: 1,
        versionUpdate: 1
      })
    }))
})

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Terminal from "effect/Terminal"
import { Command } from "effect/unstable/cli"
import type { PageId } from "../src/Brand.js"
import type { ConfluenceCommandOptions } from "../src/commands/root.js"
import { makeConfluenceCommand } from "../src/commands/root.js"
import { ConfluenceAuth } from "../src/ConfluenceAuth.js"
import { ConfluenceClient } from "../src/ConfluenceClient.js"
import { layerFromValues as ConfluenceConfigLayerFromValues } from "../src/ConfluenceConfig.js"
import { GitService } from "../src/GitService.js"
import { MarkdownConverter } from "../src/MarkdownConverter.js"
import { SyncEngine } from "../src/SyncEngine.js"

const notCalled = (calls: Ref.Ref<number>) =>
  Ref.update(calls, (count) => count + 1).pipe(
    Effect.flatMap(() => Effect.die("GitService should not be called"))
  )

export const GitShouldNotBeCalledLayer = (calls: Ref.Ref<number>) =>
  Layer.succeed(
    GitService,
    GitService.of({
      validateGit: () => notCalled(calls),
      init: () => notCalled(calls),
      isInitialized: () => notCalled(calls),
      status: () => notCalled(calls),
      commit: () => notCalled(calls),
      log: () => notCalled(calls),
      diff: () => notCalled(calls),
      addAll: () => notCalled(calls),
      hasConflicts: () => notCalled(calls),
      mergeContinue: () => notCalled(calls),
      syncFromDocs: () => notCalled(calls),
      syncToDocs: () => notCalled(calls),
      getHead: () => notCalled(calls),
      getCurrentBranch: () => notCalled(calls),
      createBranch: () => notCalled(calls),
      checkout: () => notCalled(calls),
      reset: () => notCalled(calls),
      deleteBranch: () => notCalled(calls),
      getParent: () => notCalled(calls),
      cherryPick: () => notCalled(calls),
      getChangedFiles: () => notCalled(calls),
      showFile: () => notCalled(calls),
      amend: () => notCalled(calls),
      logRange: () => notCalled(calls),
      branchExists: () => notCalled(calls),
      updateBranch: () => notCalled(calls),
      merge: () => notCalled(calls),
      getDeletedFiles: () => notCalled(calls),
      getFileContentAt: () => notCalled(calls)
    })
  )

export interface CommandHarnessRefs {
  readonly gitCalls: Ref.Ref<number>
  readonly stdout: Ref.Ref<string>
}

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

const SyncEngineLayer = Layer.succeed(
  SyncEngine,
  SyncEngine.of({
    pull: () => Effect.die("SyncEngine should not be called"),
    push: () => Effect.die("SyncEngine should not be called"),
    status: () => Effect.die("SyncEngine should not be called")
  })
)

const MarkdownConverterLayer = Layer.succeed(
  MarkdownConverter,
  MarkdownConverter.of({
    adfToMarkdown: () => Effect.succeed("# Harness Page\n"),
    markdownToAdf: () => Effect.die("markdownToAdf should not be called")
  })
)

const DummyConfluenceClientLayer = Layer.succeed(
  ConfluenceClient,
  ConfluenceClient.of({
    getPage: () => Effect.die("Use an injected fetch client layer in command tests"),
    getChildren: () => Effect.die("ConfluenceClient should not be called"),
    getAllChildren: () => Effect.die("ConfluenceClient should not be called"),
    createPage: () => Effect.die("ConfluenceClient should not be called"),
    updatePage: () => Effect.die("ConfluenceClient should not be called"),
    deletePage: () => Effect.die("ConfluenceClient should not be called"),
    getPageVersions: () => Effect.die("ConfluenceClient should not be called"),
    getUser: () => Effect.die("ConfluenceClient should not be called"),
    getSpaceId: () => Effect.die("ConfluenceClient should not be called"),
    setEditorVersion: () => Effect.die("ConfluenceClient should not be called")
  })
)

const ConfigLayer = ConfluenceConfigLayerFromValues({
  rootPageId: "dummy" as PageId,
  baseUrl: "https://dummy.atlassian.net",
  docsPath: ".confluence/docs",
  excludePatterns: [],
  saveSource: false,
  trackedPaths: ["**/*.md"]
})

export const CommandHarnessLayer = (refs: CommandHarnessRefs) =>
  Layer.mergeAll(
    AuthLayer,
    GitShouldNotBeCalledLayer(refs.gitCalls),
    SyncEngineLayer,
    MarkdownConverterLayer,
    DummyConfluenceClientLayer,
    ConfigLayer,
    CaptureTerminalLayer(refs.stdout)
  )

export const runConfluenceCommand = (
  args: ReadonlyArray<string>,
  options: ConfluenceCommandOptions = {}
) => {
  const cli = Command.runWith(makeConfluenceCommand(options), { version: "0.0.0-test" })
  return cli(args).pipe(Effect.exit)
}

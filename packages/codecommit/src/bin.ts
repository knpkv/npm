#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { NodeHttpClient } from "@effect/platform-node"
import { makeInstallCommand } from "@knpkv/agent-skills"
import { AwsClient, AwsClientConfig, CacheService, ConfigService, type Domain } from "@knpkv/codecommit-core"
import type { AwsProfileName, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { makeServer } from "@knpkv/codecommit-web"
import { Console, Effect, Layer, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Stdio from "effect/Stdio"
import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import pkg from "../package.json"
import { FILTER_PRESETS, matchesRepoAuthor } from "./filterPresets.js"
import { FilterService, FilterServiceLive } from "./FilterService.js"

// TUI Command
const launchTui = Effect.gen(function*() {
  const { default: program } = yield* Effect.promise(() => import("./main.js"))
  yield* program
})

const tui = Command.make("tui", {}, () => launchTui)

// Web Command
const web = Command.make("web", {
  port: Options.integer("port").pipe(Options.withDefault(3000)),
  hostname: Options.string("hostname").pipe(Options.withDefault("127.0.0.1"))
}, ({ hostname, port }) =>
  Effect.gen(function*() {
    yield* Effect.logInfo(`Starting web server at http://${hostname}:${port}`)

    // Open browser
    const url = `http://${hostname}:${port}`
    const exitCode = (command: ChildProcess.Command) =>
      Effect.scoped(command.pipe(Effect.flatMap((handle) => handle.exitCode)))
    yield* exitCode(ChildProcess.make("open", [url])).pipe(
      Effect.catchIf(() => true, () => exitCode(ChildProcess.make("xdg-open", [url]))),
      Effect.catchIf(
        () => true,
        () => exitCode(ChildProcess.make("rundll32.exe", ["url.dll,FileProtocolHandler", url]))
      ),
      Effect.catchIf(() => true, () => Effect.void)
    )

    // Run server with configured port/hostname
    return yield* Layer.launch(makeServer({ port, hostname }))
  }))

// PR Create Command
const prCreate = Command.make("create", {
  repo: Args.string("repository").pipe(Args.withDescription("Repository name")),
  title: Args.string("title").pipe(Args.withDescription("PR title")),
  source: Options.string("source").pipe(
    Options.withAlias("s"),
    Options.withDescription("Source branch")
  ),
  destination: Options.string("destination").pipe(
    Options.withAlias("d"),
    Options.withDescription("Destination branch"),
    Options.withDefault("main")
  ),
  description: Options.string("description").pipe(
    Options.withDescription("PR description"),
    Options.optional
  ),
  profile: Options.string("profile").pipe(
    Options.withAlias("p"),
    Options.withDescription("AWS profile"),
    Options.withDefault("default")
  ),
  region: Options.string("region").pipe(
    Options.withAlias("r"),
    Options.withDescription("AWS region"),
    Options.withDefault("us-east-1")
  )
}, ({ description, destination, profile, region, repo, source, title }) =>
  Effect.gen(function*() {
    const aws = yield* AwsClient.AwsClient
    yield* Console.log(`Creating PR: ${source} -> ${destination} in ${repo}`)

    const prId = yield* aws.createPullRequest({
      account: { profile: profile as AwsProfileName, region: region as AwsRegion },
      repositoryName: repo,
      title,
      ...(description._tag === "Some" && { description: description.value }),
      sourceReference: source,
      destinationReference: destination
    })

    const link =
      `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${repo}/pull-requests/${prId}?region=${region}`
    yield* Console.log(`Created PR: ${prId}`)
    yield* Console.log(link)
  }).pipe(
    Effect.provide(Layer.merge(AwsClient.AwsClientLive, NodeHttpClient.layerFetch))
  )).pipe(Command.withDescription("Create a pull request"))

// Filter presets (FILTER_PRESETS, matchesPreset, matchesRepoAuthor) live in
// ./filterPresets.ts — a side-effect-free module so they can be unit-tested
// without importing this CLI entrypoint (which boots the TUI/Bun runtime).

// PR List Command
const prList = Command.make("list", {
  profile: Options.string("profile").pipe(
    Options.withAlias("p"),
    Options.withDescription("AWS profile (ignored when --filter is set — presets fan out across all enabled accounts)"),
    Options.withDefault("default")
  ),
  region: Options.string("region").pipe(
    Options.withAlias("r"),
    Options.withDescription("AWS region (ignored when --filter is set — presets fan out across all enabled accounts)"),
    Options.withDefault("us-east-1")
  ),
  status: Options.choice("status", ["OPEN", "CLOSED"]).pipe(
    Options.withAlias("s"),
    Options.withDescription("Filter by PR status (ignored when --filter is set — presets are OPEN-only)"),
    Options.withDefault("OPEN" as const)
  ),
  all: Options.boolean("all").pipe(
    Options.withAlias("a"),
    Options.withDescription(
      "Show all PRs (both OPEN and CLOSED; ignored when --filter is set — presets are OPEN-only)"
    ),
    Options.withDefault(false)
  ),
  repo: Options.string("repo").pipe(
    Options.withDescription("Filter by repository name"),
    Options.optional
  ),
  author: Options.string("author").pipe(
    Options.withDescription("Filter by author"),
    Options.optional
  ),
  filter: Options.choice("filter", FILTER_PRESETS).pipe(
    Options.withDescription(
      "Named preset (fans out across all enabled accounts, OPEN PRs only — ignores --status/--all): " +
        "mine | needs-my-review | stale | conflicting"
    ),
    Options.optional
  ),
  json: Options.boolean("json").pipe(
    Options.withDescription("Output as JSON"),
    Options.withDefault(false)
  )
}, ({ all, author, filter, json, profile, region, repo, status }) =>
  Effect.gen(function*() {
    const aws = yield* AwsClient.AwsClient

    // ── Filter-preset path: fan out across all enabled accounts ──────────────
    if (filter._tag === "Some") {
      const preset = filter.value
      const fs = yield* FilterService
      const targets = yield* fs.resolveTargets

      if (targets.length === 0) {
        yield* Console.log("No enabled accounts in ~/.codecommit/config.json. Enable some with `codecommit tui`.")
        return
      }

      // Progress/status text goes to stderr so `--json` emits only the JSON document on stdout.
      if (!json) yield* Console.error(`Scanning ${targets.length} account(s) with filter '${preset}'...`)

      const { failures, prs, unresolvedProfiles } = yield* fs.collect(preset, targets, { repo, author })
      const unresolvedCallerProfiles = unresolvedProfiles

      // Warn (on stderr, so `--json` stdout stays clean) when caller identity
      // couldn't be resolved for an identity-comparing preset — those accounts'
      // results may be incomplete because no PR can match an unknown "me".
      const reportWarnings = Effect.gen(function*() {
        for (const p of unresolvedCallerProfiles) {
          yield* Console.error(
            `⚠ could not resolve caller identity for profile ${p}; '${preset}' results for it may be incomplete`
          )
        }
        if (failures.length > 0) {
          yield* Console.error(`\n⚠ ${failures.length} account(s) failed:`)
          for (const f of failures) yield* Console.error(`  ${f}`)
        }
      })

      if (prs.length === 0) {
        if (json) yield* Console.log("[]")
        else yield* Console.error(`No PRs match filter '${preset}'.`)
        yield* reportWarnings
        return
      }

      if (json) {
        yield* Console.log(JSON.stringify(prs, null, 2))
      } else {
        yield* Console.log(`\nFound ${prs.length} PR(s) matching filter '${preset}':\n`)
        for (const pr of prs) {
          const flags = [
            pr.isApproved ? "approved" : "",
            pr.isMergeable ? "mergeable" : "conflicts"
          ].filter(Boolean).join(" ")
          yield* Console.log(`${pr.id}  ${pr.repositoryName}  [${pr.account.profile}/${pr.account.region}]`)
          yield* Console.log(`    ${pr.title}`)
          yield* Console.log(`    ${pr.sourceBranch} -> ${pr.destinationBranch}`)
          yield* Console.log(`    by ${pr.author}  ${flags}`)
          yield* Console.log("")
        }
      }
      yield* reportWarnings
      return
    }

    // ── Single-account path (original behaviour) ─────────────────────────────
    const account = { profile: profile as AwsProfileName, region: region as AwsRegion }

    const statusLabel = all ? "all" : status.toLowerCase()
    yield* Console.log(`Fetching ${statusLabel} PRs...`)

    const filterPRs = (prStream: Stream.Stream<Domain.PullRequest, AwsClient.AwsClientError>) =>
      prStream.pipe(
        Stream.filter((pr) => matchesRepoAuthor(pr, repo, author)),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk))
      )

    let prs: Array<Domain.PullRequest>
    if (all) {
      const [openPrs, closedPrs] = yield* Effect.all([
        filterPRs(aws.getPullRequests(account, { status: "OPEN" })),
        filterPRs(aws.getPullRequests(account, { status: "CLOSED" }))
      ])
      prs = [...openPrs, ...closedPrs].sort((a, b) => b.lastModifiedDate.getTime() - a.lastModifiedDate.getTime())
    } else {
      prs = yield* filterPRs(aws.getPullRequests(account, { status }))
    }

    if (prs.length === 0) {
      yield* Console.log(`No ${statusLabel} PRs found.`)
      return
    }

    if (json) {
      yield* Console.log(JSON.stringify(prs, null, 2))
    } else {
      yield* Console.log(`\nFound ${prs.length} ${statusLabel} PR(s):\n`)
      for (const pr of prs) {
        const prStatus = all ? `[${pr.status}] ` : ""
        const flags = [
          pr.isApproved ? "approved" : "",
          pr.isMergeable ? "mergeable" : "conflicts"
        ].filter(Boolean).join(" ")
        yield* Console.log(`${pr.id}  ${prStatus}${pr.repositoryName}`)
        yield* Console.log(`    ${pr.title}`)
        yield* Console.log(`    ${pr.sourceBranch} -> ${pr.destinationBranch}`)
        yield* Console.log(`    by ${pr.author}  ${flags}`)
        yield* Console.log("")
      }
    }
  }).pipe(
    Effect.provide(
      // FilterService draws AwsClient/ConfigService from the base layers, which
      // are also merged into the output so the single-account path keeps them.
      FilterServiceLive.pipe(
        Layer.provideMerge(Layer.mergeAll(
          AwsClient.AwsClientLive,
          NodeHttpClient.layerFetch,
          ConfigService.ConfigServiceLive.pipe(Layer.provide(CacheService.EventsHub.Default))
        ))
      )
    )
  )).pipe(Command.withDescription("List pull requests (use --filter for cross-account presets)"))

// Helper to render comment threads as markdown
const renderThread = (thread: Domain.CommentThread, indent: number = 0): string => {
  const prefix = "  ".repeat(indent)
  const c = thread.root
  const header = c.deleted
    ? `${prefix}- ~~[deleted]~~ _${c.author}_ (${c.creationDate.toISOString()})`
    : `${prefix}- **${c.author}** (${c.creationDate.toISOString()})`
  const content = c.deleted ? "" : `\n${prefix}  ${c.content.replace(/\n/g, `\n${prefix}  `)}`
  const replies = thread.replies.map((r) => renderThread(r, indent + 1)).join("\n")
  return `${header}${content}${replies ? `\n${replies}` : ""}`
}

const renderLocation = (loc: Domain.PRCommentLocation): string => {
  const header = loc.filePath ? `### ${loc.filePath}\n` : "### General comments\n"
  const threads = loc.comments.map((t) => renderThread(t)).join("\n\n")
  return `${header}\n${threads}`
}

// PR Export Command
const prExport = Command.make("export", {
  prId: Args.string("pr-id").pipe(Args.withDescription("Pull request ID")),
  repo: Args.string("repository").pipe(Args.withDescription("Repository name")),
  output: Options.file("output").pipe(
    Options.withAlias("o"),
    Options.withDescription("Output file path"),
    Options.optional
  ),
  profile: Options.string("profile").pipe(
    Options.withAlias("p"),
    Options.withDescription("AWS profile"),
    Options.withDefault("default")
  ),
  region: Options.string("region").pipe(
    Options.withAlias("r"),
    Options.withDescription("AWS region"),
    Options.withDefault("us-east-1")
  )
}, ({ output, prId, profile, region, repo }) =>
  Effect.gen(function*() {
    const aws = yield* AwsClient.AwsClient
    const fs = yield* FileSystem.FileSystem
    const account = { profile: profile as AwsProfileName, region: region as AwsRegion }

    yield* Console.log(`Fetching PR ${prId}...`)

    const pr = yield* aws.getPullRequest({ account, pullRequestId: prId })

    yield* Console.log(`Fetching comments...`)

    const locations = yield* aws.getCommentsForPullRequest({
      account,
      pullRequestId: prId,
      repositoryName: repo
    })

    const totalComments = locations.reduce((sum, loc) => {
      const countThreads = (threads: ReadonlyArray<Domain.CommentThread>): number =>
        threads.reduce((s, t) => s + 1 + countThreads(t.replies), 0)
      return sum + countThreads(loc.comments)
    }, 0)

    yield* Console.log(`Found ${totalComments} comment(s) in ${locations.length} location(s)`)

    const link =
      `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${repo}/pull-requests/${prId}?region=${region}`
    const markdown = [
      `# ${pr.title}`,
      "",
      `**Repository:** ${repo}`,
      `**Branch:** ${pr.sourceBranch} -> ${pr.destinationBranch}`,
      `**Author:** ${pr.author}`,
      `**Status:** ${pr.status}`,
      `**AWS Account:** ${profile}`,
      `**Link:** ${link}`,
      "",
      ...(pr.description ? ["## Description", "", pr.description, ""] : []),
      "## Comments",
      "",
      ...(locations.length > 0 ? locations.map(renderLocation) : ["_No comments_"])
    ].join("\n")

    if (output._tag === "Some") {
      yield* fs.writeFileString(output.value, markdown)
      yield* Console.log(`Saved to ${output.value}`)
    } else {
      yield* Console.log("")
      yield* Console.log(markdown)
    }
  }).pipe(
    Effect.provide(Layer.merge(AwsClient.AwsClientLive, NodeHttpClient.layerFetch))
  )).pipe(Command.withDescription("Export PR comments as markdown"))

// PR Update Command
const prUpdate = Command.make("update", {
  prId: Args.string("pr-id").pipe(Args.withDescription("Pull request ID")),
  title: Options.string("title").pipe(
    Options.withAlias("t"),
    Options.withDescription("New PR title"),
    Options.optional
  ),
  description: Options.string("description").pipe(
    Options.withAlias("d"),
    Options.withDescription("New PR description"),
    Options.optional
  ),
  profile: Options.string("profile").pipe(
    Options.withAlias("p"),
    Options.withDescription("AWS profile"),
    Options.withDefault("default")
  ),
  region: Options.string("region").pipe(
    Options.withAlias("r"),
    Options.withDescription("AWS region"),
    Options.withDefault("us-east-1")
  )
}, ({ description, prId, profile, region, title }) =>
  Effect.gen(function*() {
    const aws = yield* AwsClient.AwsClient
    const account = { profile: profile as AwsProfileName, region: region as AwsRegion }

    if (title._tag === "None" && description._tag === "None") {
      yield* Console.log("Error: At least one of --title or --description must be provided")
      return
    }

    if (title._tag === "Some") {
      yield* Console.log(`Updating title...`)
      yield* aws.updatePullRequestTitle({ account, pullRequestId: prId, title: title.value })
    }

    if (description._tag === "Some") {
      yield* Console.log(`Updating description...`)
      yield* aws.updatePullRequestDescription({ account, pullRequestId: prId, description: description.value })
    }

    yield* Console.log(`Updated PR ${prId}`)
  }).pipe(
    Effect.provide(Layer.merge(AwsClient.AwsClientLive, NodeHttpClient.layerFetch))
  )).pipe(Command.withDescription("Update PR title or description"))

// PR Command (parent)
const pr = Command.make("pr", {}, () => Console.log("Usage: codecommit pr <command>")).pipe(
  Command.withSubcommands([prList, prCreate, prExport, prUpdate]),
  Command.withDescription("Pull request commands")
)

const skillsInstall = makeInstallCommand({
  description: "Install the CodeCommit agent skill",
  name: "install",
  skills: ["codecommit"]
})

const skills = Command.make("skills", {}, () => Console.log("Usage: codecommit skills install")).pipe(
  Command.withSubcommands([skillsInstall]),
  Command.withDescription("Agent skill commands")
)

const command = Command.make("codecommit", {}, () =>
  // Default to TUI if no subcommand
  launchTui).pipe(
    Command.withSubcommands([tui, web, pr, skills])
  )

const cli = Command.runWith(command, {
  version: pkg.version
})

const AppRuntimeLayer = Layer.mergeAll(NodeHttpClient.layerFetch, AwsClientConfig.Default)

const needsAppRuntime = (args: ReadonlyArray<string>): boolean => args[0] !== "skills"

const program = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  const runCli = needsAppRuntime(args) ? cli(args).pipe(Effect.provide(AppRuntimeLayer)) : cli(args)
  return yield* runCli
})

BunRuntime.runMain(Effect.provide(program, BunServices.layer))

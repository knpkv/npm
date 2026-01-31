#!/usr/bin/env bun
import { Args, Command, Options } from "@effect/cli"
import { FileSystem } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { NodeHttpClient } from "@effect/platform-node"
import { Console, Effect, Layer } from "effect"
import open from "open"
import { makeServer } from "@knpkv/codecommit-web"
import { AwsClient, AwsClientLive, type CommentThread, type PRCommentLocation } from "@knpkv/codecommit-core"

// TUI Command
const tui = Command.make("tui", {}, () =>
  Effect.gen(function* () {
    yield* Effect.promise(() => import("./main.js"))
  })
)

// Web Command
const web = Command.make("web", {
  port: Options.integer("port").pipe(Options.withDefault(3000)),
  hostname: Options.text("hostname").pipe(Options.withDefault("127.0.0.1"))
}, ({ port, hostname }) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`Starting web server at http://${hostname}:${port}`)

    // Open browser
    yield* Effect.promise(() => open(`http://${hostname}:${port}`))

    // Run server with configured port/hostname
    return yield* Layer.launch(makeServer({ port, hostname }))
  })
)

// PR Create Command
const prCreate = Command.make("create", {
  repo: Args.text({ name: "repository" }).pipe(Args.withDescription("Repository name")),
  title: Args.text({ name: "title" }).pipe(Args.withDescription("PR title")),
  source: Options.text("source").pipe(
    Options.withAlias("s"),
    Options.withDescription("Source branch")
  ),
  destination: Options.text("destination").pipe(
    Options.withAlias("d"),
    Options.withDescription("Destination branch"),
    Options.withDefault("main")
  ),
  description: Options.text("description").pipe(
    Options.withDescription("PR description"),
    Options.optional
  ),
  profile: Options.text("profile").pipe(
    Options.withAlias("p"),
    Options.withDescription("AWS profile"),
    Options.withDefault("default")
  ),
  region: Options.text("region").pipe(
    Options.withAlias("r"),
    Options.withDescription("AWS region"),
    Options.withDefault("us-east-1")
  )
}, ({ repo, title, source, destination, description, profile, region }) =>
  Effect.gen(function* () {
    const aws = yield* AwsClient
    yield* Console.log(`Creating PR: ${source} -> ${destination} in ${repo}`)

    const prId = yield* aws.createPullRequest({
      account: { profile, region },
      repositoryName: repo,
      title,
      ...(description._tag === "Some" && { description: description.value }),
      sourceReference: source,
      destinationReference: destination
    })

    const link = `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${repo}/pull-requests/${prId}?region=${region}`
    yield* Console.log(`Created PR: ${prId}`)
    yield* Console.log(link)
  }).pipe(
    Effect.provide(Layer.merge(AwsClientLive, NodeHttpClient.layer))
  )
).pipe(Command.withDescription("Create a pull request"))

// Helper to render comment threads as markdown
const renderThread = (thread: CommentThread, indent: number = 0): string => {
  const prefix = "  ".repeat(indent)
  const c = thread.root
  const header = c.deleted
    ? `${prefix}- ~~[deleted]~~ _${c.author}_ (${c.creationDate.toISOString()})`
    : `${prefix}- **${c.author}** (${c.creationDate.toISOString()})`
  const content = c.deleted ? "" : `\n${prefix}  ${c.content.replace(/\n/g, `\n${prefix}  `)}`
  const replies = thread.replies.map((r) => renderThread(r, indent + 1)).join("\n")
  return `${header}${content}${replies ? `\n${replies}` : ""}`
}

const renderLocation = (loc: PRCommentLocation): string => {
  const header = loc.filePath ? `### ${loc.filePath}\n` : "### General comments\n"
  const threads = loc.comments.map((t) => renderThread(t)).join("\n\n")
  return `${header}\n${threads}`
}

// PR Export Command
const prExport = Command.make("export", {
  prId: Args.text({ name: "pr-id" }).pipe(Args.withDescription("Pull request ID")),
  repo: Args.text({ name: "repository" }).pipe(Args.withDescription("Repository name")),
  output: Options.file("output").pipe(
    Options.withAlias("o"),
    Options.withDescription("Output file path"),
    Options.optional
  ),
  profile: Options.text("profile").pipe(
    Options.withAlias("p"),
    Options.withDescription("AWS profile"),
    Options.withDefault("default")
  ),
  region: Options.text("region").pipe(
    Options.withAlias("r"),
    Options.withDescription("AWS region"),
    Options.withDefault("us-east-1")
  )
}, ({ prId, repo, output, profile, region }) =>
  Effect.gen(function* () {
    const aws = yield* AwsClient
    const fs = yield* FileSystem.FileSystem
    const account = { profile, region }

    yield* Console.log(`Fetching PR ${prId}...`)

    const pr = yield* aws.getPullRequest({ account, pullRequestId: prId })

    yield* Console.log(`Fetching comments...`)

    const locations = yield* aws.getCommentsForPullRequest({
      account,
      pullRequestId: prId,
      repositoryName: repo
    })

    const totalComments = locations.reduce((sum, loc) => {
      const countThreads = (threads: ReadonlyArray<CommentThread>): number =>
        threads.reduce((s, t) => s + 1 + countThreads(t.replies), 0)
      return sum + countThreads(loc.comments)
    }, 0)

    yield* Console.log(`Found ${totalComments} comment(s) in ${locations.length} location(s)`)

    const link = `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${repo}/pull-requests/${prId}?region=${region}`
    const markdown = [
      `# ${pr.title}`,
      "",
      `**Repository:** ${repo}`,
      `**Branch:** ${pr.sourceBranch} → ${pr.destinationBranch}`,
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
    Effect.provide(Layer.merge(AwsClientLive, NodeHttpClient.layer))
  )
).pipe(Command.withDescription("Export PR comments as markdown"))

// PR Update Command
const prUpdate = Command.make("update", {
  prId: Args.text({ name: "pr-id" }).pipe(Args.withDescription("Pull request ID")),
  title: Options.text("title").pipe(
    Options.withAlias("t"),
    Options.withDescription("New PR title"),
    Options.optional
  ),
  description: Options.text("description").pipe(
    Options.withAlias("d"),
    Options.withDescription("New PR description"),
    Options.optional
  ),
  profile: Options.text("profile").pipe(
    Options.withAlias("p"),
    Options.withDescription("AWS profile"),
    Options.withDefault("default")
  ),
  region: Options.text("region").pipe(
    Options.withAlias("r"),
    Options.withDescription("AWS region"),
    Options.withDefault("us-east-1")
  )
}, ({ prId, title, description, profile, region }) =>
  Effect.gen(function* () {
    const aws = yield* AwsClient
    const account = { profile, region }

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
    Effect.provide(Layer.merge(AwsClientLive, NodeHttpClient.layer))
  )
).pipe(Command.withDescription("Update PR title or description"))

// PR Command (parent)
const pr = Command.make("pr", {}, () =>
  Console.log("Usage: codecommit pr <command>")
).pipe(
  Command.withSubcommands([prCreate, prExport, prUpdate]),
  Command.withDescription("Pull request commands")
)

const command = Command.make("codecommit", {}, () =>
  // Default to TUI if no subcommand
  Effect.promise(() => import("./main.js"))
).pipe(
  Command.withSubcommands([tui, web, pr])
)

const cli = Command.run(command, {
  name: "codecommit",
  version: "0.0.1"
})

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(BunContext.layer),
  BunRuntime.runMain
)

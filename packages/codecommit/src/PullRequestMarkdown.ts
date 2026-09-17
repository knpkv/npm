/**
 * Rendering a pull request and its comment threads as a markdown document.
 *
 * Pure string construction, separated from `pr export` so the document shape can
 * be asserted directly instead of through a captured console. The command keeps
 * the printing; this module keeps the format.
 *
 * @category Rendering
 * @module
 */
import type { Domain } from "@knpkv/codecommit-core"

/** Renders one comment thread, indenting each level of replies beneath its parent. */
export const renderThread = (thread: Domain.CommentThread, indent: number = 0): string => {
  const prefix = "  ".repeat(indent)
  const c = thread.root
  const header = c.deleted
    ? `${prefix}- ~~[deleted]~~ _${c.author}_ (${c.creationDate.toISOString()})`
    : `${prefix}- **${c.author}** (${c.creationDate.toISOString()})`
  const content = c.deleted ? "" : `\n${prefix}  ${c.content.replace(/\n/g, `\n${prefix}  `)}`
  const replies = thread.replies.map((r) => renderThread(r, indent + 1)).join("\n")
  return `${header}${content}${replies === "" ? "" : `\n${replies}`}`
}

/** Renders one commented file, or the general-comments section when there is no path. */
export const renderLocation = (loc: Domain.PRCommentLocation): string => {
  // A location with no path is CodeCommit's general-comments bucket; an empty
  // path string means the same thing and must not produce a `### ` heading.
  const header = loc.filePath === undefined || loc.filePath === ""
    ? "### General comments\n"
    : `### ${loc.filePath}\n`
  const threads = loc.comments.map((t) => renderThread(t)).join("\n\n")
  return `${header}\n${threads}`
}

/** Counts every comment across a location's threads, replies included. */
export const countComments = (locations: ReadonlyArray<Domain.PRCommentLocation>): number =>
  locations.reduce((sum, loc) => {
    const countThreads = (threads: ReadonlyArray<Domain.CommentThread>): number =>
      threads.reduce((s, t) => s + 1 + countThreads(t.replies), 0)
    return sum + countThreads(loc.comments)
  }, 0)

/**
 * The pull request fields the document header shows.
 *
 * Structural rather than a named domain type: the single-PR fetch answers with
 * `AwsClient`'s internal transport shape, which is not exported, and the header
 * wants six strings from it either way.
 */
export interface RenderablePullRequest {
  readonly author: string
  readonly description?: string | undefined
  readonly destinationBranch: string
  readonly sourceBranch: string
  readonly status: string
  readonly title: string
}

/** Assembles the exported document: header block, optional description, then comments. */
export const renderPullRequestMarkdown = (input: {
  readonly link: string
  readonly locations: ReadonlyArray<Domain.PRCommentLocation>
  readonly profile: string
  readonly pullRequest: RenderablePullRequest
  readonly repositoryName: string
}): string =>
  [
    `# ${input.pullRequest.title}`,
    "",
    `**Repository:** ${input.repositoryName}`,
    `**Branch:** ${input.pullRequest.sourceBranch} -> ${input.pullRequest.destinationBranch}`,
    `**Author:** ${input.pullRequest.author}`,
    `**Status:** ${input.pullRequest.status}`,
    `**AWS Account:** ${input.profile}`,
    `**Link:** ${input.link}`,
    "",
    ...(input.pullRequest.description === undefined || input.pullRequest.description === ""
      ? []
      : ["## Description", "", input.pullRequest.description, ""]),
    "## Comments",
    "",
    ...(input.locations.length > 0 ? input.locations.map(renderLocation) : ["_No comments_"])
  ].join("\n")
